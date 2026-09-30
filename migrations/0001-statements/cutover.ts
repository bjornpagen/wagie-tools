import { createHash } from "node:crypto"
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
import { statementId } from "../../src/commands.ts"
import { epochDay, periodSpan, toCalendarDate } from "../../src/core/time.ts"
import { json, Refusal } from "../../src/core/values.ts"
import * as old from "../0000-initial/schema.ts"
import * as next from "./schema.ts"

/** 0000 → 0001: statements, questions, Drive copies, no timestamps.
 *
 * - Every `evidence: str` becomes a content-addressed Statement id. Identical
 *   prose anywhere in the ledger is one Statement row.
 * - `recordedAt`/`verifiedAt` columns are dropped; UUIDv7 ids are the clock.
 *   Rows that had a timestamp but no id (approvals, evidence, cancellations,
 *   rejections, reported conversions) receive a fresh id.
 * - Review/Resolution, RetirementSetup/…Resolution, BookkeepingIssue/…Resolution
 *   and FinancialIssue/PaymentIssue/FinancialResolution become Question headers
 *   with one typed arm each, and Answers.
 * - A verified Drive location (JSON `VerifiedDriveArtifact` evidence) becomes a
 *   DriveCopy; the locations it superseded become PriorLocations of that copy.
 * - TaxBand.span is renamed TaxBand.wages.
 * - BankObservation.source (prose) becomes evidence.
 *
 * Every entity id is preserved. The transformation is a pure function of the
 * frozen source snapshot plus the ids minted for the rows listed above.
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

/** A statement-collecting batch writer: any prose passed to `say` is stored once. */
const writer = (target: Next) => {
	const said = new Map<string, string>()
	const say = (text: string) => {
		const id = statementId(text)
		said.set(id, text)
		return id as Uuid
	}
	const write = <R extends NextStored>(relation: R, rows: readonly Fact<R>[]) =>
		Effect.scoped(
			Effect.gen(function* () {
				for (let index = 0; index < rows.length; index += 256) {
					const batch = yield* ChangeSet.builder(next.schema)
					yield* batch.insert(relation, rows.slice(index, index + 256))
					yield* target.apply(yield* batch.finish())
				}
			})
		)
	const flush = () =>
		write(
			next.schema.relations.Statement,
			[...said].map(([id, text]) => ({ id: id as Uuid, text }))
		)
	return { say, write, flush }
}

const byName = <K extends keyof OldRelations>(name: K) => old.schema.relations[name] as OldStored
const nextByName = <K extends keyof NextRelations>(name: K) => next.schema.relations[name] as NextStored

/** Relations whose only change is evidence: str → uuid and/or dropped timestamps. */
const straight = [
	"MercuryTransaction",
	"PayrollTransaction",
	"PlanReceiptDate",
	"BankMovement",
	"BankSource",
	"BankRetry",
	"CashAllocation",
	"PayrollCashBinding",
	"BankTaxPayment",
	"Owner",
	"OwnerDistribution",
	"DistributionReturn",
	"DistributionReview",
	"RetirementPlan",
	"PlanAccount",
	"RetirementAnnual",
	"RetirementContribution",
	"ContributionElection",
	"ContributionAuthorization",
	"ContributionDeduction",
	"ContributionFunding",
	"ProviderOperation",
	"PlanReceipt",
	"ReceiptAllocation",
	"RothConversion",
	"ConversionReceipt",
	"SuppliedConversionTax",
	"RetirementReport",
	"PlanBalance",
	"PlanSubject",
	"Business",
	"BusinessAddress",
	"StateAccount",
	"Employee",
	"TaxAccount",
	"AnnualBudget",
	"BudgetCommitment",
	"BudgetAssignment",
	"BankReference",
	"Wage",
	"RegularWork",
	"RegularCommitment",
	"ObservedCompensation",
	"Deduction",
	"Election",
	"ElectionSource",
	"ElectionUse",
	"DeferralPolicy",
	"GrossSuggestionPolicy",
	"EmployeeAllowance",
	"Recovery",
	"PolicyRelease",
	"PolicyBinding",
	"AnnualPolicy",
	"AnnualSource",
	"PublishedRate",
	"PolicyLimit",
	"LookbackPeriod",
	"CalculationPolicy",
	"ElectionDocument",
	"ElectionDocumentRevision",
	"ElectionDocumentAmount",
	"EmployerRateNotice",
	"EmployerSchedule",
	"FutaBasis",
	"SupportedPayrollDomain",
	"MonthlyDepositor",
	"SupportedProgram",
	"PolicyCoverage",
	"RateVersion",
	"RateSchedule",
	"TaxBaseScope",
	"StateBaseScope",
	"AssessmentSet",
	"ObservedSet",
	"PayrollCalculation",
	"ProposedWage",
	"ProposedRevision",
	"CalculationRecoveryClaim",
	"Assessment",
	"ObservedAssessment",
	"TaxableWages",
	"CalculatedAssessment",
	"AppliedRule",
	"CalculationBasis",
	"CalculationWageBase",
	"AssessmentRevision",
	"CorrectionAssessment",
	"RevisionAccount",
	"Artifact",
	"TaxPayment",
	"PaymentSettlement",
	"PaymentReference",
	"PaymentEvidence",
	"PaymentReconciliation",
	"PaymentAllocation",
	"PaymentAdjustment",
	"SignedDisposition",
	"CalendarCoverage",
	"CalendarPeriod",
	"BusinessDayCoverage",
	"BusinessDay",
	"DepositPolicy",
	"DepositTrigger",
	"DepositCheckpoint",
	"FilingRequirement",
	"FilingRule",
	"RequirementEnd",
	"FilingSubject",
	"BusinessSubject",
	"EmployeeSubject",
	"FilingScope",
	"Filing",
	"OriginalFiling",
	"CorrectionFiling",
	"DeadlineRevision",
	"FormMethodPolicy",
	"DocumentRequirement",
	"FilingVersion",
	"PreparedVersion",
	"AttestedVersion",
	"FilingBasis",
	"FilingRevision",
	"FilingDocument",
	"FormAdjustment",
	"FilingAdjustmentBasis",
	"AmendmentLiability",
	"GrandfatheredEligibility",
	"CertifiedMailing",
	"MailingEvidence",
	"Submission",
	"GrandfatheredSubmission",
	"DigitalSubmission",
	"DigitalReference",
	"CertifiedMailSubmission",
	"SubmissionDocument",
	"ImportProvenance"
] as const

/** Relations that gain an `id` because their only ordering was a timestamp. */
const gainId = [
	"ContributionCancellation",
	"ReportedReceiptConversion",
	"AnnualEvidence",
	"AnnualApproval",
	"Rejection"
] as const

const DriveEvidence = /^\{[\s\S]*"kind":\s*"VerifiedDriveArtifact"[\s\S]*\}$/
const driveId = (locator: string) =>
	/^https:\/\/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]{10,200})\/view$/.exec(locator)?.[1]

/** The 0001 filing digest, frozen here: a retirement filing's basis is the
 * fingerprint of its plan-year event rows in canonical order. Later schemas
 * re-derive it with their own function; this one stays as released. */
type R1 = typeof next.schema.relations
const filingDigest0001 = (
	plan: Uuid,
	year: number,
	rows: {
		receipts: readonly Fact<R1["PlanReceipt"]>[]
		receiptDates: readonly Fact<R1["PlanReceiptDate"]>[]
		receiptAllocations: readonly Fact<R1["ReceiptAllocation"]>[]
		conversions: readonly Fact<R1["RothConversion"]>[]
		conversionReceipts: readonly Fact<R1["ConversionReceipt"]>[]
		reportedConversions: readonly Fact<R1["ReportedReceiptConversion"]>[]
		suppliedTax: readonly Fact<R1["SuppliedConversionTax"]>[]
		suppliedReports: readonly Fact<R1["RetirementReport"]>[]
		contributions: readonly Fact<R1["RetirementContribution"]>[]
	}
) => {
	const span = periodSpan(year, "Year")
	const receipts = rows.receipts.filter((r) => r.plan === plan && r.year === BigInt(year))
	const conversions = rows.conversions.filter(
		(r) => r.plan === plan && r.convertedOn >= span.start && r.convertedOn < span.end
	)
	const contributionIds = new Set(
		rows.contributions.filter((r) => r.plan === plan && r.year === BigInt(year)).map((r) => r.id)
	)
	const conversionIds = new Set(conversions.map((r) => r.id)),
		receiptIds = new Set(receipts.map((r) => r.id))
	const canonical = <T>(values: readonly T[]) => [...values].sort((a, b) => json(a).localeCompare(json(b)))
	return createHash("sha256")
		.update(
			json({
				receipts: canonical(receipts),
				receiptDates: canonical(rows.receiptDates.filter((r) => receiptIds.has(r.receipt))),
				receiptAllocations: canonical(
					rows.receiptAllocations.filter(
						(r) => contributionIds.has(r.contribution) || receiptIds.has(r.receipt)
					)
				),
				conversions: canonical(conversions),
				conversionReceipts: canonical(
					rows.conversionReceipts.filter((r) => conversionIds.has(r.conversion) || receiptIds.has(r.receipt))
				),
				reportedConversions: canonical(rows.reportedConversions.filter((r) => receiptIds.has(r.receipt))),
				suppliedTax: canonical(rows.suppliedTax.filter((r) => conversionIds.has(r.conversion))),
				suppliedReports: canonical(
					rows.suppliedReports.filter((r) => r.plan === plan && r.year === BigInt(year))
				)
			})
		)
		.digest("hex")
}

export const populateStatements = (source: Old, target: Next, mint: Effect.Effect<Uuid>) =>
	Effect.gen(function* () {
		const { say, write, flush } = writer(target)
		const convert = (row: Record<string, unknown>) => {
			const { recordedAt: _recordedAt, verifiedAt: _verifiedAt, ...rest } = row
			return typeof rest.evidence === "string" ? { ...rest, evidence: say(rest.evidence) } : rest
		}
		const carried = new Map<string, readonly Record<string, unknown>[]>()
		for (const name of straight) {
			const rows = yield* read(source, byName(name))
			const converted = rows.map((row) => convert(row as Record<string, unknown>))
			carried.set(name, converted)
			yield* write(nextByName(name) as never, converted as never)
		}
		for (const name of gainId) {
			const rows = yield* read(source, byName(name))
			const converted = []
			for (const row of rows) converted.push({ id: yield* mint, ...convert(row as Record<string, unknown>) })
			carried.set(name, converted)
			yield* write(nextByName(name) as never, converted as never)
		}
		// A retirement filing's frozen basis is a digest over its plan-year event
		// rows. Those rows changed representation, so each stored digest is
		// re-derived over the migrated rows with the current digest function.
		const rowsOf = <K extends keyof NextRelations>(name: K) =>
			(carried.get(name) ?? []) as readonly Fact<Extract<NextRelations[K], { kind: "relation" }>>[]
		const filings = rowsOf("Filing"),
			subjects = rowsOf("PlanSubject")
		const bases: Fact<typeof next.schema.relations.RetirementFilingBasis>[] = []
		for (const basis of yield* read(source, old.schema.relations.RetirementFilingBasis)) {
			const filing = filings.find((row) => row.id === basis.filing)
			const plan = subjects.find((row) => row.subject === filing?.subject)?.plan
			if (!filing || !plan)
				return yield* Effect.fail(
					new Refusal({
						code: "MigrationConflict",
						message: `Filing basis ${basis.version} has no plan filing`
					})
				)
			const digest = filingDigest0001(plan, toCalendarDate(epochDay(filing.period.start)).year, {
				receipts: rowsOf("PlanReceipt"),
				receiptDates: rowsOf("PlanReceiptDate"),
				receiptAllocations: rowsOf("ReceiptAllocation"),
				conversions: rowsOf("RothConversion"),
				conversionReceipts: rowsOf("ConversionReceipt"),
				reportedConversions: rowsOf("ReportedReceiptConversion"),
				suppliedTax: rowsOf("SuppliedConversionTax"),
				suppliedReports: rowsOf("RetirementReport"),
				contributions: rowsOf("RetirementContribution")
			})
			bases.push({ version: basis.version, filing: basis.filing, digest })
		}
		yield* write(next.schema.relations.RetirementFilingBasis, bases)
		// TaxBand.span → wages
		yield* write(
			next.schema.relations.TaxBand,
			(yield* read(source, old.schema.relations.TaxBand)).map(({ span, ...row }) => ({ ...row, wages: span }))
		)
		// BankObservation.source → evidence
		yield* write(
			next.schema.relations.BankObservation,
			(yield* read(source, old.schema.relations.BankObservation)).map(
				({ source: text, recordedAt: _r, ...row }) => ({
					...row,
					evidence: say(text)
				})
			)
		)
		// VerifiedArtifact loses verifiedAt
		yield* write(
			next.schema.relations.VerifiedArtifact,
			(yield* read(source, old.schema.relations.VerifiedArtifact)).map(({ verifiedAt: _v, ...row }) => row)
		)
		// Locations: Drive proofs become copies; their prior locations follow.
		const locations = yield* read(source, old.schema.relations.ArtifactLocation)
		const copies: Fact<typeof next.schema.relations.DriveCopy>[] = []
		const priors: Fact<typeof next.schema.relations.PriorLocation>[] = []
		const plain: Fact<typeof next.schema.relations.ArtifactLocation>[] = []
		for (const location of locations) {
			const id = driveId(location.locator)
			if (id && DriveEvidence.test(location.evidence)) {
				const proof = JSON.parse(location.evidence) as {
					remote: string
					evidence: string
					previousLocations?: readonly { locator: string; evidence: string }[]
				}
				const copy = yield* mint
				copies.push({
					id: copy,
					artifact: location.artifact,
					driveId: id,
					remote: proof.remote,
					evidence: say(proof.evidence)
				})
				const seen = new Set<string>()
				for (const prior of proof.previousLocations ?? []) {
					const key = `${prior.locator}\u0000${prior.evidence}`
					if (seen.has(key)) continue
					seen.add(key)
					priors.push({
						copy,
						artifact: location.artifact,
						locator: prior.locator,
						evidence: say(prior.evidence)
					})
				}
			} else
				plain.push({
					artifact: location.artifact,
					locator: location.locator,
					evidence: say(location.evidence)
				})
		}
		if (copies.some((copy, index) => copies.findIndex((other) => other.artifact === copy.artifact) !== index))
			return yield* Effect.fail(
				new Refusal({ code: "MigrationConflict", message: "An artifact has two Drive locations" })
			)
		yield* write(next.schema.relations.DriveCopy, copies)
		yield* write(next.schema.relations.PriorLocation, priors)
		yield* write(next.schema.relations.ArtifactLocation, plain)
		// Questions and answers from the four families.
		const questions: Fact<typeof next.schema.relations.Question>[] = []
		const employeeArms: Fact<typeof next.schema.relations.EmployeeQuestion>[] = []
		const planArms: Fact<typeof next.schema.relations.PlanQuestion>[] = []
		const bookArms: Fact<typeof next.schema.relations.BookkeepingQuestion>[] = []
		const accountArms: Fact<typeof next.schema.relations.AccountQuestion>[] = []
		const answers: Fact<typeof next.schema.relations.Answer>[] = []
		const employees = yield* read(source, old.schema.relations.Employee)
		const plans = yield* read(source, old.schema.relations.RetirementPlan)
		const businessOf = (employee: Uuid) => {
			const row = employees.find((e) => e.id === employee)
			if (!row)
				throw new Refusal({ code: "MigrationConflict", message: `Review names unknown employee ${employee}` })
			return row.business
		}
		for (const review of yield* read(source, old.schema.relations.Review)) {
			const business = businessOf(review.employee)
			questions.push({ id: review.id, business, kind: "Review", detail: review.detail })
			employeeArms.push({
				question: review.id,
				business,
				employee: review.employee,
				year: review.year,
				topic: review.topic
			})
		}
		for (const resolution of yield* read(source, old.schema.relations.Resolution))
			answers.push({ id: yield* mint, question: resolution.review, evidence: say(resolution.evidence) })
		for (const setup of yield* read(source, old.schema.relations.RetirementSetup)) {
			const plan = plans.find((p) => p.id === setup.plan)
			if (!plan)
				throw new Refusal({ code: "MigrationConflict", message: `Setup names unknown plan ${setup.plan}` })
			questions.push({ id: setup.id, business: plan.business, kind: "PlanSetup", detail: setup.detail })
			planArms.push({
				question: setup.id,
				business: plan.business,
				plan: plan.id,
				evidence: say(setup.evidence)
			})
		}
		for (const resolution of yield* read(source, old.schema.relations.RetirementSetupResolution))
			answers.push({ id: yield* mint, question: resolution.setup, evidence: say(resolution.evidence) })
		for (const issue of yield* read(source, old.schema.relations.BookkeepingIssue)) {
			questions.push({ id: issue.id, business: issue.business, kind: "Bookkeeping", detail: issue.detail })
			bookArms.push({ question: issue.id, evidence: say(issue.evidence) })
		}
		for (const resolution of yield* read(source, old.schema.relations.BookkeepingResolution))
			answers.push({ id: yield* mint, question: resolution.issue, evidence: say(resolution.evidence) })
		const paymentIssues = yield* read(source, old.schema.relations.PaymentIssue)
		for (const issue of yield* read(source, old.schema.relations.FinancialIssue)) {
			const account = paymentIssues.find((p) => p.issue === issue.id)
			if (!account)
				throw new Refusal({
					code: "MigrationConflict",
					message: `Financial issue ${issue.id} has no account`
				})
			questions.push({ id: issue.id, business: issue.business, kind: "TaxAccount", detail: issue.detail })
			accountArms.push({
				question: issue.id,
				business: issue.business,
				account: account.account,
				evidence: say(issue.evidence)
			})
		}
		for (const resolution of yield* read(source, old.schema.relations.FinancialResolution))
			answers.push({ id: yield* mint, question: resolution.issue, evidence: say(resolution.evidence) })
		yield* write(next.schema.relations.Question, questions)
		yield* write(next.schema.relations.EmployeeQuestion, employeeArms)
		yield* write(next.schema.relations.PlanQuestion, planArms)
		yield* write(next.schema.relations.BookkeepingQuestion, bookArms)
		yield* write(next.schema.relations.AccountQuestion, accountArms)
		yield* write(next.schema.relations.Answer, answers)
		// NegativeApplication: v1 kept negative-application evidence inside the
		// reconciliation's JSON evidence when present. None exists in the live
		// ledger (every reconciliation evidence is plain prose); nothing to carry.
		yield* flush()
	})
