import * as fs from "node:fs/promises"
import { NativeRuntime } from "@bjornpagen/bumbledb"
import { schemaBindings, schemaSnapshot } from "@bjornpagen/bumbledb-log/schema"
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect } from "effect"
import { io } from "../src/core/files.ts"
import { Refusal } from "../src/core/values.ts"
import ledger from "../src/schema.ts"

// Both artifacts are produced by Log; this check never opens a business database.
const program = Effect.gen(function* () {
	const snapshot = yield* schemaSnapshot(ledger)
	const bindings = yield* schemaBindings(snapshot)
	for (const [name, expected] of [
		["schema.json", snapshot],
		["schema.ts", bindings]
	] as const) {
		const actual = yield* io("read initial schema artifact", () =>
			fs.readFile(new URL(`../migrations/0000-initial/${name}`, import.meta.url), "utf8")
		)
		if (actual !== expected)
			return yield* Effect.fail(
				new Refusal({
					code: "SchemaArtifactStale",
					message: `${name} differs from the current schema. Preserve released baselines when adding a migration.`
				})
			)
	}
	yield* Console.log("Canonical initial snapshot and generated bindings match the current schema")
})

NodeRuntime.runMain(program.pipe(Effect.provide(NativeRuntime.layer())))
