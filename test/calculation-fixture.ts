import assert from "node:assert/strict"
import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { civilDayPoint, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import type { Draft } from "../src/runtime.ts"
import { componentPolicy, components } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { evidence, type PayrollFixture as Fixture } from "./payroll-fixture.ts"
export const candidate = (
	draft: Draft,
	fixture: Fixture,
	gross: bigint,
	prior: bigint,
	corrupt?: "day" | "scope" | "year" | "sharedBase" | "approval"
) =>
	Effect.gen(function* () {
		const set = yield* mintId
		const calculation = yield* mintId
		const { business, employee, release, domain, rules } = fixture
		const stateRule = rules.get("SUTA")
		assert.ok(stateRule)
		const paidOn = civilDayPoint(parseCalendarDate("2026-09-10"))
		yield* draft.insert(S.AssessmentSet, [
			{ id: set, business, employee, paidOn, gross, origin: "Calculated" }
		])
		yield* draft.insert(S.PayrollCalculation, [
			{
				id: calculation,
				set,
				request: yield* mintId,
				domain,
				business,
				paidOn,
				release,
				purpose: "NewWage",
				sourceStamp: "synthetic",
				recordingDay: paidOn.start,
				contextHash: "synthetic",
				evidence
			}
		])
		yield* draft.insert(
			S.CalculationPolicy,
			fixture.annual.policies
				.filter((row) => corrupt !== "approval" || row.authority !== "Texas")
				.map((row) => ({
					calculation,
					annual: row.annual,
					release,
					business,
					authority: row.authority,
					day: paidOn
				}))
		)
		yield* draft.insert(S.ProposedWage, [
			{
				calculation,
				business,
				paidOn,
				depositor: fixture.depositor,
				span: periodSpan(2026, "Month", 9),
				roth: 0n,
				evidence
			}
		])
		const capturedScopes = new Set<Uuid>()
		for (const component of components) {
			yield* draft.insert(S.Assessment, [
				{ set, component, origin: "Calculated", method: componentPolicy[component].method }
			])
			if (component === "FIT") {
				yield* draft.insert(S.ObservedAssessment, [{ set, component, amount: 0n, evidence }])
				continue
			}
			const rule = rules.get(component)
			assert.ok(rule)
			const basis = yield* mintId
			const earning = { start: prior, end: prior + gross }
			if (!capturedScopes.has(rule.scope)) {
				capturedScopes.add(rule.scope)
				yield* draft.insert(S.CalculationWageBase, [
					{ set, scope: rule.scope, cents: gross, earning, context: evidence }
				])
			}
			if (corrupt === "sharedBase" && component === "EmployerSS") {
				earning.start += 1n
				earning.end += 1n
			}
			yield* draft.insert(S.CalculatedAssessment, [{ set, component, basis }])
			yield* draft.insert(S.AppliedRule, [
				{
					set,
					component,
					version: rule.version,
					schedule: rule.schedule,
					release,
					business,
					day: corrupt === "day" ? civilDayPoint(parseCalendarDate("2026-09-09")) : paidOn
				}
			])
			yield* draft.insert(S.CalculationBasis, [
				{
					id: basis,
					set,
					component,
					scope: corrupt === "scope" && component === "FUTA" ? stateRule.scope : rule.scope,
					domain,
					support: rule.support,
					business,
					employee,
					year: corrupt === "year" ? 2025n : 2026n,
					paidOn,
					schedule: rule.schedule,
					earning,
					cents: gross
				}
			])
		}
		return set
	})
