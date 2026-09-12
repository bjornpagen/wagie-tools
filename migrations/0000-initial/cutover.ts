import {
	ChangeSet,
	type QueryRelation,
	query,
	type Schema,
	type SchemaRelations,
	v
} from "@bjornpagen/bumbledb"
import type { Population, PublishedSnapshot } from "@bjornpagen/bumbledb-log"
import { Effect, Stream } from "effect"
import { schema } from "./schema.ts"

const allRows = <Rels extends SchemaRelations, R extends QueryRelation<Rels>>(
	theory: Schema<Rels>,
	relation: R
) =>
	query(theory).rule((r) => {
		const row = v(relation)
		return r.match(relation, row).find(row)
	})

/** Establish the initial baseline without changing a fact or an entity ID.
 * Closed facts belong to the verified schema; ordinary relations are copied in
 * native result pages. Activation and the preservation audit belong to the caller.
 */
export const populateInitial = (
	source: PublishedSnapshot<typeof schema>,
	target: Population<typeof schema>
) =>
	Effect.gen(function* () {
		for (const relation of Object.values(schema.relations)) {
			if (relation.kind !== "relation") continue
			yield* Effect.scoped(
				Effect.gen(function* () {
					const result = yield* source.execute(allRows(schema, relation), {})
					yield* Stream.runForEach(result.pages(), (page) =>
						Effect.scoped(
							Effect.gen(function* () {
								const batch = yield* ChangeSet.builder(schema)
								yield* batch.insert(relation, page)
								yield* target.apply(yield* batch.finish())
							})
						)
					)
				})
			)
		}
	})
