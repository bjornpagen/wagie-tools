import * as fs from "node:fs/promises"
import { NativeRuntime, query, Schema, v } from "@bjornpagen/bumbledb"
import { LocalHistory } from "@bjornpagen/bumbledb-log"
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { type AnySchema, steps } from "../migrations/index.ts"
import { io } from "../src/core/files.ts"
import { json, Refusal } from "../src/core/values.ts"
import { loadStoredBinding } from "../src/runtime.ts"

/** Dump every fact of the ledger behind a binding, read with whichever
 * released schema the binding names: `{relation: rows[]}`.
 *
 *   node scripts/facts.ts --binding FILE --out FILE
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
	const index = args.indexOf(`--${name}`)
	return index === -1 ? undefined : args[index + 1]
}

const program = Effect.gen(function* () {
	const binding = yield* loadStoredBinding(flag("binding") ?? "private/binding.json")
	const out = flag("out")
	if (!out) return yield* Effect.fail(new Refusal({ code: "Usage", message: "--out is required" }))
	let schema: AnySchema | undefined
	for (const candidate of Object.values(steps).flatMap((step) => [step.from, step.to] as AnySchema[]))
		if ((yield* Schema.compile(candidate)).schemaId === binding.identity.schemaId) schema = candidate
	if (!schema)
		return yield* Effect.fail(new Refusal({ code: "UnknownSchema", message: binding.identity.schemaId }))
	const history = yield* LocalHistory.open(binding, schema as never)
	const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
	const facts: Record<string, readonly unknown[]> = {}
	for (const [name, relation] of Object.entries(schema.relations as Record<string, { kind: string }>)) {
		if (relation.kind !== "relation") continue
		const template = query(schema as never).rule((r: unknown) => {
			const row = v(relation as never)
			return (r as { match: (a: unknown, b: unknown) => { find: (x: unknown) => unknown } })
				.match(relation, row)
				.find(row) as never
		})
		facts[name] = yield* Effect.scoped(
			Effect.gen(function* () {
				return yield* (yield* snapshot.execute(template as never, {})).collect()
			})
		)
	}
	yield* io("write facts", () => fs.writeFile(out, json({ state: snapshot.stateStamp, facts })))
	yield* Console.log(
		`${Object.keys(facts).length} relations, ${Object.values(facts).reduce((n, r) => n + r.length, 0)} facts`
	)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NativeRuntime.layer())))
