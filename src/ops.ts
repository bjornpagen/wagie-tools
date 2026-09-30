import type { NativeRuntime, Uuid } from "@bjornpagen/bumbledb"
import type { TerminalReceipt } from "@bjornpagen/bumbledb-log"
import { Effect, Schema, type Scope } from "effect"
import { auditLedger } from "./audit.ts"
import { backupLedger, restoreArchive, verifyArchive } from "./backup.ts"
import { BookkeepingInput, operations, recordBookkeeping } from "./bookkeeping.ts"
import { civilDaySpan, today, type UnixEpochDay } from "./core/time.ts"
import { EntityId, Nonblank, Refusal } from "./core/values.ts"
import {
	ArchiveInput,
	AttachBankInput,
	archiveArtifact,
	attachBankArtifact,
	collectDocuments,
	inspectDocuments
} from "./documents.ts"
import {
	ArtifactLocateInput,
	ArtifactRecordInput,
	ArtifactVerifyInput,
	locateArtifact,
	MailingRecordInput,
	recordArtifact,
	recordMailing,
	verifyArtifact
} from "./evidence.ts"
import {
	ExpectRetirementInput,
	ensureFilings,
	expectRetirementFiling,
	FilingEnsureInput
} from "./filing-coverage.ts"
import {
	amendFiling,
	FilingAmendInput,
	FilingDeadlineInput,
	FilingPrepareInput,
	FilingRejectInput,
	FilingSubmitInput,
	inspectFilings,
	prepareFiling,
	rejectFiling,
	reviseDeadline,
	submitFiling
} from "./filings.ts"
import {
	DispositionInput,
	disposeLiability,
	PaymentReconcileInput,
	PaymentRecordInput,
	reconcilePayments,
	recordPayment
} from "./payments.ts"
import {
	CalculateInput,
	calculatePayroll,
	inspectCalculation,
	PostInput,
	payrollReadback,
	postPayroll,
	ReviseInput,
	revisePayrollTax
} from "./payroll.ts"
import {
	AnnualEvidenceInput,
	AnnualPolicyInput,
	ElectionDocumentInput,
	RefreshInput,
	recordAnnualEvidence,
	recordAnnualPolicy,
	recordElectionDocument,
	refreshPolicy
} from "./policy/annual.ts"
import { ActivateInput, activatePolicy, inspectPolicy, installPolicy, PolicyInput } from "./policy/install.ts"
import {
	AssignmentInput,
	assignCompensation,
	BudgetInput,
	BusinessInput,
	configureBusiness,
	ElectionInput,
	EmployeeInput,
	inspectProfiles,
	recordBudget,
	recordElection,
	recordEmployee
} from "./profiles.ts"
import { AnswerInput, AskInput, answerQuestion, questions, recordQuestion } from "./questions.ts"
import { RecoveryRecordInput, recordRecovery } from "./recoveries.ts"
import { report } from "./reports.ts"
import { type Ledger, latest, parseStrict, resolveRequest } from "./runtime.ts"
import { commandFields, Day, DaySpan, Id, YearNumber } from "./schema/input.ts"
import { suggestGross } from "./suggestions.ts"
import { workRegister } from "./work.ts"

type Env = Ledger | NativeRuntime | Scope.Scope
type Write = {
	readonly summary: string
	readonly input: Schema.Top
	readonly run: (payload: unknown) => Effect.Effect<TerminalReceipt, unknown, Env>
	readonly readback?: (receipt: TerminalReceipt) => Effect.Effect<unknown, unknown, Env>
}

/** The flat input of one bookkeeping arm: the command fields plus the arm's
 * own fields. A two-shaped arm (Contribution) stays a union of both shapes. */
const flatArm = (arm: Schema.Top): Schema.Top => {
	if ("members" in arm && Array.isArray(arm.members)) return Schema.Union(arm.members.map(flatArm))
	const { kind: _kind, ...fields } = (arm as unknown as { fields: Schema.Struct.Fields }).fields
	return Schema.Struct({ ...commandFields, evidence: Nonblank, ...fields })
}

/** One bookkeeping arm as a flat op: {request, business, evidence, ...arm}. */
const bookkeeping = (kind: keyof typeof operations, summary: string): Write => ({
	summary,
	input: flatArm(operations[kind]),
	run: (payload) =>
		Effect.gen(function* () {
			const { request, business, evidence, ...arm } = payload as Record<string, unknown>
			return yield* recordBookkeeping({ request, business, evidence, operation: { kind, ...arm } })
		})
})

/** Every write the ledger accepts, by name. The CLI, `wagie schema`, the
 * skill file and the work register's `next` intents all use these names. */
export const writes = {
	"business.configure": {
		summary: "Create or update the business, its addresses, state account and tax accounts",
		input: BusinessInput,
		run: configureBusiness
	},
	"employee.record": { summary: "Create or update an employee", input: EmployeeInput, run: recordEmployee },
	"compensation.budget": {
		summary: "Record an evidenced annual gross salary target",
		input: BudgetInput,
		run: recordBudget
	},
	"compensation.assign": {
		summary: "Assign an observed compensation commitment to its annual budget",
		input: AssignmentInput,
		run: assignCompensation
	},
	"election.document": {
		summary: "Record a signed retirement election document and its four amounts",
		input: ElectionDocumentInput,
		run: recordElectionDocument
	},
	"election.record": {
		summary: "Activate a signed election document from an effective date",
		input: ElectionInput,
		run: recordElection
	},
	"question.ask": {
		summary: "Open a question; its kind decides what it holds back",
		input: AskInput,
		run: recordQuestion
	},
	"question.answer": {
		summary: "Close a question with the evidence that answers it",
		input: AnswerInput,
		run: answerQuestion
	},
	"policy.install": { summary: "Install a hashed policy release", input: PolicyInput, run: installPolicy },
	"policy.activate": {
		summary: "Select the active policy release",
		input: ActivateInput,
		run: activatePolicy
	},
	"policy.annual": {
		summary: "Record one authority's published annual rules and sources",
		input: AnnualPolicyInput,
		run: recordAnnualPolicy
	},
	"policy.evidence": {
		summary: "Record employer-specific annual evidence",
		input: AnnualEvidenceInput,
		run: recordAnnualEvidence
	},
	"policy.refresh": {
		summary: "Approve an authority's annual policy for the active release",
		input: RefreshInput,
		run: refreshPolicy
	},
	"filings.ensure": {
		summary: "Materialize applicable filings through a year",
		input: FilingEnsureInput,
		run: ensureFilings
	},
	"filings.expect-retirement": {
		summary: "Record an externally prepared 1099-R filing expectation",
		input: ExpectRetirementInput,
		run: expectRetirementFiling
	},
	"filings.prepare": {
		summary: "Freeze a filing's figures and documents as a version",
		input: FilingPrepareInput,
		run: prepareFiling
	},
	"filings.submit": {
		summary: "Record an actual submission of a prepared version",
		input: FilingSubmitInput,
		run: submitFiling
	},
	"filings.reject": { summary: "Record an agency rejection", input: FilingRejectInput, run: rejectFiling },
	"filings.deadline": {
		summary: "Record an evidenced deadline change",
		input: FilingDeadlineInput,
		run: reviseDeadline
	},
	"filings.amend": {
		summary: "Open a correction filing for a submitted return",
		input: FilingAmendInput,
		run: amendFiling
	},
	"mailing.record": {
		summary: "Record a certified mailing with its tracking number",
		input: MailingRecordInput,
		run: recordMailing
	},
	"payment.record": {
		summary: "Record a tax payment already sent",
		input: PaymentRecordInput,
		run: recordPayment
	},
	"payment.reconcile": {
		summary: "Attribute tax payments to liability entries",
		input: PaymentReconcileInput,
		run: reconcilePayments
	},
	"payment.dispose": {
		summary: "Record an evidenced disposition of a negative liability",
		input: DispositionInput,
		run: disposeLiability
	},
	"payroll.calculate": {
		summary: "Price a new wage (NewWage), a zero-cash Roth wire (RothOnly), or a tax revision",
		input: CalculateInput,
		run: calculatePayroll,
		readback: payrollReadback
	},
	"payroll.post": {
		summary: "Post a calculated wage after its Mercury payment was sent",
		input: PostInput,
		run: postPayroll,
		readback: payrollReadback
	},
	"payroll.revise-tax": {
		summary: "Reassess a posted wage's taxes",
		input: ReviseInput,
		run: revisePayrollTax,
		readback: payrollReadback
	},
	"recovery.record": {
		summary: "Attribute an actual recovery deduction to the wages it collected",
		input: RecoveryRecordInput,
		run: recordRecovery
	},
	"artifact.record": {
		summary: "Register a document's exact bytes",
		input: ArtifactRecordInput,
		run: recordArtifact
	},
	"artifact.locate": {
		summary: "Record a non-Drive location",
		input: ArtifactLocateInput,
		run: locateArtifact
	},
	"artifact.verify": {
		summary: "Re-verify a document's bytes",
		input: ArtifactVerifyInput,
		run: verifyArtifact
	},
	"artifact.archive": {
		summary: "Adopt a verified Google Drive copy of a document",
		input: ArchiveInput,
		run: (payload) => archiveArtifact(payload)
	},
	"artifact.attach-bank": {
		summary: "Attach a Mercury receipt to an existing bank movement",
		input: AttachBankInput,
		run: attachBankArtifact
	},
	"bank.movement": bookkeeping("BankMovement", "Record an actual Mercury movement by its transaction ID"),
	"bank.distribution": bookkeeping("Distribution", "Allocate a movement's cents to an owner distribution"),
	"bank.distribution-return": bookkeeping(
		"DistributionReturn",
		"Link an inflow returning part of a distribution"
	),
	"bank.distribution-review": bookkeeping(
		"DistributionReview",
		"Freeze a year's distributions for the tax handoff"
	),
	"bank.payroll-cash": bookkeeping("PayrollCash", "Link an existing movement as a wage's cash"),
	"retirement.plan": bookkeeping("Plan", "Record the owner's retirement plan"),
	"retirement.account": bookkeeping("Account", "Record a plan account"),
	"retirement.annual": bookkeeping("Annual", "Record a year's limits and owner attestations"),
	"retirement.contribution": bookkeeping("Contribution", "Record an already completed contribution"),
	"retirement.authorize-after-tax": bookkeeping(
		"AuthorizeAfterTax",
		"Reserve after-tax capacity; sends no money"
	),
	"retirement.cancel-authorization": bookkeeping("CancelAuthorization", "Release an unspent authorization"),
	"retirement.fund": bookkeeping("FundContribution", "Link a Mercury movement that funded a contribution"),
	"retirement.receipt": bookkeeping("ProviderReceipt", "Record the plan provider's confirmed receipt"),
	"retirement.allocate-receipt": bookkeeping("AllocateReceipt", "Allocate a receipt to contributions"),
	"retirement.conversion": bookkeeping("Conversion", "Record an after-tax to Roth conversion"),
	"retirement.supplied-tax": bookkeeping("SuppliedTax", "Store externally supplied conversion tax amounts"),
	"retirement.supplied-report": bookkeeping("SuppliedReport", "Link supplied provider report data"),
	"retirement.confirm-reported-conversion": bookkeeping(
		"ConfirmReportedConversion",
		"Confirm a whole receipt's conversion from a supplied report"
	),
	"retirement.balance": bookkeeping("Balance", "Record a dated provider balance")
} satisfies Record<string, Write>

type ReadContext = { readonly asOf: UnixEpochDay }
type Read = {
	readonly summary: string
	readonly input: Schema.Top
	readonly run: (input: never, context: ReadContext) => Effect.Effect<unknown, unknown, Env>
}
const business = { business: Id, asOf: Schema.optional(Day) }
const read = <S extends Schema.Top>(
	summary: string,
	input: S,
	run: (input: S["Type"], context: ReadContext) => Effect.Effect<unknown, unknown, Env>
): Read => ({ summary, input, run: run as Read["run"] })

/** Every read, by name. Reads never write. */
export const reads = {
	status: read(
		"Open work, what blocks payroll, and readiness notes. Each item names its next op",
		Schema.Struct(business),
		(input, { asOf }) =>
			Effect.gen(function* () {
				const register = yield* workRegister(yield* latest, input.business, asOf)
				return {
					business: register.business,
					asOf: register.asOf,
					state: register.state,
					blockers: register.blockers,
					open: register.work.filter((item) => item.status !== "Complete"),
					readiness: register.readiness
				}
			})
	),
	work: read("Every work item, complete ones included", Schema.Struct(business), (input, { asOf }) =>
		Effect.gen(function* () {
			return yield* workRegister(yield* latest, input.business, asOf)
		})
	),
	report: read(
		"Year or quarter figures, bookkeeping and the work register",
		Schema.Struct({
			...business,
			year: YearNumber,
			quarter: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })))
		}),
		(input, { asOf }) =>
			Effect.gen(function* () {
				return yield* report(yield* latest, input.business, input.year, input.quarter, asOf)
			})
	),
	"business.inspect": read(
		"Business, employees, elections, allowances, accounts and budgets",
		Schema.Struct({ business: Id }),
		(input) =>
			Effect.gen(function* () {
				return yield* inspectProfiles(yield* latest, input.business)
			})
	),
	questions: read("Every question and its answer", Schema.Struct({ business: Id }), (input) =>
		Effect.gen(function* () {
			return yield* questions(yield* latest, input.business)
		})
	),
	"filings.inspect": read("Filings, versions and submissions", Schema.Struct(business), (input, { asOf }) =>
		Effect.gen(function* () {
			return yield* inspectFilings(yield* latest, input.business, asOf)
		})
	),
	"policy.inspect": read(
		"Active policy, annual rules and coverage",
		Schema.Struct({ business: Id }),
		(input) =>
			Effect.gen(function* () {
				return yield* inspectPolicy(yield* latest, input.business)
			})
	),
	"payroll.inspect": read(
		"One calculation's figures and paycheck",
		Schema.Struct({ business: Id, calculation: Id }),
		(input) =>
			Effect.gen(function* () {
				return yield* inspectCalculation(yield* latest, input.business, input.calculation as Uuid)
			})
	),
	"compensation.suggest": read(
		"Suggest a gross from the remaining annual budget",
		Schema.Struct({ business: Id, employee: Id, paidOn: Day, work: DaySpan }),
		(input, { asOf }) =>
			Effect.gen(function* () {
				return yield* suggestGross(
					yield* latest,
					input.business,
					input.employee,
					civilDaySpan(input.work.start, input.work.end),
					input.paidOn,
					asOf
				)
			})
	),
	"artifact.audit": read(
		"Every document, its Drive copy and locations; verify re-reads each document's bytes",
		Schema.Struct({ verify: Schema.optional(Schema.Boolean), remote: Schema.optional(Nonblank) }),
		(input) =>
			Effect.gen(function* () {
				const snapshot = yield* latest
				const documents = yield* inspectDocuments(snapshot)
				const verified = input.verify
					? (yield* collectDocuments(snapshot, input.remote ?? "gdrive:", undefined)).map(
							({ bytes, ...document }) => ({ ...document, length: BigInt(bytes.length) })
						)
					: []
				return {
					state: snapshot.stateStamp,
					total: BigInt(documents.length),
					unarchived: documents.filter((d) => !d.archived).map((d) => d.id),
					documents,
					verified
				}
			})
	),
	"command.resolve": read("Resolve a retained request's outcome", Schema.Struct({ request: Id }), (input) =>
		resolveRequest(input.request)
	),
	"db.audit": read(
		"Every fact digest, count and report projection",
		Schema.Struct({ asOf: Schema.optional(Day) }),
		(_, { asOf }) =>
			Effect.gen(function* () {
				return yield* auditLedger(yield* latest, asOf)
			})
	)
} satisfies Record<string, Read>

/** Maintenance outside the domain command log. A backup reads the open
 * ledger; verifying and restoring an archive never open the live ledger. */
export const backups = {
	"db.backup": {
		summary: "Capture, verify and package a native backup of the open ledger",
		input: Schema.Struct({ operation: EntityId, output: Nonblank }),
		run: (input: { operation: string; output: string }) => backupLedger(input)
	}
} as const
export const archives = {
	"db.verify-backup": {
		summary: "Restore an archive in isolation and compare every fact",
		input: Schema.Struct({ archive: Nonblank }),
		run: (input: { archive: string }) => verifyArchive(input.archive)
	},
	"db.restore": {
		summary: "Restore an archive into a new directory and binding",
		input: Schema.Struct({
			operation: EntityId,
			archive: Nonblank,
			directory: Nonblank,
			bindingOutput: Nonblank
		}),
		run: (input: { operation: string; archive: string; directory: string; bindingOutput: string }) =>
			restoreArchive(input)
	}
} as const

export const readAsOf = (asOf: UnixEpochDay | undefined, timeZone: string) =>
	asOf === undefined ? today(timeZone) : Effect.succeed(asOf)

export const refuseUnknown = (kind: string, name: string, known: readonly string[]) =>
	Effect.fail(
		new Refusal({ code: "UnknownOperation", message: `No ${kind} "${name}". Known: ${known.join(", ")}` })
	)

export const decodeInput = <S extends Schema.Top>(schema: S, payload: unknown): S["Type"] =>
	parseStrict(schema as never, payload) as S["Type"]

export { BookkeepingInput }
