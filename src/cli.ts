import { NativeRuntime } from "@bjornpagen/bumbledb"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { type Cause, Console, Effect, Schema } from "effect"
import { businessFacts } from "./commands.ts"
import { encodeOutput } from "./core/boundary.ts"
import { io, readText } from "./core/files.ts"
import { entityId, json, mintId, Refusal } from "./core/values.ts"
import { archives, backups, decodeInput, readAsOf, reads, refuseUnknown, writes } from "./ops.ts"
import { relationRows, rows } from "./queries.ts"
import { defaultBindingPath, latest, ledgerLayer } from "./runtime.ts"
import * as S from "./schema.ts"

/**
 * wagie apply  [--input FILE|-] [--binding FILE]   one write:  {"op": "payroll.post", ...}
 * wagie read   [--input FILE|-] [--binding FILE]   one read:   {"read": "status", "business": ...}
 * wagie schema [NAME]                               JSON Schema of every op and read, or one
 * wagie id                                          a fresh UUIDv7 for a request or operation
 *
 * Input is one JSON object. Money is dollars with two decimals ("8000.00"),
 * dates are "YYYY-MM-DD", spans are {"start", "endExclusive"}. Output is JSON
 * in the same units; evidence ids resolve to their text.
 */
/** One readable failure per cause: a Refusal's code and message, or an
 * unexpected error's name, message and stack. Never an empty object. */
const describeCause = (cause: Cause.Cause<unknown>) =>
	cause.reasons.map((reason) => {
		const error: unknown =
			reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : reason
		if (error instanceof Refusal) return { kind: "Refusal", code: error.code, message: error.message }
		if (error instanceof Error)
			return { kind: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 8) }
		return { kind: reason._tag, detail: error }
	})

const usage = `usage: wagie <apply|read|schema|id> [--input FILE|-] [--binding FILE]`

const flag = (args: readonly string[], name: string) => {
	const index = args.indexOf(`--${name}`)
	return index === -1 ? undefined : args[index + 1]
}

const readPayload = (source: string | undefined) =>
	Effect.gen(function* () {
		const text =
			source === undefined || source === "-"
				? yield* io("read JSON from stdin", async () => {
						const chunks: Buffer[] = []
						for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
						return Buffer.concat(chunks).toString("utf8")
					})
				: yield* readText(source)
		const value: unknown = JSON.parse(text)
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return yield* Effect.fail(new Refusal({ code: "InvalidInput", message: "Supply one JSON object" }))
		return value as Record<string, unknown>
	})

/** Statement text for evidence ids, read once per output. */
const statements = Effect.gen(function* () {
	const snapshot = yield* latest
	return new Map((yield* relationRows(snapshot, S.Statement)).map((row) => [row.id as string, row.text]))
})

const print = (value: unknown, texts: ReadonlyMap<string, string>) =>
	Console.log(json(encodeOutput(value, texts)))

const apply = (args: readonly string[]) =>
	Effect.gen(function* () {
		const { op, ...payload } = yield* readPayload(flag(args, "input"))
		const binding = flag(args, "binding") ?? defaultBindingPath
		if (typeof op !== "string")
			return yield* Effect.fail(new Refusal({ code: "InvalidInput", message: 'Name the write in "op"' }))
		if (op === "db.backup") {
			const input = decodeInput(backups["db.backup"].input, payload)
			return yield* Effect.gen(function* () {
				yield* print(yield* backups["db.backup"].run(input), yield* statements)
			}).pipe(Effect.scoped, Effect.provide(ledgerLayer(binding)))
		}
		if (op === "db.verify-backup")
			return yield* print(
				yield* archives["db.verify-backup"].run(decodeInput(archives["db.verify-backup"].input, payload)),
				new Map()
			)
		if (op === "db.restore")
			return yield* print(
				yield* archives["db.restore"].run(decodeInput(archives["db.restore"].input, payload)),
				new Map()
			)
		if (!(op in writes))
			return yield* refuseUnknown("write", op, [
				...Object.keys(writes),
				...Object.keys(backups),
				...Object.keys(archives)
			])
		const write = writes[op as keyof typeof writes]
		return yield* Effect.gen(function* () {
			const receipt = yield* write.run(payload)
			const result = "readback" in write ? yield* write.readback(receipt) : receipt
			yield* print(result, yield* statements)
			if (
				(receipt.outcome.kind === "committed" || receipt.outcome.kind === "no-change") &&
				receipt.outcome.result.kind === "ReconciliationRequired"
			)
				process.exitCode = 1
		}).pipe(Effect.scoped, Effect.provide(ledgerLayer(binding)))
	})

const read = (args: readonly string[]) =>
	Effect.gen(function* () {
		const { read: name, ...payload } = yield* readPayload(flag(args, "input"))
		const binding = flag(args, "binding") ?? defaultBindingPath
		if (typeof name !== "string")
			return yield* Effect.fail(new Refusal({ code: "InvalidInput", message: 'Name the read in "read"' }))
		if (!(name in reads)) return yield* refuseUnknown("read", name, Object.keys(reads))
		const entry = reads[name as keyof typeof reads]
		const input = decodeInput(entry.input, payload) as { business?: string; asOf?: bigint }
		return yield* Effect.gen(function* () {
			const company =
				input.business === undefined
					? undefined
					: (yield* rows(yield* latest, businessFacts, {})).find((row) => row.id === input.business)
			if (input.business !== undefined && !company)
				return yield* Effect.fail(
					new Refusal({ code: "BusinessMissing", message: `No business ${input.business}` })
				)
			const asOf = yield* readAsOf(input.asOf as never, company?.timeZone ?? "UTC")
			yield* print(yield* entry.run(input as never, { asOf }), yield* statements)
		}).pipe(Effect.scoped, Effect.provide(ledgerLayer(binding)))
	})

const schema = (args: readonly string[]) =>
	Effect.gen(function* () {
		const name = args[0]
		const all = {
			...Object.fromEntries(Object.entries(writes).map(([key, value]) => [key, { kind: "write", ...value }])),
			...Object.fromEntries(
				[...Object.entries(backups), ...Object.entries(archives)].map(([key, value]) => [
					key,
					{ kind: "write", ...value }
				])
			),
			...Object.fromEntries(Object.entries(reads).map(([key, value]) => [key, { kind: "read", ...value }]))
		}
		const describe = (key: string) => {
			const entry = all[key]
			if (!entry) throw new Refusal({ code: "UnknownOperation", message: `No op or read "${key}"` })
			return {
				name: key,
				kind: entry.kind,
				summary: entry.summary,
				input: Schema.toJsonSchemaDocument(Schema.toEncoded(entry.input))
			}
		}
		yield* Console.log(
			JSON.stringify(
				name
					? describe(name)
					: Object.keys(all).map((key) => ({ name: key, kind: all[key]?.kind, summary: all[key]?.summary })),
				null,
				2
			)
		)
	})

const main = Effect.gen(function* () {
	const [verb, ...args] = process.argv.slice(2)
	switch (verb) {
		case "apply":
			return yield* apply(args)
		case "read":
			return yield* read(args)
		case "schema":
			return yield* schema(args)
		case "id":
			return yield* Console.log(entityId(yield* mintId))
		default:
			yield* Console.error(usage)
			process.exitCode = 2
	}
}).pipe(
	Effect.provide(NodeServices.layer),
	Effect.provide(NativeRuntime.layer()),
	Effect.catchCause((cause) =>
		Effect.gen(function* () {
			yield* Console.error(json(describeCause(cause)))
			process.exitCode = 1
		})
	)
)
NodeRuntime.runMain(main)
