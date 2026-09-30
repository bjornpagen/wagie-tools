import {
	Compute,
	type Fact,
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

export type StoredRelation = Extract<(typeof S.relations)[keyof typeof S.relations], { kind: "relation" }>
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

/** One native template per (relation, bound columns): every row whose named
 * columns equal the parameters. Compiled once, executed with parameters, so a
 * lookup never scans and decodes a whole relation to keep a few rows. */
type Where<R extends StoredRelation> = Partial<Fact<R>>
type Template = QueryTemplate<typeof ledger, ParamsRecord, Record<string, unknown>>
const selections = new WeakMap<StoredRelation, Map<string, Template>>()
const selection = (relation: StoredRelation, columns: readonly string[]): Template => {
	const byColumns = selections.get(relation) ?? new Map<string, Template>()
	selections.set(relation, byColumns)
	const signature = columns.join("\u0000")
	const known = byColumns.get(signature)
	if (known) return known
	// The rule is authored generically: the relation and its columns are only
	// known at run time, so the builder's static judgments are bypassed here and
	// the result is typed at the one exported call site below.
	const template = query(ledger).rule((r) => {
		const row = v(relation as typeof S.Statement) as unknown as Record<string, never>
		let chain = r.match(relation as typeof S.Statement, row as never) as unknown as {
			where: (condition: unknown) => typeof chain
			find: (row: unknown) => unknown
		}
		for (const column of columns) chain = chain.where(r.eq(row[column] as never, r.param(column)))
		return chain.find(row) as never
	}) as unknown as Template
	byColumns.set(signature, template)
	return template
}
/** Rows of `relation` whose columns equal `where`; `{}` is the whole relation. */
export const select = <R extends StoredRelation>(
	snapshot: Snapshot,
	relation: R,
	where: Where<R>
): Effect.Effect<readonly Fact<R>[], unknown> => {
	const columns = Object.keys(where).sort()
	return columns.length === 0
		? (relationRows(snapshot, relation) as Effect.Effect<readonly Fact<R>[], unknown>)
		: (rows(snapshot, selection(relation, columns), where as ParamsRecord) as Effect.Effect<
				readonly Fact<R>[],
				unknown
			>)
}
export const first = <R extends StoredRelation>(snapshot: Snapshot, relation: R, where: Where<R>) =>
	Effect.map(select(snapshot, relation, where), (found) => found[0])
/** Whether any row matches `where`. */
export const exists = <R extends StoredRelation>(snapshot: Snapshot, relation: R, where: Where<R>) =>
	Effect.map(select(snapshot, relation, where), (found) => found.length > 0)

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
