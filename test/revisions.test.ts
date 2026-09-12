import assert from "node:assert/strict"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { netCash } from "../src/calculations.ts"
import { civilDayPoint, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { currentAssessments, currentRevisions, liabilityEntries, rows } from "../src/queries.ts"
import { paymentEquation } from "../src/reconciliation.ts"
import { components } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { apply, bankForWage, withHistory, yearFacts } from "./native-history.ts"

test("assessment revisions preserve the wage, original allocation and signed financial differences", async () => {
	await withHistory((history) =>
		Effect.gen(function* () {
			const draft = yield* ChangeSet.builder(S.ledger)
			const calendar = yield* yearFacts(draft, 2026)
			const business = yield* mintId
			const employee = yield* mintId
			const wage = yield* mintId
			const commitment = yield* mintId
			const initial = yield* mintId
			const account = yield* mintId
			const accounts = [
				{ id: account, family: "Federal941" },
				{ id: yield* mintId, family: "Federal940" },
				{ id: yield* mintId, family: "TexasUnemployment" }
			] as const
			const evidence = "Synthetic revision qualification"
			const paidOn = civilDayPoint(parseCalendarDate("2026-06-15"))
			yield* draft.insert(S.Business, [
				{
					id: business,
					name: "Revision Test",
					ein: "00-0000001",
					state: "TX",
					timeZone: "America/Chicago",
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.Employee, [
				{
					id: employee,
					business,
					firstName: "Test",
					lastName: "Only",
					ssn: "000-00-0000",
					address: "Synthetic",
					filingStatus: "Single",
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.BudgetCommitment, [
				{ id: commitment, employee, year: 2026n, amount: 100000n, origin: "Regular", evidence }
			])
			yield* bankForWage(draft, wage, business, paidOn.start, 100000n)
			yield* draft.insert(S.Wage, [
				{
					requiresTransfer: true,
					id: wage,
					calendar,
					year: 2026n,
					business,
					employee,
					paidOn,
					commitment,
					gross: 100000n,
					initialRevision: initial,
					recordedAt: 0n
				}
			])
			yield* draft.insert(S.RegularCommitment, [{ commitment, wage }])
			yield* draft.insert(S.RegularWork, [{ wage, employee, span: periodSpan(2026, "Month", 6) }])
			yield* draft.insert(S.Deduction, [
				{ wage, employee, year: 2026n, kind: "FIT", amount: 20000n, evidence }
			])
			yield* draft.insert(
				S.TaxAccount,
				accounts.map((item) => ({ ...item, business, evidence }))
			)
			const chain = [initial, yield* mintId, yield* mintId]
			const amounts = [20000n, 22500n, 19500n]
			for (const [index, revision] of chain.entries()) {
				const amount = amounts[index]
				assert.ok(amount !== undefined)
				const set = yield* mintId
				yield* draft.insert(S.AssessmentSet, [
					{ id: set, business, employee, paidOn, gross: 100000n, origin: "Observed" }
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
						gross: 100000n,
						kind: index === 0 ? "Initial" : "Correction",
						recordedAt: BigInt(index)
					}
				])
				if (index > 0) {
					const predecessor = chain[index - 1]
					assert.ok(predecessor)
					yield* draft.insert(S.CorrectionAssessment, [{ revision, predecessor, wage, evidence }])
				}
				for (const component of components) {
					yield* draft.insert(S.Assessment, [
						{ set, component, origin: "Observed", method: "SuppliedAmount" }
					])
					yield* draft.insert(S.ObservedAssessment, [
						{ set, component, amount: component === "FIT" ? amount : 0n, evidence }
					])
				}
				yield* draft.insert(
					S.RevisionAccount,
					accounts.map((item) => ({ revision, account: item.id, business, family: item.family }))
				)
			}
			const payment = yield* mintId
			const reconciliation = yield* mintId
			yield* draft.insert(S.TaxPayment, [
				{ id: payment, business, account, sentOn: paidOn.start, amount: 20000n, evidence, recordedAt: 0n }
			])
			yield* draft.insert(S.PaymentReconciliation, [
				{ id: reconciliation, payment, business, account, period: paidOn, evidence, recordedAt: 0n }
			])
			yield* draft.insert(S.PaymentAllocation, [
				{ revision: initial, account, business, reconciliation, paidOn }
			])
			assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const entries = yield* rows(snapshot, liabilityEntries, {})
			assert.deepEqual(
				chain.map(
					(revision) => entries.find((row) => row.revision === revision && row.account === account)?.amount
				),
				[20000n, 2500n, -3000n]
			)
			assert.equal((yield* rows(snapshot, currentRevisions, {}))[0]?.id, chain[2])
			const assessments = yield* rows(snapshot, currentAssessments, {})
			assert.equal(assessments.length, 7)
			assert.equal(assessments.find((row) => row.component === "FIT")?.amount, 19500n)
			assert.deepEqual(yield* rows(snapshot, netCash, {}), [{ wage, amount: 80000n }])
			assert.equal(
				paymentEquation(
					20000n,
					[entries.find((row) => row.revision === initial && row.account === account)?.amount ?? -1n],
					[]
				).difference,
				0n
			)
			assert.deepEqual(paymentEquation(123457n, [123452n], [5n]), {
				observed: 123457n,
				liability: 123452n,
				adjustment: 5n,
				explained: 123457n,
				difference: 0n
			})
			assert.equal(paymentEquation(123457n, [123452n], []).difference, 5n)
		})
	)
})
