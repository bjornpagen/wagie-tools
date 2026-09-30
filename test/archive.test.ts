import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { ChangeSet, NativeRuntime } from "@bjornpagen/bumbledb"
import { Effect, ManagedRuntime, Result } from "effect"
import { auditLedger } from "../src/audit.ts"
import { backupLedger, restoreArchive, verifyArchive } from "../src/backup.ts"
import { retain } from "../src/core/files.ts"
import { parseCalendarDate } from "../src/core/time.ts"
import { json, mintId } from "../src/core/values.ts"
import { createHistory, latest, ledgerLayer } from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { apply, atTime } from "./native-history.ts"

const exec = promisify(execFile)

test("a backup is one .tar.xz holding the database; it verifies, restores to a working ledger, and refuses tampering", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wagie-tools-backup-"))
	const runtime = ManagedRuntime.make(NativeRuntime.layer())
	try {
		await runtime.runPromise(
			atTime(
				Date.parse("2026-09-11T17:00:00Z"),
				Effect.scoped(
					Effect.gen(function* () {
						const binding = yield* Effect.scoped(
							Effect.gen(function* () {
								const created = yield* createHistory(path.join(directory, "store"))
								const draft = yield* ChangeSet.builder(S.ledger)
								yield* draft.insert(S.Business, [
									{
										id: yield* mintId,
										name: "Synthetic archived business",
										ein: "00-0000011",
										state: "TX",
										timeZone: "America/Chicago"
									}
								])
								assert.equal((yield* apply(created.history, yield* draft.finish())).outcome.kind, "committed")
								return created.binding
							})
						)
						const bindingFile = path.join(directory, "binding.json")
						yield* retain(bindingFile, json(binding))
						const output = path.join(directory, "CURRENT.bumbledb.tar.xz")
						const capture = yield* backupLedger({ output }).pipe(
							Effect.scoped,
							Effect.provide(ledgerLayer(bindingFile))
						)
						// One file, and exactly the database inside it.
						const listed = (yield* Effect.promise(() => exec("tar", ["-tJf", output]))).stdout
							.split("\n")
							.filter((name) => name && !name.endsWith("/"))
							.map((name) => name.replace(/^\.\//, ""))
						assert.ok(listed.includes("backup.json") && listed.includes("binding.json"))
						assert.ok(listed.filter((name) => !name.startsWith("native/")).length === 2, listed.join(", "))
						// A second backup never overwrites the first.
						const again = yield* Effect.result(
							backupLedger({ output }).pipe(Effect.scoped, Effect.provide(ledgerLayer(bindingFile)))
						)
						assert.ok(Result.isFailure(again))
						assert.match(json(again.failure), /BackupOutputExists/)

						const verified = yield* verifyArchive(output)
						assert.equal(verified.factsDigest, capture.factsDigest)
						assert.equal(verified.counts.Business, 1)

						const restored = yield* restoreArchive({
							archive: output,
							directory: path.join(directory, "adopted", "store"),
							bindingOutput: path.join(directory, "adopted", "binding.json")
						})
						assert.equal(restored.factsDigest, capture.factsDigest)
						const readback = yield* Effect.gen(function* () {
							return yield* auditLedger(yield* latest, parseCalendarDate("2026-09-11"))
						}).pipe(Effect.scoped, Effect.provide(ledgerLayer(restored.binding)))
						assert.equal(readback.factsDigest, capture.factsDigest)
						// Restoring over an existing binding refuses.
						const over = yield* Effect.result(
							restoreArchive({
								archive: output,
								directory: path.join(directory, "other"),
								bindingOutput: restored.binding
							})
						)
						assert.ok(Result.isFailure(over))
						assert.match(json(over.failure), /BindingExists/)

						// Tampering with the captured digest is caught by the fact comparison.
						const corrupt = path.join(directory, "corrupt")
						yield* Effect.promise(async () => {
							await fs.mkdir(corrupt)
							await exec("tar", ["-xJf", output, "-C", corrupt])
							const manifest = JSON.parse(await fs.readFile(path.join(corrupt, "backup.json"), "utf8"))
							await fs.writeFile(
								path.join(corrupt, "backup.json"),
								json({ ...manifest, factsDigest: "0".repeat(64) })
							)
							await exec("tar", ["-cJf", path.join(directory, "corrupt.tar.xz"), "-C", corrupt, "."])
						})
						const refused = yield* Effect.result(verifyArchive(path.join(directory, "corrupt.tar.xz")))
						assert.ok(Result.isFailure(refused))
						assert.match(json(refused.failure), /RestoreFacts/)
					})
				)
			)
		)
	} finally {
		await Effect.runPromise(runtime.disposeEffect)
		await fs.rm(directory, { recursive: true, force: true })
	}
})
