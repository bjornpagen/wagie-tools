import {
	ChangeSet,
	type Fact,
	type QueryRelation,
	query,
	type Schema,
	type SchemaRelations,
	type Uuid,
	v
} from "@bjornpagen/bumbledb"
import type { Population, PublishedSnapshot } from "@bjornpagen/bumbledb-log"
import { Effect } from "effect"
import { filingActivityOf, filingDigestOf } from "../../src/bookkeeping.ts"
import { statementId } from "../../src/commands.ts"
import { epochDay, toCalendarDate } from "../../src/core/time.ts"
import { Refusal } from "../../src/core/values.ts"
import * as old from "../0001-statements/schema.ts"
import * as next from "./schema.ts"

/** 0001 → 0002: every column names its type.
 *
 * - Closed rosters replace free strings whose values were always drawn from a
 *   fixed set: `Employee.filingStatus`, `BusinessAddress.kind`,
 *   `SuppliedConversionTax.field`, `SignedDisposition.disposition`,
 *   `PaymentReference.issuer`.
 * - `BankReference` is gone: every row restated `MercuryTransaction`
 *   (issuer Mercury, scope the business, value and source text the reference).
 * - `PaymentReference.scope` (a uuid in a string) is `account: uuid`, contained in
 *   the payment; `sourceText` is gone (it was the value, or a passage already
 *   inside the payment's evidence).
 * - `AttestedVersion.attestation` and `GrandfatheredEligibility.attestation`
 *   were prose; they are `evidence` Statements like every other justification.
 * - `RetirementReport.supplied` was a JSON blob. Its figures are typed arms
 *   under `form`: `Reported1099R` (+ `Reported1099RBasis` for box 5) and
 *   `Reported1096`. The blob's account kind was the account's own kind, and its
 *   "event day not supplied" flag was the definition of a supplied report.
 * - Money columns named `cents` are named by role: `PolicyLimit.amount`,
 *   `ElectionDocumentAmount.amount`, `CalculationBasis.gross`,
 *   `CalculationWageBase.gross`.
 *
 * Every entity id is preserved. Retirement filing digests are re-derived over
 * the migrated rows with the current digest function.
 */
type Old = PublishedSnapshot<typeof old.schema>
type Next = Population<typeof next.schema>
type OldRelations = typeof old.schema.relations
type NextRelations = typeof next.schema.relations
type OldStored = Extract<OldRelations[keyof OldRelations], { kind: "relation" }>
type NextStored = Extract<NextRelations[keyof NextRelations], { kind: "relation" }>

const allRows = <Rels extends SchemaRelations, R extends QueryRelation<Rels>>(
	theory: Schema<Rels>,
	relation: R
) =>
	query(theory).rule((r) => {
		const row = v(relation)
		return r.match(relation, row).find(row)
	})
const read = <R extends OldStored>(source: Old, relation: R): Effect.Effect<readonly Fact<R>[], unknown> =>
	Effect.scoped(
		Effect.gen(function* () {
			return (yield* (yield* source.execute(
				allRows(old.schema, relation as never),
				{}
			)).collect()) as readonly Fact<R>[]
		})
	)
const write = <R extends NextStored>(target: Next, relation: R, rows: readonly Fact<R>[]) =>
	Effect.scoped(
		Effect.gen(function* () {
			for (let index = 0; index < rows.length; index += 256) {
				const batch = yield* ChangeSet.builder(next.schema)
				yield* batch.insert(relation, rows.slice(index, index + 256))
				yield* target.apply(yield* batch.finish())
			}
		})
	)
const conflict = (message: string) => Effect.fail(new Refusal({ code: "MigrationConflict", message }))
const member = <const H extends readonly string[]>(
	roster: { readonly handles: H },
	value: string,
	what: string
) =>
	roster.handles.includes(value)
		? Effect.succeed(value as H[number])
		: conflict(`${what} "${value}" is not one of ${roster.handles.join(", ")}`)

/** Relations carried column for column. */
const unchanged = (Object.keys(next.schema.relations) as (keyof NextRelations & keyof OldRelations)[]).filter(
	(name) =>
		![
			"Statement",
			"Employee",
			"BusinessAddress",
			"SuppliedConversionTax",
			"SignedDisposition",
			"PaymentReference",
			"AttestedVersion",
			"GrandfatheredEligibility",
			"RetirementReport",
			"RetirementFilingBasis",
			"PolicyLimit",
			"ElectionDocumentAmount",
			"CalculationBasis",
			"CalculationWageBase"
		].includes(name) &&
		next.schema.relations[name].kind === "relation" &&
		(old.schema.relations as Record<string, { kind: string }>)[name]?.kind === "relation"
)

/** The 0001 JSON blob behind `RetirementReport.supplied`. */
type SuppliedBlob =
	| {
			form: "1099-R"
			account: string
			grossCents: number
			taxableCents: number
			box5Cents: number | null
			distributionCode: string
			kind: string
	  }
	| { form: "1096"; formCount: number; grossCents: number }

export const populateTyped = (source: Old, target: Next) =>
	Effect.gen(function* () {
		const R = old.schema.relations,
			N = next.schema.relations
		const said = new Map<string, string>()
		const say = (text: string) => {
			const id = statementId(text)
			said.set(id, text)
			return id
		}
		for (const statement of yield* read(source, R.Statement)) said.set(statement.id, statement.text)
		const carried = new Map<string, readonly unknown[]>()
		for (const name of unchanged) {
			const rows = yield* read(source, R[name as keyof OldRelations] as OldStored)
			carried.set(name, rows)
			yield* write(target, N[name] as never, rows as never)
		}
		const rowsOf = <K extends keyof NextRelations>(name: K) =>
			(carried.get(name) ?? []) as readonly Fact<Extract<NextRelations[K], { kind: "relation" }>>[]

		// Closed rosters.
		const employees: Fact<typeof N.Employee>[] = []
		for (const row of yield* read(source, R.Employee))
			employees.push({
				...row,
				filingStatus: yield* member(N.FilingStatus, row.filingStatus, `Employee ${row.id} filingStatus`)
			})
		yield* write(target, N.Employee, employees)
		const addresses: Fact<typeof N.BusinessAddress>[] = []
		for (const row of yield* read(source, R.BusinessAddress))
			addresses.push({ ...row, kind: yield* member(N.AddressKind, row.kind, "BusinessAddress kind") })
		yield* write(target, N.BusinessAddress, addresses)
		const suppliedTax: Fact<typeof N.SuppliedConversionTax>[] = []
		for (const row of yield* read(source, R.SuppliedConversionTax))
			suppliedTax.push({
				conversion: row.conversion,
				field: yield* member(N.ConversionTaxField, row.field, "SuppliedConversionTax field"),
				amount: row.amount,
				evidence: row.evidence
			})
		yield* write(target, N.SuppliedConversionTax, suppliedTax)
		const dispositions: Fact<typeof N.SignedDisposition>[] = []
		for (const row of yield* read(source, R.SignedDisposition))
			dispositions.push({
				...row,
				disposition: yield* member(N.Disposition, row.disposition, "SignedDisposition disposition")
			})
		yield* write(target, N.SignedDisposition, dispositions)

		// Payment references: the scope was the payment's account.
		const payments = rowsOf("TaxPayment")
		const references: Fact<typeof N.PaymentReference>[] = []
		for (const row of yield* read(source, R.PaymentReference)) {
			const payment = payments.find((p) => p.id === row.payment)
			if (!payment) return yield* conflict(`PaymentReference names unknown payment ${row.payment}`)
			if (row.scope !== payment.account)
				return yield* conflict(`PaymentReference ${row.value} scope is not the payment's account`)
			// The source text was the value itself or a passage of the payment's
			// own evidence; either way the payment's Statement already holds it.
			if (row.sourceText !== row.value && !said.get(payment.evidence)?.includes(row.sourceText))
				return yield* conflict(`PaymentReference ${row.value} source text is not in the payment's evidence`)
			references.push({
				payment: row.payment,
				account: payment.account,
				issuer: yield* member(N.PaymentIssuer, row.issuer, "PaymentReference issuer"),
				value: row.value
			})
		}
		yield* write(target, N.PaymentReference, references)
		// BankReference: every row restated the movement's MercuryTransaction.
		const mercury = rowsOf("MercuryTransaction"),
			movements = rowsOf("BankMovement")
		for (const row of yield* read(source, R.BankReference)) {
			const transaction = mercury.find((t) => t.movement === row.movement),
				movement = movements.find((m) => m.id === row.movement)
			if (
				row.issuer !== "Mercury" ||
				transaction?.reference !== row.value ||
				row.sourceText !== row.value ||
				movement?.business !== row.scope
			)
				return yield* conflict(
					`BankReference ${row.value} carries information beyond its Mercury transaction`
				)
		}

		// Attestations are statements.
		yield* write(
			target,
			N.AttestedVersion,
			(yield* read(source, R.AttestedVersion)).map(({ attestation, ...row }) => ({
				...row,
				evidence: say(attestation)
			}))
		)
		yield* write(
			target,
			N.GrandfatheredEligibility,
			(yield* read(source, R.GrandfatheredEligibility)).map(({ attestation, ...row }) => ({
				...row,
				evidence: say(attestation)
			}))
		)

		// Money columns named by role.
		yield* write(
			target,
			N.PolicyLimit,
			(yield* read(source, R.PolicyLimit)).map(({ cents, ...row }) => ({ ...row, amount: cents }))
		)
		yield* write(
			target,
			N.ElectionDocumentAmount,
			(yield* read(source, R.ElectionDocumentAmount)).map(({ cents, ...row }) => ({ ...row, amount: cents }))
		)
		yield* write(
			target,
			N.CalculationBasis,
			(yield* read(source, R.CalculationBasis)).map(({ cents, ...row }) => ({ ...row, gross: cents }))
		)
		yield* write(
			target,
			N.CalculationWageBase,
			(yield* read(source, R.CalculationWageBase)).map(({ cents, ...row }) => ({ ...row, gross: cents }))
		)

		// Supplied reports: the blob becomes typed arms.
		const accounts = rowsOf("PlanAccount")
		const reports: Fact<typeof N.RetirementReport>[] = []
		const reported1099R: Fact<typeof N.Reported1099R>[] = []
		const reported1099RBasis: Fact<typeof N.Reported1099RBasis>[] = []
		const reported1096: Fact<typeof N.Reported1096>[] = []
		const cents = (value: number, what: string) =>
			Number.isSafeInteger(value) && value >= 0
				? Effect.succeed(BigInt(value))
				: conflict(`${what} is not a whole non-negative cent amount: ${value}`)
		// Rows are built in declared column order like every other fact.
		const header = (row: { id: Uuid; plan: Uuid; year: bigint; artifact: Uuid }) => ({
			id: row.id,
			plan: row.plan,
			year: row.year,
			artifact: row.artifact
		})
		for (const { supplied, ...row } of yield* read(source, R.RetirementReport)) {
			const blob = JSON.parse(supplied) as SuppliedBlob
			switch (blob.form) {
				case "1099-R": {
					const account = accounts.find((a) => a.id === blob.account && a.plan === row.plan)
					if (!account)
						return yield* conflict(`Report ${row.id} names account ${blob.account} outside its plan`)
					if (account.kind !== blob.kind)
						return yield* conflict(
							`Report ${row.id} states kind ${blob.kind}; the account is ${account.kind}`
						)
					reports.push({ ...header(row), form: "F1099R", evidence: row.evidence })
					reported1099R.push({
						report: row.id,
						plan: row.plan,
						account: account.id,
						distributionCode: yield* member(
							N.DistributionCode,
							blob.distributionCode,
							`Report ${row.id} box 7`
						),
						gross: yield* cents(blob.grossCents, `Report ${row.id} gross`),
						taxable: yield* cents(blob.taxableCents, `Report ${row.id} taxable`)
					})
					if (blob.box5Cents !== null)
						reported1099RBasis.push({
							report: row.id,
							amount: yield* cents(blob.box5Cents, `Report ${row.id} box 5`)
						})
					break
				}
				case "1096":
					reports.push({ ...header(row), form: "F1096", evidence: row.evidence })
					reported1096.push({
						report: row.id,
						forms: BigInt(blob.formCount),
						gross: yield* cents(blob.grossCents, `Report ${row.id} gross`)
					})
					break
				default:
					return yield* conflict(`Report ${row.id} has an unknown form: ${supplied}`)
			}
		}
		yield* write(target, N.RetirementReport, reports)
		yield* write(target, N.Reported1099R, reported1099R)
		yield* write(target, N.Reported1099RBasis, reported1099RBasis)
		yield* write(target, N.Reported1096, reported1096)

		// Filing digests over the migrated representation.
		const filings = rowsOf("Filing"),
			subjects = rowsOf("PlanSubject")
		const bases: Fact<typeof N.RetirementFilingBasis>[] = []
		for (const basis of yield* read(source, R.RetirementFilingBasis)) {
			const filing = filings.find((row) => row.id === basis.filing)
			const plan = subjects.find((row) => row.subject === filing?.subject)?.plan
			if (!filing || !plan) return yield* conflict(`Filing basis ${basis.version} has no plan filing`)
			bases.push({
				version: basis.version,
				filing: basis.filing,
				digest: filingDigestOf(
					filingActivityOf(plan, toCalendarDate(epochDay(filing.period.start)).year, {
						receipts: rowsOf("PlanReceipt"),
						receiptDates: rowsOf("PlanReceiptDate"),
						receiptAllocations: rowsOf("ReceiptAllocation"),
						conversions: rowsOf("RothConversion"),
						conversionReceipts: rowsOf("ConversionReceipt"),
						reportedConversions: rowsOf("ReportedReceiptConversion"),
						suppliedTax,
						suppliedReports: reports,
						reported1099R,
						reported1099RBasis,
						reported1096,
						contributions: rowsOf("RetirementContribution")
					})
				)
			})
		}
		yield* write(target, N.RetirementFilingBasis, bases)
		yield* write(
			target,
			N.Statement,
			[...said].map(([id, text]) => ({ id: id as Fact<typeof N.Statement>["id"], text }))
		)
	})
