import type { NativeRuntime, Uuid } from "@bjornpagen/bumbledb"
import type { Population, PublishedSnapshot } from "@bjornpagen/bumbledb-log"
import type { Effect } from "effect"
import { ledger } from "../src/schema.ts"
import * as s0000 from "./0000-initial/schema.ts"
import { populateStatements } from "./0001-statements/cutover.ts"
import * as s0001 from "./0001-statements/schema.ts"
import { populateTyped } from "./0002-typed/cutover.ts"
import type * as s0002 from "./0002-typed/schema.ts"
import { current } from "./current.ts"

/** One released schema baseline and the transformation that reaches it from
 * the one before. The table is the migration history; `current` is the
 * baseline the runtime opens. Each cutover is frozen with the two generated
 * schemas it maps between and is never edited after release. */
export interface Step<From extends AnySchema, To extends AnySchema> {
	readonly name: string
	readonly directory: string
	readonly from: From
	readonly to: To
	readonly populate: (
		source: PublishedSnapshot<From>,
		target: Population<To>,
		mint: Effect.Effect<Uuid>
	) => Effect.Effect<unknown, unknown, NativeRuntime>
}
export type AnySchema = typeof s0000.schema | typeof s0001.schema | typeof s0002.schema

const step = <From extends AnySchema, To extends AnySchema>(value: Step<From, To>) => value

export const steps = {
	"0001-statements": step({
		name: "0001-statements",
		directory: "migrations/0001-statements",
		from: s0000.schema,
		to: s0001.schema,
		populate: populateStatements
	}),
	"0002-typed": step({
		name: "0002-typed",
		directory: "migrations/0002-typed",
		from: s0001.schema,
		// The current baseline is the live schema object itself; `pnpm schema:check`
		// proves the generated artifact beside it is the same schema. Queries the
		// runtime compiled against `ledger` then read a freshly migrated target.
		to: ledger,
		populate: (source, target) => populateTyped(source, target)
	})
} as const
export type StepName = keyof typeof steps

export { current, currentDirectory } from "./current.ts"

// The runtime's baseline is a released step.
void (current satisfies StepName)
