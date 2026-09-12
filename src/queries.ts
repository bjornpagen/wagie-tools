import {
	Compute,
	type ParamsRecord,
	type QueryRelation,
	type QueryTemplate,
	query,
	type Schema,
	type SchemaRelations,
	v
} from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { postedAssessment } from "./calculations.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"
import { AssessmentRevision, Component, CorrectionAssessment, ledger, RevisionAccount } from "./schema.ts"

type StoredRelation = Extract<(typeof S.relations)[keyof typeof S.relations], { kind: "relation" }>
/** Read-only schema inventory. Fields come from the database declaration;
 * there is no parallel serialization model or generic mutation endpoint.
 */
const allRowsQuery = <Rels extends SchemaRelations, R extends QueryRelation<Rels>>(
	theory: Schema<Rels>,
	relation: R
) =>
	query(theory).rule((r) => {
		const row = v(relation)
		return r.match(relation, row).find(row)
	})
export const relationRows = <R extends StoredRelation>(snapshot: Snapshot, relation: R) =>
	rows(snapshot, allRowsQuery(S.ledger, relation), {})

const { assessmentAmounts, taxableAmounts } = postedAssessment

/** All consumers evaluate these same native projections at their own snapshot. */
export const rows = <P extends ParamsRecord, A>(
	snapshot: Snapshot,
	expression: QueryTemplate<typeof ledger, P, A>,
	parameters: P
) =>
	Effect.scoped(
		Effect.gen(function* () {
			return yield* (yield* snapshot.execute(expression, parameters)).collect()
		})
	)

const unsignedRevisionTotals = query(ledger).rule((r) => {
	const { id: revision, set, wage, business, employee, paidOn } = v(AssessmentRevision)
	const { component, amount } = v(assessmentAmounts)
	const { account, family } = v(RevisionAccount)
	return r
		.match(AssessmentRevision, { id: revision, set, wage, business, employee, paidOn })
		.match(assessmentAmounts, { set, component, amount })
		.match(Component, { id: component, family })
		.match(RevisionAccount, { revision, account, family })
		.find({ revision, wage, business, employee, paidOn, account, family, amount: r.sum(amount) })
})

export const revisionTotals = query(ledger).rule((r) => {
	const { amount, ...identity } = v(unsignedRevisionTotals)
	return r
		.match(unsignedRevisionTotals, { ...identity, amount })
		.find({ ...identity, amount: Compute.toI64Exact(amount) })
})

/** Originally accrued federal tax determines the deposit-regime trigger.
 * A later tax revision or payment cannot erase a trigger already reached.
 */
export const initialFederalAccruals = query(ledger).rule((r) => {
	const row = v(revisionTotals)
	return r
		.match(revisionTotals, row)
		.match(AssessmentRevision, { id: row.revision, kind: "Initial" })
		.where(r.eq(row.family, "Federal941"))
		.find(row)
})

/** Full initial account assessment, followed only by each revision's signed
 * difference. This composite entry identity is also PaymentAllocation's key.
 */
export const liabilityEntries = query(ledger)
	.rule((r) => {
		const row = v(revisionTotals)
		return r
			.match(revisionTotals, row)
			.match(AssessmentRevision, { id: row.revision, kind: "Initial" })
			.find(row)
	})
	.rule((r) => {
		const current = v(revisionTotals)
		const previous = v(revisionTotals)
		return r
			.match(revisionTotals, current)
			.match(CorrectionAssessment, { revision: current.revision, predecessor: previous.revision })
			.match(revisionTotals, {
				...previous,
				wage: current.wage,
				business: current.business,
				employee: current.employee,
				paidOn: current.paidOn,
				account: current.account,
				family: current.family
			})
			.find({
				revision: current.revision,
				wage: current.wage,
				business: current.business,
				employee: current.employee,
				paidOn: current.paidOn,
				account: current.account,
				family: current.family,
				amount: Compute.subtract(current.amount, previous.amount)
			})
	})

export const currentRevisions = query(ledger).rule((r) => {
	const row = v(AssessmentRevision)
	return r
		.match(AssessmentRevision, row)
		.where(r.not(CorrectionAssessment, { predecessor: row.id }))
		.find(row)
})

export const currentAssessments = query(ledger).rule((r) => {
	const revision = v(currentRevisions)
	const { component, amount } = v(assessmentAmounts)
	return r
		.match(currentRevisions, revision)
		.match(assessmentAmounts, { set: revision.set, component, amount })
		.find({
			revision: revision.id,
			wage: revision.wage,
			business: revision.business,
			employee: revision.employee,
			paidOn: revision.paidOn,
			component,
			amount
		})
})

export const currentTaxableWages = query(ledger).rule((r) => {
	const revision = v(currentRevisions),
		{ component, amount } = v(taxableAmounts)
	return r
		.match(currentRevisions, revision)
		.match(taxableAmounts, { set: revision.set, component, amount })
		.find({
			revision: revision.id,
			wage: revision.wage,
			business: revision.business,
			employee: revision.employee,
			paidOn: revision.paidOn,
			component,
			amount
		})
})
