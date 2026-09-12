import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, query, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { civilDayPoint, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { reconcilePayments, recordPayment } from "../src/payments.ts"
import { rows } from "../src/queries.ts"
import { Ledger } from "../src/runtime.ts"
import { components } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { apply, bankForWage, withHistory, yearFacts } from "./native-history.ts"

const payments = query(S.ledger).rule((r) => {
	const row = v(S.TaxPayment)
	return r.match(S.TaxPayment, row).find(row)
})
const allocations = query(S.ledger).rule((r) => {
	const row = v(S.PaymentAllocation)
	return r.match(S.PaymentAllocation, row).find(row)
})
const reconciliations = query(S.ledger).rule((r) => {
	const row = v(S.PaymentReconciliation)
	return r.match(S.PaymentReconciliation, row).find(row)
})

test("payment commands deduplicate external events, expose conflicts, and exactly reconcile immutable money", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const draft = yield* ChangeSet.builder(S.ledger)
			const calendar = yield* yearFacts(draft, 2026)
			const business = yield* mintId,
				employee = yield* mintId,
				wage = yield* mintId,
				commitment = yield* mintId,
				revision = yield* mintId,
				set = yield* mintId
			const evidence = "Synthetic payment qualification"
			const paidOn = civilDayPoint(parseCalendarDate("2026-06-15"))
			const accounts = yield* Effect.forEach(S.AccountFamily.handles, (family) =>
				mintId.pipe(Effect.map((id) => ({ id, business, family, evidence })))
			)
			const account = accounts.find((row) => row.family === "Federal941")?.id
			assert.ok(account)
			yield* draft.insert(S.Business, [
				{
					id: business,
					name: "Synthetic",
					ein: "00-0000089",
					state: "TX",
					timeZone: "America/Chicago",
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.Employee, [
				{
					id: employee,
					business,
					firstName: "Synthetic",
					lastName: "Only",
					ssn: "000-00-0000",
					address: evidence,
					filingStatus: "Single",
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.TaxAccount, accounts)
			yield* draft.insert(S.BudgetCommitment, [
				{ id: commitment, employee, year: 2026n, amount: 200000n, origin: "Regular", evidence }
			])
			yield* draft.insert(S.RegularCommitment, [{ commitment, wage }])
			yield* draft.insert(S.RegularWork, [{ wage, employee, span: periodSpan(2026, "Month", 6) }])
			yield* bankForWage(draft, wage, business, paidOn.start, 200000n)
			yield* draft.insert(S.Wage, [
				{
					requiresTransfer: true,
					id: wage,
					calendar,
					year: 2026n,
					employee,
					business,
					paidOn,
					commitment,
					gross: 200000n,
					initialRevision: revision,
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.AssessmentSet, [
				{ id: set, business, employee, paidOn, gross: 200000n, origin: "Observed" }
			])
			yield* draft.insert(S.ObservedSet, [{ set, evidence }])
			yield* draft.insert(S.AssessmentRevision, [
				{
					id: revision,
					wage,
					set,
					business,
					employee,
					paidOn,
					gross: 200000n,
					kind: "Initial",
					recordedAt: 0n
				}
			])
			yield* draft.insert(
				S.RevisionAccount,
				accounts.map((row) => ({ revision, account: row.id, business, family: row.family }))
			)
			for (const component of components) {
				yield* draft.insert(S.Assessment, [{ set, component, origin: "Observed", method: "SuppliedAmount" }])
				yield* draft.insert(S.ObservedAssessment, [
					{ set, component, amount: component === "FIT" ? 123452n : 0n, evidence }
				])
			}
			assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
			const payload = {
				request: yield* mintId,
				business,
				account,
				amount: "123457",
				sentOn: "2026-09-10",
				evidence,
				references: [
					{ issuer: "EFTPS", scope: "Synthetic account", value: "SYNTHETIC-ACK", sourceText: evidence }
				],
				artifacts: [],
				settlement: { settlesOn: "2026-09-11", evidence }
			}
			const first = yield* recordPayment(payload)
			assert.equal(first.outcome.kind, "committed")
			const repeated = yield* recordPayment({ ...payload, request: yield* mintId })
			assert.equal(repeated.outcome.kind, "no-change")
			let snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const payment = (yield* rows(snapshot, payments, {}))[0]
			assert.ok(payment)
			assert.equal((yield* rows(snapshot, payments, {})).length, 1)
			const conflict = yield* recordPayment({ ...payload, request: yield* mintId, amount: "163058" })
			assert.equal(conflict.outcome.kind, "committed")
			assert.ok(conflict.outcome.kind === "committed")
			const issue = conflict.outcome.result.issue
			assert.equal(typeof issue, "string")
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const open = yield* workRegister(snapshot, business, parseCalendarDate("2026-09-10"))
			assert.ok(open.blockers.some((row) => row.id === payment.id && row.action === "payment reconcile"))
			assert.ok(open.blockers.some((row) => row.id === issue))
			const period = { start: "2026-04-01", end: "2026-07-01" }
			const attribution = { payment: payment.id, period, evidence, entries: [{ revision }], adjustments: [] }
			const wrong = yield* Effect.result(
				reconcilePayments({ request: yield* mintId, business, payments: [attribution], resolveIssues: [] })
			)
			assert.equal(wrong._tag, "Failure")
			assert.deepEqual(
				(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
				snapshot.stateStamp
			)
			const reconciliationInput = {
				request: yield* mintId,
				business,
				payments: [{ ...attribution, adjustments: [{ amount: "5", period, evidence }] }],
				resolveIssues: [issue]
			}
			const accepted = yield* reconcilePayments(reconciliationInput)
			assert.equal(accepted.outcome.kind, "committed")
			assert.deepEqual(yield* reconcilePayments(reconciliationInput), accepted)
			snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.deepEqual(
				yield* rows(snapshot, payments, {}),
				[payment],
				"actual amount and dates stay unchanged"
			)
			const cleared = yield* workRegister(snapshot, business, parseCalendarDate("2026-09-10"))
			assert.ok(!cleared.blockers.some((row) => row.kind === "Reconciliation"))
			const allocation = (yield* rows(snapshot, allocations, {}))[0]
			const reconciliation = (yield* rows(snapshot, reconciliations, {}))[0]
			assert.ok(allocation && reconciliation)
			const invalid = yield* ChangeSet.builder(S.ledger)
			yield* invalid.delete(S.PaymentReconciliation, [reconciliation])
			yield* invalid.insert(S.PaymentReconciliation, [
				{ ...reconciliation, period: periodSpan(2026, "Quarter", 1) }
			])
			assert.equal(
				(yield* apply(history, yield* invalid.finish())).outcome.kind,
				"invariant-rejected",
				"native ownership rejects an allocation in another quarter"
			)
			const malformed = yield* Effect.exit(
				recordPayment({ ...payload, request: yield* mintId, unexpected: true })
			)
			assert.equal(malformed._tag, "Failure", "structured commands reject unknown keys")
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})
