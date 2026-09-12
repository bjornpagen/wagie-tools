import type { Fact } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { Nonblank, Refusal } from "./core/values.ts"
import type { Draft } from "./runtime.ts"
import { inputField, inputFields } from "./schema/input.ts"
import { components } from "./schema/vocabulary.ts"
import * as S from "./schema.ts"

/** Observed figures are evidence of an external assessment. They are never a
 * substitute calculation mode for new payroll or an inferred rate schedule.
 */
export const ObservedAssessmentInput = Schema.Struct({
	amounts: Schema.Record(
		Schema.Literals(S.Component.handles),
		inputField(S.ObservedAssessment.fields.amount)
	),
	taxableWages: Schema.Array(
		Schema.Struct({
			...inputFields(S.TaxableWages, ["program", "evidence"]),
			cents: inputField(S.TaxableWages.fields.amount)
		})
	),
	evidence: Nonblank
})

export const observedSetFacts = (
	draft: Draft,
	set: Fact<typeof S.AssessmentSet>,
	input: typeof ObservedAssessmentInput.Type
) =>
	Effect.gen(function* () {
		if (set.origin !== "Observed")
			return yield* Effect.fail(
				new Refusal({
					code: "AssessmentOrigin",
					message: "External assessment facts require the observed origin"
				})
			)
		if (new Set(input.taxableWages.map((row) => row.program)).size !== input.taxableWages.length)
			return yield* Effect.fail(
				new Refusal({
					code: "DuplicateTaxableProgram",
					message: "Supply each observed taxable-wage program once"
				})
			)
		yield* draft.insert(S.AssessmentSet, [set])
		yield* draft.insert(S.ObservedSet, [{ set: set.id, evidence: input.evidence }])
		for (const component of components) {
			yield* draft.insert(S.Assessment, [
				{ set: set.id, component, origin: "Observed", method: "SuppliedAmount" }
			])
			yield* draft.insert(S.ObservedAssessment, [
				{ set: set.id, component, amount: input.amounts[component], evidence: input.evidence }
			])
		}
		yield* draft.insert(
			S.TaxableWages,
			input.taxableWages.map((row) => ({
				set: set.id,
				program: row.program,
				amount: row.cents,
				evidence: row.evidence
			}))
		)
		return set
	})
