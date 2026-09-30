import { createHash } from "node:crypto"
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
import { type StepName, steps } from "../migrations/index.ts"
import { inventory } from "../src/audit.ts"
import { io, readText } from "../src/core/files.ts"
import { entityId, json, mintId, Refusal } from "../src/core/values.ts"
import { loadStoredBinding } from "../src/runtime.ts"

/** Run one released cutover against a live ledger.
 *
 *   node scripts/migrate.ts --step 0002-typed --binding private/binding.json \
 *     --contract private/migration/contract-0002.json --out private/migration [--activate]
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
const stepName = flag("step")
if (!stepName || !Object.hasOwn(steps, stepName)) {
	console.error(`--step must be one of ${Object.keys(steps).join(", ")}`)
	process.exit(2)
}
const step = steps[stepName as StepName]
const bindingFile = flag("binding") ?? "private/binding.json"
const contractFile = flag("contract") ?? `private/migration/contract-${step.name}.json`
const outDirectory = flag("out") ?? "private/migration"
const activate = args.includes("--activate")

const program = Effect.gen(function* () {
	const binding = yield* loadStoredBinding(bindingFile)
	const from = yield* Schema.compile(step.from)
	const to = yield* Schema.compile(step.to)
	if (binding.identity.schemaId !== from.schemaId)
		return yield* Effect.fail(
			new Refusal({ code: "WrongSchema", message: `The binding is not a ${step.name} source ledger` })
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
		const identity = (value: DatabaseIdentity): DatabaseIdentity => ({
			databaseId: value.databaseId,
			incarnationId: Result.getOrThrow(IncarnationId.parse(value.incarnationId)),
			schemaId: Result.getOrThrow(parseSchemaId(value.schemaId))
		})
		contract = {
			operation: Result.getOrThrow(OperationId.from(entityId(saved.operation))),
			source: identity(saved.source),
			target: identity(saved.target),
			commitment: saved.commitment
		}
		yield* Console.error(`reusing retained contract ${saved.operation}`)
	} else {
		const digest = createHash("sha256")
		for (const file of ["cutover.ts", "schema.json"])
			digest.update(yield* readText(path.join(step.directory, file)))
		contract = {
			operation: Result.getOrThrow(OperationId.from(yield* mintId)),
			source: binding.identity,
			target: {
				...binding.identity,
				schemaId: to.schemaId,
				incarnationId: Result.getOrThrow(IncarnationId.from(yield* mintId))
			},
			commitment: digest.digest("hex")
		}
		yield* io("retain contract", () => fs.writeFile(contractFile, json(contract), { flag: "wx" }))
		yield* Console.error(`retained contract ${contract.operation}`)
	}
	const source = yield* LocalHistory.open(binding, step.from)
	const start = yield* Transition.begin(source, step.to, contract)
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
					yield* step.populate(start.source as never, start.population as never, mintId)
					return yield* start.population.finish()
				})
	yield* Console.error("inspecting target…")
	yield* Effect.scoped(
		Effect.gen(function* () {
			const target = yield* LocalHistory.open(ready.binding, step.to)
			const inspected = yield* Transition.inspect(target, ready.installed)
			const facts = yield* inventory(inspected as never)
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
	const activated = yield* Transition.activate(source, step.to, ready.installed)
	const previous = `${bindingFile}.before-${step.name}`
	yield* io("keep the prior binding", () => fs.copyFile(bindingFile, previous))
	yield* io("adopt the new binding", () => fs.writeFile(bindingFile, json(activated.binding)))
	yield* Console.log(json({ kind: "activated", binding: activated.binding, previousBinding: previous }))
})

NodeRuntime.runMain(
	program.pipe(
		Effect.scoped,
		Effect.provide(NativeRuntime.layer()),
		Effect.tapError((error) => Console.error(json(error)))
	)
)
