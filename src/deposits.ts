import { type Fact, type QueryRow, query, type Uuid, v } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { epochDay, type UnixEpochDay } from "./core/time.ts"
import { Refusal, signed } from "./core/values.ts"
import { liabilityEntries, relationRows, rows } from "./queries.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"

export const entryKey = (entry: Pick<Fact<typeof S.PaymentAllocation>, "revision" | "account">) =>
	`${entry.revision}/${entry.account}`

export const entryPayments = query(S.ledger).rule((r) => {
	const allocation = v(S.PaymentAllocation)
	const { payment } = v(S.PaymentReconciliation)
	const { sentOn } = v(S.TaxPayment)
	return r
		.match(S.PaymentAllocation, allocation)
		.match(S.PaymentReconciliation, { id: allocation.reconciliation, payment })
		.match(S.TaxPayment, { id: payment, sentOn })
		.find({
			revision: allocation.revision,
			account: allocation.account,
			payment,
			sentOn,
			reconciliation: allocation.reconciliation
		})
})
const checkpointFacts = query(S.ledger).rule((r) => {
	const row = v(S.DepositCheckpoint)
	const { release } = v(S.PolicyBinding)
	return r
		.match(S.DepositCheckpoint, row)
		.match(S.DepositPolicy, { id: row.policy, business: row.business, release })
		.match(S.PolicyBinding, { business: row.business, release })
		.find(row)
})
const readEntries = (snapshot: Snapshot) => rows(snapshot, liabilityEntries, {})
const readPayments = (snapshot: Snapshot) => rows(snapshot, entryPayments, {})
export type LiabilityEntry = QueryRow<typeof liabilityEntries>
export type EntryPayment = Omit<QueryRow<typeof entryPayments>, "reconciliation">

export type Deposit = Pick<Fact<typeof S.DepositCheckpoint>, "account" | "year" | "evidence"> & {
	readonly checkpoint: Fact<typeof S.DepositCheckpoint>["id"]
	readonly opensOn: UnixEpochDay
	readonly dueOn: UnixEpochDay
	readonly required: bigint
	readonly outstanding: bigint
	readonly entries: readonly LiabilityEntry[]
	readonly disposition: "Deposit" | "Carryover"
}

/** One ordered checkpoint projection for every deposit policy. The threshold
 * decision uses money unpaid at that historical checkpoint. A later payment
 * clears the resulting obligation without rewriting its original trigger.
 * Only accepted full-entry reconciliations qualify as payments here.
 */
export function projectDeposits(
	entries: readonly LiabilityEntry[],
	checkpoints: readonly Fact<typeof S.DepositCheckpoint>[],
	triggers: readonly Fact<typeof S.DepositTrigger>[],
	payments: readonly EntryPayment[]
): readonly Deposit[] {
	const paid = new Map(payments.map((row) => [entryKey(row), row]))
	const bands = new Map(triggers.map((row) => [`${row.policy}/${row.kind}`, row.actionable]))
	const carry = new Map<string, LiabilityEntry[]>()
	const result: Deposit[] = []
	const ordered = [...checkpoints].sort((a, b) =>
		a.span.start < b.span.start ? -1 : a.span.start > b.span.start ? 1 : 0
	)
	for (const checkpoint of ordered) {
		const scope = `${checkpoint.account}/${checkpoint.year}`
		const inPeriod = entries.filter(
			(entry) =>
				entry.account === checkpoint.account &&
				entry.amount > 0n &&
				entry.paidOn.start >= checkpoint.span.start &&
				entry.paidOn.end <= checkpoint.span.end
		)
		const accumulated = [...(carry.get(scope) ?? []), ...inPeriod].filter((entry) => {
			const payment = paid.get(entryKey(entry))
			return payment === undefined || payment.sentOn >= checkpoint.opensOn
		})
		const required = accumulated.reduce((sum, entry) => signed(sum + entry.amount), 0n)
		const band = bands.get(`${checkpoint.policy}/${checkpoint.kind}`)
		if (!band)
			throw new Refusal({ code: "DepositPolicyMissing", message: `Missing trigger for ${checkpoint.id}` })
		const triggered = required >= band.start && required < band.end
		carry.set(scope, triggered ? [] : accumulated)
		if (required === 0n) continue
		const outstanding = accumulated
			.filter((entry) => !paid.has(entryKey(entry)))
			.reduce((sum, entry) => signed(sum + entry.amount), 0n)
		result.push({
			checkpoint: checkpoint.id,
			account: checkpoint.account,
			year: checkpoint.year,
			opensOn: epochDay(checkpoint.opensOn),
			dueOn: epochDay(checkpoint.dueOn),
			required,
			outstanding,
			entries: accumulated,
			disposition: triggered ? "Deposit" : "Carryover",
			evidence: checkpoint.evidence
		})
	}
	return result
}

export const depositRegister = (
	snapshot: Snapshot,
	business: Uuid,
	excluded: ReadonlySet<string>,
	acceptedReconciliations: ReadonlySet<Uuid>
) =>
	Effect.gen(function* () {
		const entries = (yield* readEntries(snapshot)).filter(
			(row) => row.business === business && !excluded.has(entryKey(row))
		)
		const checkpoints = (yield* rows(snapshot, checkpointFacts, {})).filter(
			(row) => row.business === business
		)
		const triggers = yield* relationRows(snapshot, S.DepositTrigger)
		const payments = (yield* readPayments(snapshot)).filter((row) =>
			acceptedReconciliations.has(row.reconciliation)
		)
		const uncovered = entries.filter(
			(entry) =>
				entry.amount > 0n &&
				!checkpoints.some(
					(checkpoint) =>
						checkpoint.account === entry.account &&
						entry.paidOn.start >= checkpoint.span.start &&
						entry.paidOn.end <= checkpoint.span.end
				)
		)
		return { deposits: projectDeposits(entries, checkpoints, triggers, payments), uncovered, checkpoints }
	})
