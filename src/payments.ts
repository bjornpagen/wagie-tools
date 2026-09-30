import type { Fact } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { businessCommand } from "./commands.ts"
import { entityId, json, mintId, Nonblank, Refusal, signed } from "./core/values.ts"
import { entryKey } from "./deposits.ts"
import { first, liabilityEntries, relationRows, rows, select } from "./queries.ts"
import { askQuestion, questions } from "./questions.ts"
import { paymentEquation } from "./reconciliation.ts"
import { parseStrict } from "./runtime.ts"
import { commandFields, Id, inputFields } from "./schema/input.ts"
import * as S from "./schema.ts"

const ReferenceInput = Schema.Struct(inputFields(S.PaymentReference, ["issuer", "value"]))
export const PaymentRecordInput = Schema.Struct({
	...commandFields,
	...inputFields(S.TaxPayment, ["account", "sentOn", "amount", "evidence"]),
	references: Schema.Array(ReferenceInput),
	artifacts: Schema.Array(Id),
	settlement: Schema.optional(Schema.Struct(inputFields(S.PaymentSettlement, ["settlesOn", "evidence"])))
})

const referenceKey = (row: typeof ReferenceInput.Type) => json([row.issuer, row.value])
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
			plan: ({ snapshot, draft, note, recordingDay }) =>
				Effect.gen(function* () {
					if (sentOn > recordingDay || (settlement && settlement.settlesOn < sentOn))
						return yield* Effect.fail(
							new Refusal({
								code: "PaymentDate",
								message: "Record money already sent; its settlement cannot precede its send date"
							})
						)
					// A reference identifies a payment within its account.
					const references = yield* select(snapshot, S.PaymentReference, { account })
					const presented = new Set(input.references.map(referenceKey))
					const identified = new Set(
						references.filter((row) => presented.has(referenceKey(row))).map((row) => row.payment)
					)
					const existing = yield* Effect.map(
						Effect.forEach([...identified], (id) => first(snapshot, S.TaxPayment, { id })),
						(found) => found.find((row) => row !== undefined)
					)
					const originalSettlement =
						existing && (yield* first(snapshot, S.PaymentSettlement, { payment: existing.id }))
					const conflict =
						identified.size > 1 ||
						(existing &&
							(existing.business !== business ||
								existing.account !== account ||
								existing.amount !== amount ||
								existing.sentOn !== sentOn)) ||
						(originalSettlement && settlement && originalSettlement.settlesOn !== settlement.settlesOn)
					if (conflict) {
						const issue = yield* askQuestion(
							draft,
							note,
							business,
							{ kind: "TaxAccount", account },
							`Conflicting observation of existing payment(s) ${[...identified].join(", ")}; the retained request ${request} holds the observation.`,
							input.evidence
						)
						return { kind: "ReconciliationRequired", issue, paymentsJson: json([...identified]) }
					}
					const payment = existing?.id ?? (yield* mintId)
					if (!existing)
						yield* draft.insert(S.TaxPayment, [
							{ id: payment, business, account, amount, sentOn, evidence: yield* note(input.evidence) }
						])
					for (const reference of input.references) {
						if (!references.some((row) => referenceKey(row) === referenceKey(reference)))
							yield* draft.insert(S.PaymentReference, [{ payment, account, ...reference }])
					}
					yield* draft.insert(
						S.PaymentEvidence,
						input.artifacts.map((id) => ({ payment, artifact: entityId(id) }))
					)
					if (settlement && !originalSettlement)
						yield* draft.insert(S.PaymentSettlement, [
							{ payment, settlesOn: settlement.settlesOn, evidence: yield* note(settlement.evidence) }
						])
					return { kind: "PaymentRecorded", payment, observedPreviously: Boolean(existing) }
				})
		})
	})

const AllocationInput = Schema.Struct({
	...inputFields(S.PaymentAllocation, ["revision"]),
	negativeApplicationEvidence: Schema.optional(Nonblank)
})
const AttributionInput = Schema.Struct({
	...inputFields(S.PaymentReconciliation, ["payment", "period", "evidence"]),
	entries: Schema.Array(AllocationInput),
	adjustments: Schema.Array(Schema.Struct(inputFields(S.PaymentAdjustment, ["amount", "period", "evidence"])))
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
			plan: ({ snapshot, draft, note }) =>
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
					const negatives: {
						revision: (typeof newAllocations)[number]["revision"]
						account: (typeof newAllocations)[number]["account"]
						evidence: string
					}[] = []
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
							if (entry.amount < 0n && selection.negativeApplicationEvidence)
								negatives.push({
									revision: entry.revision,
									account: payment.account,
									evidence: selection.negativeApplicationEvidence
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
							evidence: yield* note(attribution.evidence)
						})
						for (const adjustment of adjustmentAmounts)
							newAdjustments.push({
								id: yield* mintId,
								reconciliation,
								amount: adjustment.amount,
								period: adjustment.period,
								evidence: yield* note(adjustment.evidence)
							})
					}
					yield* draft.delete(
						S.PaymentAllocation,
						allocations.filter((row) => oldIds.has(row.reconciliation))
					)
					yield* draft.delete(
						S.PaymentAdjustment,
						adjustments.filter((row) => oldIds.has(row.reconciliation))
					)
					yield* draft.delete(
						S.NegativeApplication,
						(yield* relationRows(snapshot, S.NegativeApplication)).filter((row) =>
							allocations.some(
								(a) =>
									oldIds.has(a.reconciliation) && a.revision === row.revision && a.account === row.account
							)
						)
					)
					yield* draft.delete(S.PaymentReconciliation, old)
					yield* draft.insert(S.PaymentReconciliation, newReconciliations)
					yield* draft.insert(S.PaymentAllocation, newAllocations)
					yield* draft.insert(S.PaymentAdjustment, newAdjustments)
					for (const negative of negatives)
						yield* draft.insert(S.NegativeApplication, [
							{
								revision: negative.revision,
								account: negative.account,
								evidence: yield* note(negative.evidence)
							}
						])
					// Issue resolution is checked against the same scoped payments below.
					const issues = yield* questions(snapshot, business)
					const explanation = yield* note(
						input.payments.map((row) => `${row.payment}: ${row.evidence}`).join("\n")
					)
					for (const issueId of input.resolveIssues) {
						const issue = issues.find((row) => row.id === issueId)
						if (
							issue?.kind !== "TaxAccount" ||
							issue.answer ||
							!newReconciliations.some((row) => row.account === issue.account)
						)
							return yield* Effect.fail(
								new Refusal({
									code: "IssueScope",
									message: "A financial issue must match an account reconciled by this command"
								})
							)
						yield* draft.insert(S.Answer, [{ id: yield* mintId, question: issue.id, evidence: explanation }])
					}
					return {
						kind: "PaymentsReconciled",
						paymentsJson: json([...affected]),
						reconciliationsJson: json(newReconciliations.map((row) => row.id))
					}
				})
		})
	})

export const DispositionInput = Schema.Struct({
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
			plan: ({ snapshot, draft, note }) =>
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
						evidence: yield* note(input.evidence)
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
