import { Compute, query, type Uuid, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import {
	type CivilDaySpan,
	civilDaySpan,
	countCalendarDays,
	epochDay,
	type UnixEpochDay
} from "./core/time.ts"
import { Refusal } from "./core/values.ts"
import { relationRows, rows } from "./queries.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"
import { requirePayrollReady } from "./work.ts"

const usedBudget = query(S.ledger).rule((r) => {
	const { commitment, budget, amount } = v(S.BudgetAssignment)
	return r.match(S.BudgetAssignment, { commitment, budget, amount }).find({ budget, amount: r.sum(amount) })
})
const assignedRemaining = query(S.ledger).rule((r) => {
	const { id: budget, limit } = v(S.AnnualBudget),
		{ amount } = v(usedBudget)
	return r
		.match(S.AnnualBudget, { id: budget, limit })
		.match(usedBudget, { budget, amount })
		.find({ budget, remaining: Compute.subtract(limit, amount) })
})
const remainingBudget = query(S.ledger)
	.rule((r) => {
		const row = v(assignedRemaining)
		return r.match(assignedRemaining, row).find(row)
	})
	.rule((r) => {
		const { id: budget, limit: remaining } = v(S.AnnualBudget)
		return r
			.match(S.AnnualBudget, { id: budget, limit: remaining })
			.where(r.not(S.BudgetAssignment, { budget }))
			.find({ budget, remaining })
	})

/** A read-only native budget/day ratio. CalendarDays is an interval measure,
 * not a UnixEpochDay coordinate. The host constructs these two finite measures;
 * native checked arithmetic performs money multiplication and rounding.
 */
export const suggestGross = (
	snapshot: Snapshot,
	business: Uuid,
	employee: Uuid,
	work: CivilDaySpan,
	payDay: UnixEpochDay,
	recordingDay: UnixEpochDay
) =>
	Effect.gen(function* () {
		yield* requirePayrollReady(snapshot, business, payDay > recordingDay ? payDay : recordingDay)
		const binding = (yield* relationRows(snapshot, S.PolicyBinding)).find((row) => row.business === business)
		const policy = (yield* relationRows(snapshot, S.GrossSuggestionPolicy)).find(
			(row) => row.release === binding?.release
		)
		const year = (yield* relationRows(snapshot, S.CalendarPeriod)).find(
			(row) =>
				row.release === binding?.release &&
				row.authority === "FederalDC" &&
				row.kind === "Year" &&
				row.span.start <= payDay &&
				row.span.end > payDay
		)
		if (!policy || !year)
			return yield* Effect.fail(
				new Refusal({
					code: "SuggestionPolicyMissing",
					message:
						"Install the reviewed suggestion policy and pay-year calendar, or supply an explicit gross amount"
				})
			)
		if (work.start < year.span.start || work.end > year.span.end)
			return yield* Effect.fail(
				new Refusal({
					code: "WorkYearBoundary",
					message: "A suggestion's work interval must stay within its canonical pay year"
				})
			)
		const workDays = countCalendarDays(work),
			remainingDays = countCalendarDays(civilDaySpan(work.start, epochDay(year.span.end)))
		const suggestion = query(S.ledger).rule((r) => {
			const { id: budget } = v(S.AnnualBudget),
				{ remaining } = v(remainingBudget)
			return r
				.match(S.AnnualBudget, { id: budget, employee, year: year.year })
				.match(S.Employee, { id: employee, business })
				.match(remainingBudget, { budget, remaining })
				.find({
					budget,
					remaining,
					gross: Compute.mulDiv(
						remaining,
						Compute.u64(workDays),
						Compute.u64(remainingDays),
						"nearestTiesAwayFromZero"
					)
				})
		})
		const result = (yield* rows(snapshot, suggestion, {}))[0]
		if (!result)
			return yield* Effect.fail(
				new Refusal({ code: "BudgetMissing", message: "No matching employee/year compensation budget" })
			)
		return {
			...result,
			policy: policy.id,
			evidence: policy.evidence,
			work,
			workDays,
			remainingDays,
			payDay,
			state: snapshot.stateStamp
		}
	})
