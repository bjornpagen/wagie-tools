import { query, type Uuid, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { bookkeepingReport } from "./bookkeeping.ts"
import { netCash } from "./calculations.ts"
import { type CivilDaySpan, periodSpan, type UnixEpochDay } from "./core/time.ts"
import { unsigned } from "./core/values.ts"
import { currentAssessments, currentTaxableWages, liabilityEntries, relationRows, rows } from "./queries.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"
import { workRegister } from "./work.ts"

const paidWages = query(S.ledger).rule((r) => {
	const wage = v(S.Wage)
	const { amount: cash } = v(netCash)
	return r
		.match(S.Wage, wage)
		.match(netCash, { wage: wage.id, amount: cash })
		.find({ ...wage, cash })
})

function totalBy<T>(values: readonly T[], key: (row: T) => string, amount: (row: T) => bigint) {
	const totals = new Map<string, bigint>()
	for (const row of values) totals.set(key(row), unsigned((totals.get(key(row)) ?? 0n) + amount(row)))
	return Object.fromEntries(totals)
}

/** One numerical/evidence selection shared by reports and immutable prepared
 * snapshots. Missing historical taxable-wage facts stay absent, not zero.
 */
export const periodFigures = (snapshot: Snapshot, business: Uuid, period: CivilDaySpan, employee?: Uuid) =>
	Effect.gen(function* () {
		const wages = (yield* rows(snapshot, paidWages, {})).filter(
			(row) =>
				row.business === business &&
				row.paidOn.start >= period.start &&
				row.paidOn.end <= period.end &&
				(employee === undefined || row.employee === employee)
		)
		const wageIds = new Set(wages.map((row) => row.id))
		const assessed = (yield* rows(snapshot, currentAssessments, {})).filter((row) => wageIds.has(row.wage))
		const deducted = (yield* relationRows(snapshot, S.Deduction)).filter((row) => wageIds.has(row.wage))
		const entries = (yield* rows(snapshot, liabilityEntries, {})).filter((row) => wageIds.has(row.wage))

		const taxable = (yield* rows(snapshot, currentTaxableWages, {})).filter((row) => wageIds.has(row.wage))
		const people = (yield* relationRows(snapshot, S.Employee)).filter(
			(row) => row.business === business && (employee === undefined || row.id === employee)
		)
		const employeeIds = new Set(people.map((row) => row.id))
		const relevantFilings = (yield* relationRows(snapshot, S.Filing)).filter(
			(row) => row.business === business && row.period.start < period.end && row.period.end > period.start
		)
		const filingIds = new Set(relevantFilings.map((row) => row.id))
		return {
			business,
			period,
			state: snapshot.stateStamp,
			wages,
			assessed,
			taxable,
			deducted,
			entries,
			recoveries: (yield* relationRows(snapshot, S.Recovery)).filter(
				(row) => wageIds.has(row.fromWage) || wageIds.has(row.owedOnWage)
			),
			budgets: (yield* relationRows(snapshot, S.AnnualBudget)).filter((row) => employeeIds.has(row.employee)),
			commitments: (yield* relationRows(snapshot, S.BudgetCommitment)).filter((row) =>
				employeeIds.has(row.employee)
			),
			formAdjustments: (yield* relationRows(snapshot, S.FormAdjustment)).filter((row) =>
				filingIds.has(row.filing)
			),
			totals: {
				wageCount: wages.length,
				gross: wages.reduce((sum, row) => unsigned(sum + row.gross), 0n),
				cash: wages.reduce((sum, row) => unsigned(sum + row.cash), 0n),
				assessed: totalBy(
					assessed,
					(row) => row.component,
					(row) => row.amount
				),
				taxable: totalBy(
					taxable,
					(row) => row.component,
					(row) => row.amount
				),
				deducted: totalBy(
					deducted,
					(row) => row.kind,
					(row) => row.amount
				)
			}
		}
	})

/** Reports never synchronize filings or calculate another completion state. */
export const report = (
	snapshot: Snapshot,
	business: Uuid,
	year: number,
	quarter: number | undefined,
	asOf: UnixEpochDay
) =>
	Effect.gen(function* () {
		const period = periodSpan(year, quarter === undefined ? "Year" : "Quarter", quarter ?? 1)
		return {
			...(yield* periodFigures(snapshot, business, period)),
			asOf,
			bookkeeping: yield* bookkeepingReport(snapshot, business, year),
			register: yield* workRegister(snapshot, business, asOf)
		}
	})
