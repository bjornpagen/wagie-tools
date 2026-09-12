import { type Fact, query, v } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { CivilDaySpan } from "./core/time.ts"
import { entityId, json, mintId, Nonblank, Refusal, signed } from "./core/values.ts"
import { entryKey } from "./deposits.ts"
import { liabilityEntries, relationRows, rows } from "./queries.ts"
import { paymentEquation } from "./reconciliation.ts"
import { parseStrict } from "./runtime.ts"
import { commandFields, Day, Id, inputFields } from "./schema/input.ts"
import * as S from "./schema.ts"

const ReferenceInput = Schema.Struct(
	inputFields(S.PaymentReference, ["issuer", "scope", "value", "sourceText"])
)
export const PaymentRecordInput = Schema.Struct({
	...commandFields,
	...inputFields(S.TaxPayment, ["account", "sentOn", "amount", "evidence"], { sentOn: Day }),
	references: Schema.Array(ReferenceInput),
	artifacts: Schema.Array(Id),
	settlement: Schema.optional(
		Schema.Struct(inputFields(S.PaymentSettlement, ["settlesOn", "evidence"], { settlesOn: Day }))
	)
})

const referenceKey = (row: typeof ReferenceInput.Type) => json([row.issuer, row.scope, row.value])
const unique = <A>(values: readonly A[], key: (value: A) => string, label: string) => {
	const keys = values.map(key)
	if (new Set(keys).size !== keys.length)
		throw new Refusal({ code: "DuplicateInput", message: `Repeated ${label}` })
}

/** Observe money already sent. Verified external identities are independent
 * of command IDs; contradictory observations create work, never another payment.
 */
export const recordPayment = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(PaymentRecordInput, payload)
		unique(input.references, referenceKey, "external payment reference")
		unique(input.artifacts, (value) => value, "payment artifact")
		const request = input.request,
			business = input.business,
			account = input.account
		const amount = input.amount,
			sentOn = input.sentOn
		const settlement = input.settlement && {
			settlesOn: input.settlement.settlesOn,
			evidence: input.settlement.evidence
		}
		return yield* businessCommand({
			request,
			business,
			action: "payment record",
			input: payload,
			plan: ({ snapshot, draft, recordedAt, recordingDay }) =>
				Effect.gen(function* () {
					if (sentOn > recordingDay || (settlement && settlement.settlesOn < sentOn))
						return yield* Effect.fail(
							new Refusal({
								code: "PaymentDate",
								message: "Record money already sent; its settlement cannot precede its send date"
							})
						)
					const payments = yield* relationRows(snapshot, S.TaxPayment)
					const references = yield* relationRows(snapshot, S.PaymentReference)
					const settlements = yield* relationRows(snapshot, S.PaymentSettlement)
					const presented = new Set(input.references.map(referenceKey))
					const identified = new Set(
						references.filter((row) => presented.has(referenceKey(row))).map((row) => row.payment)
					)
					const existing = payments.find((row) => identified.has(row.id))
					const originalSettlement = existing && settlements.find((row) => row.payment === existing.id)
					const conflict =
						identified.size > 1 ||
						(existing &&
							(existing.business !== business ||
								existing.account !== account ||
								existing.amount !== amount ||
								existing.sentOn !== sentOn)) ||
						(originalSettlement && settlement && originalSettlement.settlesOn !== settlement.settlesOn)
					if (conflict) {
						const issue = yield* mintId
						yield* draft.insert(S.FinancialIssue, [
							{
								id: issue,
								business,
								scope: "TaxAccount",
								evidence: input.evidence,
								detail: json({
									reason: "Conflicting observation of an existing payment",
									input,
									existingPayments: [...identified]
								})
							}
						])
						yield* draft.insert(S.PaymentIssue, [{ issue, business, account }])
						return { kind: "ReconciliationRequired", issue, paymentsJson: json([...identified]) }
					}
					const payment = existing?.id ?? (yield* mintId)
					if (!existing)
						yield* draft.insert(S.TaxPayment, [
							{ id: payment, business, account, amount, sentOn, evidence: input.evidence, recordedAt }
						])
					for (const reference of input.references) {
						if (!references.some((row) => referenceKey(row) === referenceKey(reference)))
							yield* draft.insert(S.PaymentReference, [{ payment, ...reference }])
					}
					yield* draft.insert(
						S.PaymentEvidence,
						input.artifacts.map((id) => ({ payment, artifact: entityId(id) }))
					)
					if (settlement && !originalSettlement)
						yield* draft.insert(S.PaymentSettlement, [{ payment, ...settlement }])
					return { kind: "PaymentRecorded", payment, observedPreviously: Boolean(existing) }
				})
		})
	})

const DateSpanInput = Schema.Struct({ start: Day, end: Day }).pipe(
	Schema.decodeTo(Schema.toType(CivilDaySpan))
)
const AllocationInput = Schema.Struct({
	...inputFields(S.PaymentAllocation, ["revision"]),
	negativeApplicationEvidence: Schema.optional(Nonblank)
})
const AttributionInput = Schema.Struct({
	...inputFields(S.PaymentReconciliation, ["payment", "period", "evidence"], { period: DateSpanInput }),
	entries: Schema.Array(AllocationInput),
	adjustments: Schema.Array(
		Schema.Struct(
			inputFields(S.PaymentAdjustment, ["amount", "period", "evidence"], { period: DateSpanInput })
		)
	)
})
export const PaymentReconcileInput = Schema.Struct({
	...commandFields,
	payments: Schema.Array(AttributionInput).check(Schema.isMinLength(1)),
	resolveIssues: Schema.Array(Id)
})

/** Replace only accounting attribution, atomically for all affected payments.
 * Actual payments and their references are immutable. Native history retains
 * the previous manifest; each replacement supplies its explicit explanation.
 */
export const reconcilePayments = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(PaymentReconcileInput, payload)
		unique(input.payments, (value) => value.payment, "payment")
		unique(input.resolveIssues, (value) => value, "financial issue")
		const request = input.request,
			business = input.business
		return yield* businessCommand({
			request,
			business,
			action: "payment reconcile",
			input: payload,
			plan: ({ snapshot, draft, recordedAt }) =>
				Effect.gen(function* () {
					const payments = yield* relationRows(snapshot, S.TaxPayment)
					const reconciliations = yield* relationRows(snapshot, S.PaymentReconciliation)
					const allocations = yield* relationRows(snapshot, S.PaymentAllocation)
					const adjustments = yield* relationRows(snapshot, S.PaymentAdjustment)
					const entries = yield* rows(snapshot, liabilityEntries, {})
					const affected = new Set(input.payments.map((row) => row.payment))
					const old = reconciliations.filter((row) => affected.has(row.payment))
					const oldIds = new Set(old.map((row) => row.id))
					const byEntry = new Map(entries.map((entry) => [entryKey(entry), entry]))
					const occupied = new Set(allocations.filter((row) => !oldIds.has(row.reconciliation)).map(entryKey))
					const claimed = new Set<string>()
					const newReconciliations: Fact<typeof S.PaymentReconciliation>[] = []
					const newAllocations: Fact<typeof S.PaymentAllocation>[] = []
					const newAdjustments: Fact<typeof S.PaymentAdjustment>[] = []
					for (const attribution of input.payments) {
						const payment = payments.find(
							(row) => row.id === attribution.payment && row.business === business
						)
						if (!payment)
							return yield* Effect.fail(
								new Refusal({ code: "PaymentMissing", message: `No matching payment ${attribution.payment}` })
							)
						const period = attribution.period
						const reconciliation = yield* mintId
						const selected = attribution.entries.map((selection) => {
							const key = entryKey({ revision: entityId(selection.revision), account: payment.account })
							if (occupied.has(key) || claimed.has(key))
								throw new Refusal({
									code: "AlreadyAllocated",
									message: `Include every affected payment when reattributing ${key}`
								})
							claimed.add(key)
							const entry = byEntry.get(key)
							if (
								!entry ||
								entry.business !== business ||
								entry.paidOn.start < period.start ||
								entry.paidOn.end > period.end
							)
								throw new Refusal({
									code: "AllocationScope",
									message: `Entry ${key} does not belong to this payment period`
								})
							if (entry.amount < 0n && !selection.negativeApplicationEvidence)
								throw new Refusal({
									code: "NegativeApplicationEvidence",
									message: "A negative entry needs evidence authorizing this specific payment application"
								})
							newAllocations.push({
								revision: entry.revision,
								account: payment.account,
								business,
								reconciliation,
								paidOn: entry.paidOn
							})
							return entry.amount
						})
						const adjustmentAmounts = attribution.adjustments.map((adjustment) => {
							const amount = signed(adjustment.amount)
							const adjustmentPeriod = adjustment.period
							if (amount === 0n || adjustmentPeriod.start < period.start || adjustmentPeriod.end > period.end)
								throw new Refusal({
									code: "AdjustmentScope",
									message: "Adjustments must be nonzero and attributed within the reconciled period"
								})
							return { amount, period: adjustmentPeriod, evidence: adjustment.evidence }
						})
						const equation = paymentEquation(
							payment.amount,
							selected,
							adjustmentAmounts.map((row) => row.amount)
						)
						if (equation.difference !== 0n)
							return yield* Effect.fail(
								new Refusal({
									code: "PaymentDifference",
									message: json({ payment: payment.id, ...equation })
								})
							)
						newReconciliations.push({
							id: reconciliation,
							payment: payment.id,
							business,
							account: payment.account,
							period,
							evidence: json({ explanation: attribution.evidence, entries: attribution.entries }),
							recordedAt
						})
						for (const adjustment of adjustmentAmounts)
							newAdjustments.push({ id: yield* mintId, reconciliation, ...adjustment })
					}
					yield* draft.delete(
						S.PaymentAllocation,
						allocations.filter((row) => oldIds.has(row.reconciliation))
					)
					yield* draft.delete(
						S.PaymentAdjustment,
						adjustments.filter((row) => oldIds.has(row.reconciliation))
					)
					yield* draft.delete(S.PaymentReconciliation, old)
					yield* draft.insert(S.PaymentReconciliation, newReconciliations)
					yield* draft.insert(S.PaymentAllocation, newAllocations)
					yield* draft.insert(S.PaymentAdjustment, newAdjustments)
					// Issue resolution is checked against the same scoped payments below.
					const issues = yield* rows(snapshot, financialIssueFacts, {})
					for (const issueId of input.resolveIssues) {
						const issue = issues.find((row) => row.id === issueId && row.business === business)
						if (!issue || !newReconciliations.some((row) => row.account === issue.account))
							return yield* Effect.fail(
								new Refusal({
									code: "IssueScope",
									message: "A financial issue must match an account reconciled by this command"
								})
							)
						yield* draft.insert(S.FinancialResolution, [
							{
								issue: issue.id,
								evidence: json(
									input.payments.map((row) => ({ payment: row.payment, evidence: row.evidence }))
								),
								recordedAt
							}
						])
					}
					return {
						kind: "PaymentsReconciled",
						paymentsJson: json([...affected]),
						reconciliationsJson: json(newReconciliations.map((row) => row.id))
					}
				})
		})
	})

const financialIssueFacts = query(S.ledger).rule((r) => {
	const { issue, business, account } = v(S.PaymentIssue)
	return r.match(S.PaymentIssue, { issue, business, account }).find({ id: issue, business, account })
})

const DispositionInput = Schema.Struct({
	...commandFields,
	...inputFields(S.SignedDisposition, ["revision", "account", "disposition", "evidence"])
})
/** Record an evidenced resolution of a negative liability without inventing a
 * refund or changing an actual payment. Payment applications use reconciliation. */
export const disposeLiability = (payload: unknown) =>
	Effect.gen(function* () {
		const input = parseStrict(DispositionInput, payload),
			business = input.business
		return yield* businessCommand({
			request: input.request,
			business,
			action: "payment dispose",
			input: payload,
			plan: ({ snapshot, draft }) =>
				Effect.gen(function* () {
					const entry = (yield* rows(snapshot, liabilityEntries, {})).find(
						(row) =>
							row.business === business && row.revision === input.revision && row.account === input.account
					)
					if (!entry || entry.amount >= 0n)
						return yield* Effect.fail(
							new Refusal({
								code: "DispositionScope",
								message: "An evidenced disposition requires a negative entry for this business"
							})
						)
					if (
						(yield* relationRows(snapshot, S.PaymentAllocation)).some(
							(row) => entryKey(row) === entryKey(entry)
						)
					)
						return yield* Effect.fail(
							new Refusal({ code: "AlreadyAllocated", message: "This entry is already applied to a payment" })
						)
					const fact = {
						revision: entry.revision,
						account: entry.account,
						disposition: input.disposition,
						evidence: input.evidence
					}
					const old = (yield* relationRows(snapshot, S.SignedDisposition)).find(
						(row) => entryKey(row) === entryKey(entry)
					)
					if (old && json(old) !== json(fact))
						return yield* Effect.fail(
							new Refusal({
								code: "DispositionConflict",
								message: "This entry already has another recorded disposition"
							})
						)
					if (!old) yield* draft.insert(S.SignedDisposition, [fact])
					return { revision: entry.revision, account: entry.account, amount: entry.amount }
				})
		})
	})
