import * as fs from "node:fs/promises"
import * as path from "node:path"
import { NativeRuntime, Schema } from "@bjornpagen/bumbledb"
import { backup, IncarnationId, OperationId, restore, verifyBackup } from "@bjornpagen/bumbledb-log"
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Result } from "effect"
import { type AnySchema, steps } from "../migrations/index.ts"
import { io } from "../src/core/files.ts"
import { json, mintId, Refusal } from "../src/core/values.ts"
import { loadStoredBinding } from "../src/runtime.ts"

/** Native-only backup and restore of the ledger behind a binding, with no
 * document bundle and no Drive requirement: the safety copy taken before and
 * after a schema cutover, and the way back to a fresh source incarnation when
 * a cutover has to be redone. The store is opened with whichever released
 * schema the binding names, so this works on either side of a cutover.
 *
 *   node scripts/native-backup.ts backup  --binding private/binding.json --destination DIR [--operation UUIDv7]
 *   node scripts/native-backup.ts restore --binding private/binding.json.before-0002 --source DIR --operation UUIDv7 \
 *     --directory NEWDIR --binding-output FILE
 *
 * `restore` reads the backup taken from the binding's identity into a new
 * incarnation at `--directory` and writes its binding to `--binding-output`.
 */
const [verb, ...args] = process.argv.slice(2)
const flag = (name: string) => {
	const index = args.indexOf(`--${name}`)
	return index === -1 ? undefined : args[index + 1]
}

/** The released schema whose native id the binding carries. */
const releasedSchema = (schemaId: string) =>
	Effect.gen(function* () {
		const candidates: AnySchema[] = Object.values(steps).flatMap((step) => [step.from, step.to])
		for (const candidate of candidates)
			if ((yield* Schema.compile(candidate)).schemaId === schemaId) return candidate
		return yield* Effect.fail(
			new Refusal({ code: "UnknownSchema", message: `No released schema has id ${schemaId}` })
		)
	})

const takeBackup = Effect.gen(function* () {
	const directory = flag("destination")
	if (!directory)
		return yield* Effect.fail(new Refusal({ code: "Usage", message: "--destination is required" }))
	const binding = yield* loadStoredBinding(flag("binding") ?? "private/binding.json")
	const operation = flag("operation") ?? (yield* mintId)
	const destination = { kind: "filesystem", directory } as const
	const schema = yield* releasedSchema(binding.identity.schemaId)
	const backed = yield* backup(binding, {
		operationId: Result.getOrThrow(OperationId.from(operation as never)),
		destination,
		schema
	})
	if (backed.kind !== "completed")
		return yield* Effect.fail(new Refusal({ code: backed.kind, message: json(backed) }))
	const verified = yield* verifyBackup(destination, {
		backup: Result.getOrThrow(OperationId.from(operation as never))
	})
	yield* Console.log(json({ operation, backed, verified }))
})

const restoreBackup = Effect.gen(function* () {
	const source = flag("source"),
		directory = flag("directory"),
		bindingOutput = flag("binding-output")
	if (!source || !directory || !bindingOutput)
		return yield* Effect.fail(
			new Refusal({ code: "Usage", message: "--source, --directory and --binding-output are required" })
		)
	const binding = yield* loadStoredBinding(flag("binding") ?? "private/binding.json")
	const from = { kind: "filesystem", directory: source } as const
	const operation = flag("operation")
	if (!operation)
		return yield* Effect.fail(new Refusal({ code: "Usage", message: "--operation names the backup" }))
	const manifest = yield* verifyBackup(from, {
		backup: Result.getOrThrow(OperationId.from(operation as never))
	})
	if (json(manifest.identity) !== json(binding.identity))
		return yield* Effect.fail(
			new Refusal({
				code: "BackupIdentity",
				message: "The backup was not taken from this binding's incarnation"
			})
		)
	const schema = yield* releasedSchema(binding.identity.schemaId)
	const target = {
		...binding,
		directory: path.resolve(directory),
		identity: { ...binding.identity, incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId)) }
	}
	const restored = yield* restore(from, target, {
		operationId: Result.getOrThrow(OperationId.from(yield* mintId)),
		backup: Result.getOrThrow(OperationId.from(operation as never)),
		schema
	})
	if (restored.kind !== "completed")
		return yield* Effect.fail(new Refusal({ code: restored.kind, message: json(restored) }))
	yield* io("write the restored binding", () =>
		fs.writeFile(bindingOutput, json(restored.value.binding), { flag: "wx" })
	)
	yield* Console.log(json({ manifest, restored }))
})

const program =
	verb === "backup"
		? takeBackup
		: verb === "restore"
			? restoreBackup
			: Console.error("usage: backup | restore")

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NativeRuntime.layer())))
