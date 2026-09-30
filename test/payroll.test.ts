import assert from "node:assert/strict"
import * as path from "node:path"
import { test } from "node:test"
import { ChangeSet, query, v } from "@bjornpagen/bumbledb"
import { Clock, Effect } from "effect"
import { netCash } from "../src/calculations.ts"
import { statementWriter } from "../src/commands.ts"
import { formatDollars } from "../src/core/boundary.ts"
import { civilDayPoint, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { MAX_U64, mintId } from "../src/core/values.ts"
import { ensureFilings } from "../src/filing-coverage.ts"
import { observedSetFacts } from "../src/observations.ts"
import { disposeLiability, reconcilePayments, recordPayment } from "../src/payments.ts"
import {
	CalculateInput,
	calculatePayroll,
	inspectCalculation,
	postPayroll,
	revisePayrollTax
} from "../src/payroll.ts"
import { installCalendarFacts } from "../src/policy/calendar.ts"
import { currentRevisions, liabilityEntries, relationRows, rows } from "../src/queries.ts"
import { recordRecovery, settlePaycheck } from "../src/recoveries.ts"
import { Ledger, latest, parseStrict } from "../src/runtime.ts"
import { components } from "../src/schema/vocabulary.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { assertRefusal as refusal, resultId } from "./assertions.ts"
import { apply, atTime, bankForWage, say, withHistory } from "./native-history.ts"
import { evidence, readyPayroll as ready } from "./payroll-fixture.ts"

const wageFacts = query(S.ledger).rule((r) => {
	const row = v(S.Wage)
	return r.match(S.Wage, row).find(row)
})
const commitmentFacts = query(S.ledger).rule((r) => {
	const row = v(S.BudgetCommitment)
	return r.match(S.BudgetCommitment, row).find(row)
})
const deductionFacts = query(S.ledger).rule((r) => {
	const row = v(S.Deduction)
	return r.match(S.Deduction, row).find(row)
})
const paymentFacts = query(S.ledger).rule((r) => {
	const row = v(S.TaxPayment)
	return r.match(S.TaxPayment, row).find(row)
})
const allocationFacts = query(S.ledger).rule((r) => {
	const row = v(S.PaymentAllocation)
	return r.match(S.PaymentAllocation, row).find(row)
})
const filingFacts = query(S.ledger).rule((r) => {
	const row = v(S.Filing)
	return r.match(S.Filing, row).find(row)
})
const electionUses = query(S.ledger).rule((r) => {
	const row = v(S.ElectionUse)
	return r.match(S.ElectionUse, row).find(row)
})
const recoveryRows = query(S.ledger).rule((r) => {
	const row = v(S.Recovery)
	return r.match(S.Recovery, row).find(row)
})

test("public payroll commands gate fresh posting, atomically cover W-2s, and revise tax without rewriting money", async () => {
	await withHistory((history, binding, directory) =>
		Effect.gen(function* () {
			const realClock = yield* Clock.Clock
			let now = Date.parse("2026-09-11T17:00:00Z")
			const clock: Clock.Clock = {
				currentTimeMillisUnsafe: () => now,
				currentTimeMillis: Effect.sync(() => now),
				currentTimeNanosUnsafe: () => BigInt(now) * 1000000n,
				currentTimeNanos: Effect.sync(() => BigInt(now) * 1000000n),
				monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: realClock.monotonicTimeNanos,
				sleep: (duration) => realClock.sleep(duration)
			}
			yield* Effect.gen(function* () {
				const fixture = yield* ready(history),
					{ business, employee } = fixture
				const initial = yield* latest
				const initialRegister = yield* workRegister(initial, business, parseCalendarDate("2026-09-11"))
				assert.deepEqual(initialRegister.blockers, [])
				assert.ok(initialRegister.readiness.some((row) => row.kind === "ElectionMissing"))
				const input = {
					request: yield* mintId,
					business,
					employee,
					purpose: {
						kind: "NewWage",
						paidOn: "2026-09-11",
						gross: "1000.00",
						roth: "0.00",
						work: { start: "2026-09-01", endExclusive: "2026-09-11" }
					},
					fit: { amount: "100.00", evidence },
					evidence
				}
				const calculate = yield* calculatePayroll(input),
					calculation = resultId(calculate, "calculation")
				assert.equal(calculate.stateAt.dataRevision, initial.stateStamp.dataRevision + 1n)
				const snapshot = yield* latest
				const figures = yield* inspectCalculation(snapshot, business, calculation)
				assert.equal(figures.amounts.length, 7)
				assert.equal(figures.amounts.find((row) => row.component === "SUTA")?.amount, 2700n)
				assert.equal((yield* rows(snapshot, wageFacts, {})).length, 0)
				assert.equal((yield* rows(snapshot, commitmentFacts, {})).length, 0)
				assert.equal((yield* rows(snapshot, liabilityEntries, {})).length, 0)
				assert.deepEqual(
					(yield* workRegister(snapshot, business, parseCalendarDate("2026-09-11"))).blockers,
					[]
				)
				const postInput = {
					evidence: "Synthetic posting approval and Mercury payment",
					settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "823.50" },
					request: yield* mintId,
					business,
					calculation
				}
				const posted = yield* postPayroll(postInput),
					wage = resultId(posted, "wage"),
					revision = resultId(posted, "revision")
				assert.deepEqual(
					yield* postPayroll(postInput),
					posted,
					"duplicate request resolves the original committed wage"
				)
				const postedView = yield* latest
				const originalWages = yield* rows(postedView, wageFacts, {}),
					originalCommitments = yield* rows(postedView, commitmentFacts, {}),
					originalDeductions = yield* rows(postedView, deductionFacts, {})
				assert.equal(originalWages.length, 1)
				assert.equal((yield* rows(postedView, netCash, {}))[0]?.amount, 82350n)
				const filingRows = yield* rows(postedView, filingFacts, {})
				assert.equal(filingRows.filter((row) => row.form === "W2SSA" || row.form === "W2Employee").length, 2)
				const account = fixture.accounts.find((row) => row.family === "Federal941")
				assert.ok(account)
				const paymentReceipt = yield* recordPayment({
					request: yield* mintId,
					business,
					account: account.id,
					amount: "253.00",
					sentOn: "2026-09-11",
					evidence,
					references: [{ issuer: "EFTPS", value: "once" }],
					artifacts: []
				})
				const payment = resultId(paymentReceipt, "payment")
				yield* reconcilePayments({
					request: yield* mintId,
					business,
					payments: [
						{
							payment,
							period: { start: "2026-09-01", endExclusive: "2026-10-01" },
							entries: [{ revision }],
							adjustments: [],
							evidence
						}
					],
					resolveIssues: []
				})
				const paidView = yield* latest,
					originalPayments = yield* rows(paidView, paymentFacts, {}),
					originalAllocations = yield* rows(paidView, allocationFacts, {})
				const corrected = yield* calculatePayroll({
					...input,
					request: yield* mintId,
					purpose: { kind: "TaxRevision", wage, predecessor: revision, sameDayBefore: [] },
					fit: { amount: "125.00", evidence }
				})
				yield* revisePayrollTax({
					request: yield* mintId,
					business,
					assessment: { kind: "Calculated", calculation: resultId(corrected, "calculation") }
				})
				const revised = yield* latest
				assert.deepEqual(yield* rows(revised, wageFacts, {}), originalWages)
				assert.deepEqual(yield* rows(revised, commitmentFacts, {}), originalCommitments)
				assert.deepEqual(yield* rows(revised, deductionFacts, {}), originalDeductions)
				assert.deepEqual(yield* rows(revised, paymentFacts, {}), originalPayments)
				assert.deepEqual(yield* rows(revised, allocationFacts, {}), originalAllocations)
				assert.equal((yield* rows(revised, currentRevisions, {})).length, 1)
				assert.deepEqual(
					(yield* rows(revised, liabilityEntries, {}))
						.filter((row) => row.family === "Federal941")
						.map((row) => row.amount)
						.sort(),
					[2500n, 25300n].sort()
				)
				const current = (yield* rows(revised, currentRevisions, {}))[0]
				assert.ok(current)
				const correctedFigures = yield* inspectCalculation(
					revised,
					business,
					resultId(corrected, "calculation")
				)
				yield* revisePayrollTax({
					request: yield* mintId,
					business,
					assessment: {
						kind: "Observed",
						wage,
						predecessor: current.id,
						figures: {
							amounts: Object.fromEntries(
								correctedFigures.amounts.map((row) => [
									row.component,
									formatDollars(row.component === "FIT" ? 13000n : row.amount)
								])
							),
							taxableWages: [],
							evidence
						}
					}
				})
				assert.deepEqual(yield* rows(yield* latest, wageFacts, {}), originalWages)

				const nextInput = {
					...input,
					request: yield* mintId,
					purpose: { ...input.purpose, work: { start: "2026-09-11", endExclusive: "2026-09-12" } }
				}
				const beforeMutation = yield* calculatePayroll(nextInput)
				const update = yield* ChangeSet.builder(S.ledger)
				const question = yield* mintId
				yield* update.insert(S.Question, [{ id: question, business, kind: "Review", detail: evidence }])
				yield* update.insert(S.EmployeeQuestion, [
					{ question, business, employee, year: 2026n, topic: "Synthetic" }
				])
				yield* apply(history, yield* update.finish())
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "823.50" },
							request: yield* mintId,
							business,
							calculation: resultId(beforeMutation, "calculation")
						})
					),
					"CalculationStale"
				)
				const beforeMidnight = yield* calculatePayroll({ ...nextInput, request: yield* mintId })
				now = Date.parse("2026-09-12T17:00:00Z")
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "823.50" },
							request: yield* mintId,
							business,
							calculation: resultId(beforeMidnight, "calculation")
						})
					),
					"CalculationStale"
				)

				// The calculation may be made for September in October, but public posting
				// evaluates the shared gate at October's recording day, never just the pay date.
				now = Date.parse("2026-10-02T17:00:00Z")
				const backdated = yield* calculatePayroll({ ...nextInput, request: yield* mintId })
				const gate = yield* workRegister(yield* latest, business, parseCalendarDate("2026-10-02"))
				assert.ok(gate.blockers.some((row) => row.kind === "Filing"))
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "823.50" },
							request: yield* mintId,
							business,
							calculation: resultId(backdated, "calculation")
						})
					),
					"PayrollBlocked"
				)
				assert.deepEqual(yield* rows(yield* latest, wageFacts, {}), originalWages)
				const originalPayment = originalPayments[0]
				assert.ok(originalPayment)
				const inconsistent = yield* ChangeSet.builder(S.ledger)
				yield* inconsistent.delete(S.TaxPayment, [originalPayment])
				yield* inconsistent.insert(S.TaxPayment, [
					{ ...originalPayment, amount: originalPayment.amount + 1n }
				])
				assert.equal((yield* apply(history, yield* inconsistent.finish())).outcome.kind, "committed")
				const invalidRegister = yield* workRegister(yield* latest, business, parseCalendarDate("2026-10-02"))
				assert.ok(
					invalidRegister.blockers.some((row) => row.subject === payment && row.kind === "Reconciliation")
				)
				assert.ok(
					invalidRegister.work.some(
						(row) => row.kind === "Payment" && row.label.startsWith("Federal941") && row.amount === 28300n
					),
					"an inconsistent manifest cannot settle any of its entries"
				)
			}).pipe(Effect.provideService(Clock.Clock, clock))
		}).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})

test("automatic recovery collects the ledger debt and preserves actual historical attribution", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-11T17:00:00Z"),
			Effect.gen(function* () {
				const { business, employee } = yield* ready(history)
				const input = {
					request: yield* mintId,
					business,
					employee,
					purpose: {
						kind: "NewWage",
						paidOn: "2026-09-11",
						gross: "1000.00",
						roth: "0.00",
						work: { start: "2026-09-01", endExclusive: "2026-09-05" }
					},
					fit: { amount: "0.00", evidence },
					evidence
				}
				const wage = resultId(
					yield* postPayroll({
						evidence: "Synthetic posting approval and Mercury payment",
						settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "923.50" },
						request: yield* mintId,
						business,
						calculation: resultId(yield* calculatePayroll(input), "calculation")
					}),
					"wage"
				)
				const original = (yield* rows(yield* latest, deductionFacts, {})).find(
					(row) => row.wage === wage && row.kind === "SocialSecurity"
				)
				assert.ok(original)
				// A historical observation may have withheld less than the assessed amount.
				const observed = yield* ChangeSet.builder(S.ledger)
				yield* observed.delete(S.Deduction, [original])
				yield* observed.insert(S.Deduction, [{ ...original, amount: original.amount - 1000n }])
				assert.equal((yield* apply(history, yield* observed.finish())).outcome.kind, "committed")
				const recovery = { owedOnWage: wage, component: "EmployeeSS", amount: "10.00", evidence }
				const next = {
					...input,
					request: yield* mintId,
					purpose: {
						...input.purpose,
						work: { start: "2026-09-05", endExclusive: "2026-09-11" }
					}
				}
				const calculation = resultId(
					yield* calculatePayroll({
						...next,
						request: yield* mintId,
						purpose: next.purpose
					}),
					"calculation"
				)
				const collecting = resultId(
					yield* postPayroll({
						evidence: "Synthetic posting approval and Mercury payment",
						settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "913.50" },
						request: yield* mintId,
						business,
						calculation
					}),
					"wage"
				)
				const snapshot = yield* latest
				const attribution = (yield* rows(snapshot, recoveryRows, {}))[0]
				assert.ok(attribution)
				assert.equal(attribution.fromWage, collecting)
				assert.equal(attribution.owedOnWage, wage)
				assert.equal(
					(yield* rows(snapshot, netCash, {})).find((row) => row.wage === collecting)?.amount,
					91350n
				)
				assert.ok(
					!(yield* workRegister(snapshot, business, parseCalendarDate("2026-09-11"))).readiness.some(
						(row) => row.kind === "EmployeeTaxOwed"
					)
				)
				for (const change of [
					{ ...attribution, amount: 1001n },
					{ ...attribution, kind: "FIT" as const },
					{ ...attribution, component: "FUTA" as const }
				]) {
					const draft = yield* ChangeSet.builder(S.ledger)
					yield* draft.delete(S.Recovery, [attribution])
					yield* draft.insert(S.Recovery, [change])
					assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "invariant-rejected")
				}
				const unassigned = yield* ChangeSet.builder(S.ledger)
				yield* unassigned.delete(S.Recovery, [attribution])
				assert.equal((yield* apply(history, yield* unassigned.finish())).outcome.kind, "committed")
				assert.ok(
					(yield* workRegister(yield* latest, business, parseCalendarDate("2026-09-11"))).readiness.some(
						(row) => row.kind === "RecoveryUnattributed"
					)
				)
				refusal(
					yield* Effect.result(
						recordRecovery({
							request: yield* mintId,
							business,
							wage: collecting,
							recoveries: [{ ...recovery, amount: "9.99" }],
							evidence
						})
					),
					"RecoveryReconciliation"
				)
				yield* recordRecovery({
					request: yield* mintId,
					business,
					wage: collecting,
					recoveries: [recovery],
					evidence
				})
				assert.deepEqual(yield* rows(yield* latest, netCash, {}), yield* rows(snapshot, netCash, {}))
			}).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
	)
})

test("native payroll admission rejects mismatched days, years, deductions, overlapping work and excess deferrals", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-11T17:00:00Z"),
			Effect.gen(function* () {
				const fixture = yield* ready(history),
					{ business, employee, release, calendar } = fixture
				const rules = yield* ChangeSet.builder(S.ledger),
					policy = yield* mintId,
					allowance = yield* mintId,
					election = yield* mintId
				yield* rules.insert(S.DeferralPolicy, [
					{ id: policy, release, year: 2026n, limit: 2400000n, evidence: say(evidence) }
				])
				yield* rules.insert(S.EmployeeAllowance, [
					{
						id: allowance,
						employee,
						year: 2026n,
						policy,
						maximum: 2400000n,
						limit: 2000000n,
						evidence: say(evidence)
					}
				])
				yield* rules.insert(S.Election, [
					{
						id: election,
						employee,
						year: 2026n,
						calendar,
						allowance,
						maximum: 2000000n,
						signedOn: parseCalendarDate("2026-09-01"),
						effective: periodSpan(2026, "Year"),
						limit: 2000000n,
						evidence: say(evidence)
					}
				])

				const plan = yield* mintId,
					document = yield* mintId,
					artifact = yield* mintId,
					annual = yield* mintId
				yield* rules.insert(S.Owner, [{ business, employee, evidence: say(evidence) }])
				yield* rules.insert(S.RetirementPlan, [
					{
						id: plan,
						business,
						employee,
						name: "Synthetic Plan",
						ein: "00-0000020",
						evidence: say(evidence)
					}
				])
				yield* rules.insert(S.RetirementAnnual, [
					{
						id: annual,
						plan,
						employee,
						year: 2026n,
						valid: periodSpan(2026, "Year"),
						deferralLimit: 2400000n,
						additionsLimit: 7000000n,
						compensationCap: 35000000n,
						outsideDeferrals: 0n,
						outsideAdditions: 0n,
						otherPlans: false,
						outsideAssets: false,
						evidence: say(evidence)
					}
				])
				yield* rules.insert(S.Artifact, [
					{ id: artifact, sha256: "synthetic-election", mediaType: "application/pdf" }
				])
				yield* rules.insert(S.VerifiedArtifact, [{ artifact, length: 1n }])
				yield* rules.insert(S.ElectionDocument, [
					{
						id: document,
						employee,
						year: 2026n,
						signedOn: parseCalendarDate("2026-09-01"),
						artifact,
						evidence: say(evidence)
					}
				])
				yield* rules.insert(S.ElectionDocumentAmount, [
					{ document, kind: "Roth", amount: 2000000n },
					{ document, kind: "Traditional", amount: 0n },
					{ document, kind: "OptionalAfterTax", amount: 0n },
					{ document, kind: "EmployerProfitSharing", amount: 0n }
				])
				yield* rules.insert(S.ElectionSource, [
					{
						election,
						document,
						annual,
						employee,
						year: 2026n,
						signedOn: parseCalendarDate("2026-09-01"),
						kind: "Roth",
						limit: 2000000n
					}
				])
				assert.equal((yield* apply(history, yield* rules.finish())).outcome.kind, "committed")
				const input = {
					request: yield* mintId,
					business,
					employee,
					purpose: {
						kind: "NewWage",
						paidOn: "2026-09-11",
						gross: "10000.00",
						roth: "1000.00",
						work: { start: "2026-09-01", endExclusive: "2026-09-11" }
					},
					fit: { amount: "0.00", evidence },
					evidence
				}
				const calculated = yield* calculatePayroll(input)
				yield* postPayroll({
					evidence: "Synthetic posting approval and Mercury payment",
					settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "8235.00" },
					request: yield* mintId,
					business,
					calculation: resultId(calculated, "calculation")
				})
				const snapshot = yield* latest,
					originalWages = yield* rows(snapshot, wageFacts, {}),
					deductions = yield* rows(snapshot, deductionFacts, {}),
					uses = yield* rows(snapshot, electionUses, {})
				const deduction = deductions.find((row) => row.kind === "Roth"),
					use = uses[0]
				assert.ok(deduction && use)
				for (const corrupt of [
					"deductionYear",
					"deductionAmount",
					"electionDay",
					"electionAmount"
				] as const) {
					const draft = yield* ChangeSet.builder(S.ledger)
					if (corrupt === "deductionYear" || corrupt === "deductionAmount") {
						yield* draft.delete(S.Deduction, [deduction])
						yield* draft.insert(S.Deduction, [
							{ ...deduction, ...(corrupt === "deductionYear" ? { year: 2025n } : { amount: 1000001n }) }
						])
					} else {
						yield* draft.delete(S.ElectionUse, [use])
						yield* draft.insert(S.ElectionUse, [
							{
								...use,
								...(corrupt === "electionDay"
									? { day: { start: use.day.start - 1n, end: use.day.end - 1n } }
									: { amount: use.amount - 1n })
							}
						])
					}
					assert.equal(
						(yield* apply(history, yield* draft.finish())).outcome.kind,
						"invariant-rejected",
						corrupt
					)
					assert.deepEqual((yield* latest).stateStamp, snapshot.stateStamp)
				}

				const pending = yield* workRegister(yield* latest, business, parseCalendarDate("2026-09-11"))
				assert.ok(pending.blockers.some((r) => r.id.startsWith("roth-remittance/")))
				const receiptDraft = yield* ChangeSet.builder(S.ledger),
					account = yield* mintId,
					operation = yield* mintId,
					receipt = yield* mintId,
					movement = yield* mintId,
					allocation = yield* mintId
				const contribution = (yield* relationRows(yield* latest, S.RetirementContribution))[0]
				assert.ok(contribution)
				yield* receiptDraft.insert(S.PlanAccount, [
					{
						id: account,
						plan,
						kind: "Roth",
						provider: "Synthetic",
						reference: "roth-paid",
						evidence: say(evidence)
					}
				])
				yield* receiptDraft.insert(S.ProviderOperation, [
					{ id: operation, plan, provider: "Synthetic", reference: "receipt-paid", evidence: say(evidence) }
				])
				yield* receiptDraft.insert(S.BankMovement, [
					{
						id: movement,
						business,
						direction: "Outflow",
						paidOn: parseCalendarDate("2026-09-11"),
						amount: 100000n,
						evidence: say(evidence)
					}
				])
				yield* receiptDraft.insert(S.MercuryTransaction, [
					{ movement, reference: "synthetic-roth-remittance" }
				])
				// Option B: the withheld Roth has left the business once its Mercury
				// receipt is attached; the provider's confirmation is only a reminder.
				const receiptArtifact = yield* mintId,
					observation = yield* mintId
				yield* receiptDraft.insert(S.Artifact, [
					{ id: receiptArtifact, sha256: "1".repeat(64), mediaType: "application/pdf" }
				])
				yield* receiptDraft.insert(S.BankObservation, [
					{
						id: observation,
						business,
						artifact: receiptArtifact,
						row: 1n,
						status: "Sent",
						observedOn: parseCalendarDate("2026-09-11"),
						amount: 100000n,
						evidence: say(evidence)
					}
				])
				yield* receiptDraft.insert(S.BankSource, [{ movement, observation, business }])
				yield* receiptDraft.insert(S.CashAllocation, [
					{
						id: allocation,
						movement,
						business,
						purpose: "RothRemittance",
						amount: 100000n,
						evidence: say(evidence)
					}
				])
				yield* receiptDraft.insert(S.ContributionFunding, [
					{
						contribution: contribution.id,
						allocation,
						business,
						source: "EmployeeRothDeferral",
						amount: 100000n
					}
				])
				yield* receiptDraft.insert(S.PlanReceipt, [
					{
						id: receipt,
						plan,
						operation,
						account,
						source: "EmployeeRothDeferral",
						year: 2026n,
						observedOn: parseCalendarDate("2026-09-11"),
						amount: 100000n,
						evidence: say(evidence)
					}
				])
				yield* receiptDraft.insert(S.ReceiptAllocation, [
					{ receipt, contribution: contribution.id, plan, amount: 100000n }
				])
				assert.equal((yield* apply(history, yield* receiptDraft.finish())).outcome.kind, "committed")
				const overlap = yield* calculatePayroll({ ...input, request: yield* mintId })
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "8235.00" },
							request: yield* mintId,
							business,
							calculation: resultId(overlap, "calculation")
						})
					),
					"invariant-rejected"
				)
				const excess = yield* calculatePayroll({
					...input,
					request: yield* mintId,
					purpose: {
						...input.purpose,
						gross: "30000.00",
						roth: "20000.00",
						work: { start: "2026-09-11", endExclusive: "2026-09-12" }
					}
				})
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "8235.00" },
							request: yield* mintId,
							business,
							calculation: resultId(excess, "calculation")
						})
					),
					"ContributionCapacity"
				)
				const trigger = yield* calculatePayroll({
					...input,
					request: yield* mintId,
					purpose: {
						...input.purpose,
						gross: "100000.00",
						roth: "0.00",
						work: { start: "2026-09-11", endExclusive: "2026-09-12" }
					},
					fit: { amount: "90000.00", evidence }
				})
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "8235.00" },
							request: yield* mintId,
							business,
							calculation: resultId(trigger, "calculation")
						})
					),
					"DepositRegimeUnsupported"
				)
				refusal(
					yield* Effect.result(
						calculatePayroll({
							...input,
							request: yield* mintId,
							purpose: { ...input.purpose, gross: "200000.00" }
						})
					),
					"WageRangeUnsupported"
				)
				assert.deepEqual(yield* rows(yield* latest, wageFacts, {}), originalWages)
			})
		).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})

test("a settled earlier-month or prior-year federal trigger survives a later tax decrease", async () => {
	for (const historicalYear of [2025, 2026])
		await withHistory((history, binding, directory) =>
			atTime(
				Date.parse("2026-09-11T17:00:00Z"),
				Effect.gen(function* () {
					const fixture = yield* ready(history),
						{ business, employee, release } = fixture
					const draft = yield* ChangeSet.builder(S.ledger)
					const federal = fixture.accounts.find((row) => row.family === "Federal941")
					assert.ok(federal)
					let calendar = fixture.calendar
					if (historicalYear === 2025) {
						const expansion = yield* installCalendarFacts(draft, statementWriter(draft), release, {
							authority: "FederalDC",
							fromYear: 2025,
							throughYear: 2025,
							holidays: [],
							evidence
						})
						const year = expansion.periods.find((row) => row.kind === "Year"),
							month = expansion.periods.find((row) => row.kind === "Month" && row.ordinal === 8n)
						assert.ok(year && month)
						calendar = year.id
						const policy = yield* mintId
						yield* draft.insert(S.DepositPolicy, [
							{
								id: policy,
								release,
								business,
								account: federal.id,
								family: "Federal941",
								periodKind: "Month",
								authority: "FederalDC",
								dueRule: "FollowingMonth15",
								valid: month.span,
								evidence: say(evidence)
							}
						])
						yield* draft.insert(
							S.DepositTrigger,
							S.CheckpointKind.handles.map((kind) => ({
								policy,
								kind,
								actionable: { start: 1n, end: MAX_U64 }
							}))
						)
						yield* draft.insert(S.DepositCheckpoint, [
							{
								id: yield* mintId,
								policy,
								business,
								account: federal.id,
								calendar: month.id,
								periodKind: "Month",
								span: month.span,
								year: 2025n,
								kind: "Interim",
								opensOn: month.span.end,
								dueOn: month.span.end + 14n,
								evidence: say(evidence)
							}
						])
					}
					const paidOn = civilDayPoint(parseCalendarDate(`${historicalYear}-08-01`)),
						wage = yield* mintId,
						commitment = yield* mintId,
						revision = yield* mintId,
						set = yield* mintId
					yield* draft.insert(S.BudgetCommitment, [
						{
							id: commitment,
							employee,
							year: BigInt(historicalYear),
							amount: 10000000n,
							origin: "Regular",
							evidence: say(evidence)
						}
					])
					yield* draft.insert(S.RegularCommitment, [{ commitment, wage }])
					if (historicalYear === 2026) {
						const budget = (yield* relationRows(yield* latest, S.AnnualBudget))[0]
						assert.ok(budget)
						yield* draft.insert(S.BudgetAssignment, [
							{ commitment, budget: budget.id, employee, year: 2026n, amount: 10000000n }
						])
					}
					yield* observedSetFacts(
						draft,
						statementWriter(draft),
						{ id: set, business, employee, paidOn, gross: 10000000n, origin: "Observed" },
						{
							amounts: {
								FIT: 10000000n,
								EmployeeSS: 0n,
								EmployerSS: 0n,
								EmployeeMedicare: 0n,
								EmployerMedicare: 0n,
								FUTA: 0n,
								SUTA: 0n
							},
							taxableWages: [],
							evidence
						}
					)
					yield* bankForWage(draft, wage, business, paidOn.start, 10000000n)
					yield* draft.insert(S.Wage, [
						{
							requiresTransfer: true,
							id: wage,
							business,
							employee,
							year: BigInt(historicalYear),
							calendar,
							paidOn,
							commitment,
							gross: 10000000n,
							initialRevision: revision
						}
					])
					yield* draft.insert(S.RegularWork, [{ wage, employee, span: paidOn }])
					yield* draft.insert(S.AssessmentRevision, [
						{
							id: revision,
							wage,
							set,
							business,
							employee,
							paidOn,
							gross: 10000000n,
							kind: "Initial"
						}
					])
					yield* draft.insert(
						S.RevisionAccount,
						fixture.accounts.map((account) => ({
							revision,
							business,
							account: account.id,
							family: account.family
						}))
					)
					const payment = yield* mintId,
						reconciliation = yield* mintId
					yield* draft.insert(S.TaxPayment, [
						{
							id: payment,
							business,
							account: federal.id,
							sentOn: paidOn.start + 1n,
							amount: 10000000n,
							evidence: say(evidence)
						}
					])
					yield* draft.insert(S.PaymentReconciliation, [
						{
							id: reconciliation,
							payment,
							business,
							account: federal.id,
							period: periodSpan(historicalYear, "Year"),
							evidence: say(evidence)
						}
					])
					yield* draft.insert(S.PaymentAllocation, [
						{ revision, business, account: federal.id, reconciliation, paidOn }
					])
					assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
					yield* ensureFilings({ request: yield* mintId, business, throughYear: 2026 })
					const revised = yield* revisePayrollTax({
						request: yield* mintId,
						business,
						assessment: {
							kind: "Observed",
							wage,
							predecessor: revision,
							figures: {
								amounts: Object.fromEntries(components.map((component) => [component, "0.00"])),
								taxableWages: [],
								evidence
							}
						}
					})
					yield* disposeLiability({
						request: yield* mintId,
						business,
						revision: resultId(revised, "revision"),
						account: federal.id,
						disposition: "Credited",
						evidence
					})
					assert.deepEqual(
						(yield* workRegister(yield* latest, business, parseCalendarDate("2026-09-11"))).blockers,
						[]
					)
					const calculated = yield* calculatePayroll({
						request: yield* mintId,
						business,
						employee,
						purpose: {
							kind: "NewWage",
							paidOn: "2026-09-11",
							gross: "1000.00",
							roth: "0.00",
							work: { start: "2026-09-01", endExclusive: "2026-09-11" }
						},
						fit: { amount: "0.00", evidence },
						evidence
					})
					refusal(
						yield* Effect.result(
							postPayroll({
								evidence: "Synthetic posting approval and Mercury payment",
								settlement: {
									kind: "Bank",
									reference: yield* mintId,
									paidOn: "2026-09-11",
									amount: "823.50"
								},
								request: yield* mintId,
								business,
								calculation: resultId(calculated, "calculation")
							})
						),
						"DepositRegimeUnsupported"
					)
				})
			).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
})

test("partial automatic FICA recovery posts a true zero-transfer wage and never collects twice", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse("2026-09-11T17:00:00Z"),
			Effect.gen(function* () {
				const { business, employee } = yield* ready(history)
				const input = {
					request: yield* mintId,
					business,
					employee,
					purpose: {
						kind: "NewWage",
						paidOn: "2026-09-11",
						gross: "1000.00",
						roth: "0.00",
						work: { start: "2026-09-01", endExclusive: "2026-09-02" }
					},
					fit: { amount: "0.00", evidence },
					evidence
				}
				const originalWage = resultId(
					yield* postPayroll({
						evidence: "Synthetic posting approval and Mercury payment",
						request: yield* mintId,
						business,
						calculation: resultId(yield* calculatePayroll(input), "calculation"),
						settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "923.50" }
					}),
					"wage"
				)
				const original = (yield* relationRows(yield* latest, S.Deduction)).find(
					(row) => row.wage === originalWage && row.kind === "SocialSecurity"
				)
				assert.ok(original)
				const observation = yield* ChangeSet.builder(S.ledger)
				yield* observation.delete(S.Deduction, [original])
				yield* observation.insert(S.Deduction, [{ ...original, amount: original.amount - 1000n }])
				assert.equal((yield* apply(history, yield* observation.finish())).outcome.kind, "committed")
				const before = yield* latest
				const priorTax = yield* rows(before, liabilityEntries, {})
				const beforeBank = yield* relationRows(before, S.BankMovement)
				const small = {
					...input,
					request: yield* mintId,
					purpose: {
						...input.purpose,
						gross: "10.00",
						work: { start: "2026-09-02", endExclusive: "2026-09-03" }
					}
				}
				const calculation = resultId(yield* calculatePayroll(small), "calculation")
				const preview = yield* inspectCalculation(yield* latest, business, calculation)
				assert.equal(preview.paycheck?.recovery, 923n)
				assert.equal(preview.paycheck?.cash, 0n)
				assert.equal(preview.input.gross, 1000n)
				assert.ok(preview.paycheck)
				assert.throws(() => settlePaycheck(1000n, 77n, 1n, preview.paycheck?.recoveries ?? []), {
					code: "InsufficientNetForRoth"
				})
				assert.throws(() =>
					parseStrict(CalculateInput, { ...small, purpose: { ...small.purpose, recoveries: [] } })
				)
				const post = {
					request: yield* mintId,
					business,
					calculation,
					evidence: "Synthetic zero-transfer posting",
					settlement: { kind: "NoTransfer" }
				}
				const receipt = yield* postPayroll(post)
				const wage = resultId(receipt, "wage")
				assert.deepEqual(yield* postPayroll(post), receipt)
				const after = yield* latest
				assert.deepEqual(yield* relationRows(after, S.BankMovement), beforeBank)
				assert.equal((yield* rows(after, netCash, {})).find((row) => row.wage === wage)?.amount, 0n)
				assert.deepEqual(
					(yield* rows(after, liabilityEntries, {})).filter((row) => row.wage === originalWage),
					priorTax.filter((row) => row.wage === originalWage)
				)
				const bankOnNoTransfer = yield* ChangeSet.builder(S.ledger)
				assert.ok(beforeBank[0])
				yield* bankOnNoTransfer.insert(S.PayrollTransaction, [{ wage, business, movement: beforeBank[0].id }])
				assert.equal(
					(yield* apply(history, yield* bankOnNoTransfer.finish())).outcome.kind,
					"invariant-rejected"
				)
				const next = {
					...input,
					request: yield* mintId,
					purpose: { ...input.purpose, work: { start: "2026-09-03", endExclusive: "2026-09-04" } }
				}
				const nextCalc = resultId(yield* calculatePayroll(next), "calculation")
				const remainder = yield* inspectCalculation(yield* latest, business, nextCalc)
				assert.equal(remainder.paycheck?.recovery, 77n)
				assert.equal(remainder.paycheck?.cash, 92273n)
				refusal(
					yield* Effect.result(
						postPayroll({
							evidence: "Synthetic posting approval and Mercury payment",
							request: yield* mintId,
							business,
							calculation: nextCalc,
							settlement: { kind: "NoTransfer" }
						})
					),
					"PayrollTransferRequired"
				)
				yield* postPayroll({
					evidence: "Synthetic posting approval and Mercury payment",
					request: yield* mintId,
					business,
					calculation: nextCalc,
					settlement: { kind: "Bank", reference: yield* mintId, paidOn: "2026-09-11", amount: "922.73" }
				})
				const finalCalc = resultId(
					yield* calculatePayroll({
						...input,
						request: yield* mintId,
						purpose: { ...input.purpose, work: { start: "2026-09-04", endExclusive: "2026-09-05" } }
					}),
					"calculation"
				)
				assert.equal((yield* inspectCalculation(yield* latest, business, finalCalc)).paycheck?.recovery, 0n)
				assert.equal(
					(yield* relationRows(yield* latest, S.Recovery)).reduce((n, row) => n + row.amount, 0n),
					1000n
				)
			}).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
	)
})
