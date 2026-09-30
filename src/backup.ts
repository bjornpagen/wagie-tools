import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { promisify } from "node:util"
import {
	backup,
	IncarnationId,
	LocalHistory,
	OperationId,
	restore,
	sameIdentity,
	verifyBackup
} from "@bjornpagen/bumbledb-log"
import { Effect, Result, Schema } from "effect"
import { auditLedger } from "./audit.ts"
import { exists, io, readBytes, readText } from "./core/files.ts"
import { epochDay, today } from "./core/time.ts"
import { EntityId, entityId, json, mintId, Refusal } from "./core/values.ts"
import {
	Ledger,
	latest,
	loadStoredBinding,
	parseStrict,
	resolveRequest,
	retainedRequestReference
} from "./runtime.ts"
import ledger from "./schema.ts"

/** A backup is one `.tar.xz` holding exactly the database:
 *
 *   backup.json   what was captured: operation, identity, state, facts digest
 *   binding.json  the binding it was taken from
 *   native/       the verified BumbleDB native backup
 *
 * Documents live in Drive (the ledger keeps each one's Drive id and hash);
 * source lives in Git. Neither is copied into a backup.
 */
const Manifest = Schema.Struct({
	version: Schema.Literal(2),
	operation: EntityId,
	asOf: Schema.String,
	factsDigest: Schema.String
})

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const exec = promisify(execFile)
const fail = (code: string, message: string) => Effect.fail(new Refusal({ code, message }))
const operationId = (id: string) => Result.getOrThrow(OperationId.from(entityId(id)))
const scratch = Effect.acquireRelease(
	io("create a scratch directory", () => fs.mkdtemp(path.join(os.tmpdir(), "wagie-backup-"))),
	(directory) =>
		io("remove the scratch directory", () => fs.rm(directory, { recursive: true, force: true })).pipe(
			Effect.orDie
		)
)

/** Pack a directory as xz at the highest level. macOS ships bsdtar with xz
 * built in; Linux ships GNU tar, which runs the `xz` program. */
const pack = (directory: string, output: string) =>
	io("pack the backup as .tar.xz", async () => {
		const version = (await exec("tar", ["--version"])).stdout
		const bsd = /bsdtar/i.test(version)
		await exec(
			"tar",
			bsd
				? ["--options", "xz:compression-level=9", "-cJf", output, "-C", directory, "."]
				: ["-cJf", output, "-C", directory, "."],
			{ env: { ...process.env, XZ_OPT: "-9e" } }
		)
	})
const unpack = (archive: string, directory: string) =>
	Effect.gen(function* () {
		yield* io("unpack the backup", () => exec("tar", ["-xJf", path.resolve(archive), "-C", directory]))
		const manifest = parseStrict(Manifest, JSON.parse(yield* readText(path.join(directory, "backup.json"))))
		const binding = yield* loadStoredBinding(path.join(directory, "binding.json"))
		const source = { kind: "filesystem", directory: path.join(directory, "native") } as const
		const verified = yield* verifyBackup(source, { backup: operationId(manifest.operation) })
		if (json(verified.identity) !== json(binding.identity))
			return yield* fail("BackupIdentity", "The native backup and binding.json name different ledgers")
		return { manifest, binding, source, verified }
	})

/** Restore into `directory` as a new incarnation and check every fact against
 * the digest captured at backup time. */
const restoreInto = (unpacked: Effect.Success<ReturnType<typeof unpack>>, directory: string) =>
	Effect.gen(function* () {
		const target = {
			...unpacked.binding,
			directory,
			identity: {
				...unpacked.binding.identity,
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
			}
		}
		const restored = yield* restore(unpacked.source, target, {
			operationId: operationId(yield* mintId),
			backup: operationId(unpacked.manifest.operation),
			schema: ledger
		})
		if (restored.kind !== "completed") return yield* fail(restored.kind, json(restored))
		if (restored.value.binding.kind !== "local")
			return yield* fail("RestoreBinding", "Expected a local restored binding")
		const history = yield* LocalHistory.open(restored.value.binding, ledger)
		const audit = yield* auditLedger(
			yield* history.snapshot({ consistency: { kind: "latest" } }),
			epochDay(BigInt(unpacked.manifest.asOf))
		)
		if (audit.factsDigest !== unpacked.manifest.factsDigest)
			return yield* fail("RestoreFacts", "Restored facts differ from the facts captured at backup time")
		return { binding: restored.value.binding, factsDigest: audit.factsDigest, counts: audit.counts }
	})

/** Back up the open ledger to `output` (a new `.tar.xz` path). */
export const backupLedger = (input: { output: string }) =>
	Effect.scoped(
		Effect.gen(function* () {
			const output = path.resolve(input.output)
			if (yield* exists(output)) return yield* fail("BackupOutputExists", `Choose a new path: ${output}`)
			const { history, binding, recoveryDirectory } = yield* Ledger
			if ((yield* history.inspect()).unknownCommands.count !== 0n)
				return yield* fail(
					"UnresolvedCommands",
					"Resolve interrupted commands (command.resolve) before a backup"
				)
			// Every retained write against this ledger must be settled first. Requests
			// from before a restore or migration are history, not pending work.
			if (yield* exists(recoveryDirectory))
				for (const name of yield* io("list retained requests", () => fs.readdir(recoveryDirectory))) {
					if (!name.endsWith(".json")) continue
					const request = entityId(name.slice(0, -5))
					const reference = yield* retainedRequestReference(request)
					if (!sameIdentity(reference.identity, history.identity)) continue
					if ((yield* resolveRequest(request)).kind !== "found")
						return yield* fail(
							"UnresolvedCommands",
							`Resolve retained request ${request} (command.resolve) before a backup`
						)
				}
			const snapshot = yield* latest
			const asOf = yield* today("UTC")
			const audit = yield* auditLedger(snapshot, asOf)
			const directory = yield* scratch
			const operation = yield* mintId
			const destination = { kind: "filesystem", directory: path.join(directory, "native") } as const
			const backed = yield* backup(binding, {
				operationId: operationId(operation),
				destination,
				schema: ledger
			})
			if (backed.kind !== "completed") return yield* fail(backed.kind, json(backed))
			const verified = yield* verifyBackup(destination, { backup: operationId(operation) })
			if (json(verified.state) !== json(snapshot.stateStamp))
				return yield* fail("BackupStateChanged", "The ledger changed during the backup; run it again")
			yield* io("write the backup manifest", () =>
				fs.writeFile(
					path.join(directory, "backup.json"),
					json({ version: 2, operation, asOf: String(asOf), factsDigest: audit.factsDigest })
				)
			)
			yield* io("write the binding", () => fs.writeFile(path.join(directory, "binding.json"), json(binding)))
			yield* io("create the output directory", () => fs.mkdir(path.dirname(output), { recursive: true }))
			yield* pack(directory, output)
			const bytes = yield* readBytes(output)
			return {
				archive: output,
				sha256: hash(bytes),
				bytes: bytes.length,
				state: verified.state,
				factsDigest: audit.factsDigest
			}
		})
	)

/** Restore the archive into a throwaway directory and compare every fact.
 * Never touches the live ledger. */
export const verifyArchive = (archive: string) =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = yield* scratch
			const unpacked = yield* unpack(archive, directory)
			const restored = yield* restoreInto(unpacked, path.join(directory, "restored"))
			return {
				archive: path.resolve(archive),
				sha256: hash(yield* readBytes(archive)),
				factsDigest: restored.factsDigest,
				counts: restored.counts
			}
		})
	)

/** Restore the archive into a new, empty `directory` and write its binding to
 * `bindingOutput`. Refuses to touch an existing ledger or binding. */
export const restoreArchive = (input: { archive: string; directory: string; bindingOutput: string }) =>
	Effect.scoped(
		Effect.gen(function* () {
			const directory = path.resolve(input.directory),
				bindingOutput = path.resolve(input.bindingOutput)
			if (yield* exists(bindingOutput))
				return yield* fail("BindingExists", `A binding already exists at ${bindingOutput}; choose a new path`)
			if (yield* exists(directory))
				if ((yield* io("inspect the target directory", () => fs.readdir(directory))).length)
					return yield* fail("DirectoryNotEmpty", `Restore into a new, empty directory: ${directory}`)
			const unpacked = yield* unpack(input.archive, yield* scratch)
			const restored = yield* restoreInto(unpacked, directory)
			yield* io("write the restored binding", async () => {
				await fs.mkdir(path.dirname(bindingOutput), { recursive: true })
				await fs.writeFile(bindingOutput, json(restored.binding), { flag: "wx" })
			})
			return { binding: bindingOutput, directory, factsDigest: restored.factsDigest }
		})
	)
