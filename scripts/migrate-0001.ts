import * as fs from "node:fs/promises"
import * as path from "node:path"
import { NativeRuntime, Schema } from "@bjornpagen/bumbledb"
import {
	type DatabaseIdentity,
	IncarnationId,
	LocalHistory,
	OperationId,
	parseSchemaId,
	Transition,
	type TransitionContract
} from "@bjornpagen/bumbledb-log"
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Result } from "effect"
import * as old from "../migrations/0000-initial/schema.ts"
import { populateStatements } from "../migrations/0001-statements/cutover.ts"
import { inventory } from "../src/audit.ts"
import { io, readText } from "../src/core/files.ts"
import { entityId, json, mintId, Refusal } from "../src/core/values.ts"
import { loadStoredBinding } from "../src/runtime.ts"
import * as S from "../src/schema.ts"

/**
 * Migrate a live 0000 ledger to 0001.
 *
 *   node scripts/migrate-0001.ts --binding private/binding.json --contract private/migration/contract.json --out private/migration
 *
 * The contract is retained before dispatch and reused on retry. The script
 * populates, inspects, writes the target inventory for comparison, and stops
 * before activation unless --activate is given. Activation adopts the new
 * binding by rewriting the binding file; the old file is kept beside it.
 */
const args = process.argv.slice(2)
const flag = (name: string) => {
	const index = args.indexOf(`--${name}`)
	return index === -1 ? undefined : args[index + 1]
}
const bindingFile = flag("binding") ?? "private/binding.json"
const contractFile = flag("contract") ?? "private/migration/contract-0001.json"
const outDirectory = flag("out") ?? "private/migration"
const activate = args.includes("--activate")

const program = Effect.gen(function* () {
	const binding = yield* loadStoredBinding(bindingFile)
	const oldSchema = yield* Schema.compile(old.schema)
	const newSchema = yield* Schema.compile(S.ledger)
	if (binding.identity.schemaId !== oldSchema.schemaId)
		return yield* Effect.fail(
			new Refusal({ code: "WrongSchema", message: "The binding is not a 0000-initial ledger" })
		)
	yield* io("create migration directory", () => fs.mkdir(outDirectory, { recursive: true }))
	let contract: TransitionContract
	const retained = yield* Effect.result(readText(contractFile))
	if (Result.isSuccess(retained)) {
		const saved = JSON.parse(retained.success) as {
			operation: string
			source: DatabaseIdentity
			target: DatabaseIdentity
			commitment: string
		}
		contract = {
			operation: Result.getOrThrow(OperationId.from(entityId(saved.operation))),
			source: {
				databaseId: saved.source.databaseId,
				incarnationId: Result.getOrThrow(IncarnationId.parse(saved.source.incarnationId)),
				schemaId: Result.getOrThrow(parseSchemaId(saved.source.schemaId))
			},
			target: {
				databaseId: saved.target.databaseId,
				incarnationId: Result.getOrThrow(IncarnationId.parse(saved.target.incarnationId)),
				schemaId: Result.getOrThrow(parseSchemaId(saved.target.schemaId))
			},
			commitment: saved.commitment
		}
		yield* Console.error(`reusing retained contract ${saved.operation}`)
	} else {
		const sourceFiles = ["migrations/0001-statements/cutover.ts", "migrations/0001-statements/schema.json"]
		const { createHash } = yield* Effect.promise(() => import("node:crypto"))
		const digest = createHash("sha256")
		for (const file of sourceFiles) digest.update(yield* readText(file))
		contract = {
			operation: Result.getOrThrow(OperationId.from(yield* mintId)),
			source: binding.identity,
			target: {
				...binding.identity,
				schemaId: newSchema.schemaId,
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
			},
			commitment: digest.digest("hex")
		}
		yield* io("retain contract", () => fs.writeFile(contractFile, json(contract), { flag: "wx" }))
		yield* Console.error(`retained contract ${contract.operation}`)
	}
	const source = yield* LocalHistory.open(binding, old.schema)
	const start = yield* Transition.begin(source, S.ledger, contract)
	yield* Console.error(`transition: ${start.kind}`)
	if (start.kind === "aborted")
		return yield* Effect.fail(new Refusal({ code: "Aborted", message: "aborted" }))
	if (start.kind === "activated") {
		yield* Console.log(json({ kind: "activated", binding: start.binding }))
		return
	}
	const ready =
		start.kind === "ready"
			? start
			: yield* Effect.gen(function* () {
					yield* Console.error("populating…")
					yield* populateStatements(start.source, start.population, mintId)
					return yield* start.population.finish()
				})
	yield* Console.error("inspecting target…")
	yield* Effect.scoped(
		Effect.gen(function* () {
			const target = yield* LocalHistory.open(ready.binding, S.ledger)
			const inspected = yield* Transition.inspect(target, ready.installed)
			const facts = yield* inventory(inspected)
			yield* io("write target inventory", () =>
				fs.writeFile(
					path.join(outDirectory, "target-facts.json"),
					json({ state: inspected.stateStamp, facts })
				)
			)
			yield* Console.error(
				`target: ${Object.keys(facts).length} relations, ${Object.values(facts).reduce((n, rows) => n + rows.length, 0)} facts`
			)
		})
	)
	if (!activate) {
		yield* Console.log(json({ kind: "ready", binding: ready.binding, contract }))
		return
	}
	const activated = yield* Transition.activate(source, S.ledger, ready.installed)
	const previous = `${bindingFile}.0000-initial`
	yield* io("keep the prior binding", () => fs.copyFile(bindingFile, previous))
	yield* io("adopt the new binding", () => fs.writeFile(bindingFile, json(activated.binding)))
	yield* Console.log(json({ kind: "activated", binding: activated.binding, previousBinding: previous }))
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NativeRuntime.layer())))
