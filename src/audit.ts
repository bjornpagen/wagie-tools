import { Effect } from "effect"
import { epochDay, periodSpan, toCalendarDate, type UnixEpochDay } from "./core/time.ts"
import { entityId, json } from "./core/values.ts"
import { entryKey } from "./deposits.ts"
import { liabilityEntries, relationRows, rows } from "./queries.ts"
import { paymentEquation } from "./reconciliation.ts"
import { recoveryEquation } from "./recoveries.ts"
import { periodFigures } from "./reports.ts"
import { fingerprint, type Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"
import { workRegister } from "./work.ts"

export const inventory = (snapshot: Snapshot) =>
	Effect.gen(function* () {
		const result: Record<string, readonly unknown[]> = {}
		for (const relation of Object.values(S.relations)) {
			if (relation.kind !== "relation") continue
			const facts = yield* relationRows(snapshot, relation)
			for (const fact of facts) {
				for (const [name, field] of Object.entries(relation.fields)) {
					const value: unknown = Object.entries(fact).find(([key]) => key === name)?.[1]
					if (field.kind === "uuid") entityId(String(value))
				}
			}
			result[relation.name] = [...facts].sort((a, b) => json(a).localeCompare(json(b)))
		}
		return result
	})

/** Audits authoritative facts and the same financial/register projections used
 * in admission. Open work is a result, not evidence of lost or corrupt data.
 */
export const auditLedger = (snapshot: Snapshot, asOf: UnixEpochDay) =>
	Effect.gen(function* () {
		const facts = yield* inventory(snapshot)
		const entries = yield* rows(snapshot, liabilityEntries, {})
		const byEntry = new Map(entries.map((row) => [entryKey(row), row]))
		const reconciliations = yield* relationRows(snapshot, S.PaymentReconciliation)
		const allocations = yield* relationRows(snapshot, S.PaymentAllocation)
		const adjustments = yield* relationRows(snapshot, S.PaymentAdjustment)
		const payments = yield* relationRows(snapshot, S.TaxPayment)
		const paymentAudit = payments.map((payment) => {
			const reconciliation = reconciliations.find((row) => row.payment === payment.id)
			const manifest = allocations.filter((row) => row.reconciliation === reconciliation?.id)
			const selected = manifest.map((row) => byEntry.get(entryKey(row)))
			return {
				payment: payment.id,
				reconciliation: reconciliation?.id,
				entries: manifest,
				adjustments: adjustments.filter((row) => row.reconciliation === reconciliation?.id),
				missingEntries: selected.filter((row) => row === undefined).length,
				...paymentEquation(
					payment.amount,
					selected.flatMap((row) => (row ? [row.amount] : [])),
					adjustments.filter((row) => row.reconciliation === reconciliation?.id).map((row) => row.amount)
				)
			}
		})
		const recoveries = yield* relationRows(snapshot, S.Recovery)
		const deductions = yield* relationRows(snapshot, S.Deduction)
		const recoveryAudit = deductions
			.filter((row) => row.kind === "Recovery")
			.map((row) => ({
				wage: row.wage,
				...recoveryEquation(
					row.amount,
					recoveries.filter((item) => item.fromWage === row.wage).map((item) => item.amount)
				)
			}))
		const businesses = yield* relationRows(snapshot, S.Business)
		const wages = yield* relationRows(snapshot, S.Wage)
		const reports = yield* Effect.forEach(
			businesses,
			(business) =>
				Effect.gen(function* () {
					const years = [
						...new Set(
							wages
								.filter((row) => row.business === business.id)
								.map((row) => toCalendarDate(epochDay(row.paidOn.start)).year)
						)
					].sort()
					const periods = yield* Effect.forEach(
						years,
						(year) =>
							Effect.gen(function* () {
								const annual = yield* periodFigures(snapshot, business.id, periodSpan(year, "Year"))
								const quarters = yield* Effect.forEach([1, 2, 3, 4], (quarter) =>
									periodFigures(snapshot, business.id, periodSpan(year, "Quarter", quarter))
								)
								return { year, annual, quarters }
							}),
						{ concurrency: 1 }
					)
					return {
						business: business.id,
						periods,
						register: yield* workRegister(snapshot, business.id, asOf)
					}
				}),
			{ concurrency: 1 }
		)
		return {
			state: snapshot.stateStamp,
			asOf,
			factsDigest: fingerprint(facts),
			counts: Object.fromEntries(Object.entries(facts).map(([name, rows]) => [name, rows.length])),
			paymentAudit,
			recoveryAudit,
			reports
		}
	})
