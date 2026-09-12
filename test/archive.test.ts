import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, NativeRuntime } from "@bjornpagen/bumbledb"
import { Effect, ManagedRuntime, Result } from "effect"
import * as tar from "tar"
import { auditLedger } from "../src/audit.ts"
import { backupLedger, restoreArchive, verifyArchive } from "../src/backup.ts"
import { io, privateDirectory, retain } from "../src/core/files.ts"
import { parseCalendarDate } from "../src/core/time.ts"
import { json, mintId } from "../src/core/values.ts"
import { createHistory, latest, ledgerLayer } from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { apply, atTime } from "./native-history.ts"

test("packaged native backup restores facts, provenance and usable bindings; altered content refuses", async () => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "wagie-tools-packaged-"))
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
										timeZone: "America/Chicago",
										recordedAt: 1789146000000n
									}
								])
								assert.equal((yield* apply(created.history, yield* draft.finish())).outcome.kind, "committed")
								return created.binding
							})
						)
						const bindingFile = path.join(directory, "binding.json")
						yield* retain(bindingFile, json(binding))
						yield* privateDirectory(path.join(directory, "provenance"))
						yield* retain(
							path.join(directory, "provenance", "synthetic-map.json"),
							json({ source: "synthetic", count: 1 })
						)
						const output = path.join(directory, "CURRENT.bumbledb.tar.gz"),
							operation = yield* mintId
						const capture = yield* Effect.scoped(
							backupLedger({ operation, output }).pipe(
								Effect.scoped,
								Effect.provide(ledgerLayer(bindingFile))
							)
						)
						const retry = yield* Effect.scoped(
							backupLedger({ operation, output }).pipe(
								Effect.scoped,
								Effect.provide(ledgerLayer(bindingFile))
							)
						)
						assert.deepEqual(retry, capture)
						const verified = yield* verifyArchive(output)
						assert.equal(verified.audit.factsDigest, capture.factsDigest)
						assert.equal(verified.audit.counts.Business, 1)
						assert.notEqual(verified.restoredIdentity.incarnationId, binding.identity.incarnationId)
						const restoreInput = {
							operation: yield* mintId,
							archive: output,
							directory: path.join(directory, "adopted", "store"),
							bindingOutput: path.join(directory, "adopted", "binding.json")
						}
						const restored = yield* restoreArchive(restoreInput)
						assert.equal(restored.audit.factsDigest, capture.factsDigest)
						// Recovery after native completion but before binding adoption keeps the target identity.
						yield* io("simulate interrupted adoption", () => fs.unlink(restoreInput.bindingOutput))
						const resumed = yield* restoreArchive(restoreInput)
						assert.deepEqual(resumed.binding, restored.binding)
						const restoredAgain = yield* restoreArchive(restoreInput)
						assert.deepEqual(restoredAgain.binding, restored.binding)
						const readback = yield* Effect.scoped(
							Effect.gen(function* () {
								return yield* auditLedger(yield* latest, parseCalendarDate("2026-09-11"))
							}).pipe(Effect.scoped, Effect.provide(ledgerLayer(restoreInput.bindingOutput)))
						)
						assert.equal(readback.factsDigest, capture.factsDigest)
						assert.deepEqual(
							JSON.parse(
								yield* io("read restored map", () =>
									fs.readFile(path.join(directory, "adopted", "provenance", "synthetic-map.json"), "utf8")
								)
							),
							{ source: "synthetic", count: 1 }
						)
						const corrupt = path.join(directory, "corrupt")
						yield* privateDirectory(corrupt)
						yield* io("extract synthetic archive", () => tar.extract({ file: output, cwd: corrupt }))
						yield* io("alter source evidence", () =>
							fs.writeFile(path.join(corrupt, "provenance", "synthetic-map.json"), "{}")
						)
						const corruptArchive = path.join(directory, "corrupt.tar.gz")
						yield* io("pack altered archive", () =>
							tar.create({ file: corruptArchive, gzip: true, cwd: corrupt }, ["."])
						)
						const refused = yield* Effect.result(verifyArchive(corruptArchive))
						assert.ok(Result.isFailure(refused))
						assert.match(json(refused.failure), /ArchiveHash/)
					})
				)
			)
		)
	} finally {
		await Effect.runPromise(runtime.disposeEffect)
		await fs.rm(directory, { recursive: true, force: true })
	}
})
