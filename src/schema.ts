import {
	alternatives,
	bool,
	capacity,
	closedId,
	contained,
	duration,
	i64,
	interval,
	key,
	mirrors,
	on,
	ref,
	relation,
	schema,
	select,
	str,
	u64,
	uuid,
	weigh,
	within
} from "@bjornpagen/bumbledb"
import {
	AccountFamily,
	AssessmentOrigin,
	Authority,
	annualRequirements,
	BandRole,
	BankStatus,
	CalculationMethod,
	CalculationPurpose,
	CashDirection,
	CashPurpose,
	CheckpointKind,
	CommitmentOrigin,
	Component,
	ContributionOrigin,
	ContributionSource,
	componentPolicy,
	components,
	DeductionKind,
	DocumentRole,
	DueRule,
	ElectionContributionKind,
	FilingKind,
	FinancialScope,
	Form,
	formPolicy,
	forms,
	GrossSuggestionMethod,
	Payer,
	PeriodKind,
	PlanAccountKind,
	PolicyEvidenceKind,
	PolicyLimitKind,
	Program,
	PublishedRateKind,
	payrollForms,
	RevisionKind,
	State,
	SubjectKind,
	SubmissionMethod,
	submissionSlots,
	VersionOrigin
} from "./schema/vocabulary.ts"

export {
	AccountFamily,
	AssessmentOrigin,
	Authority,
	BandRole,
	BankStatus,
	CalculationMethod,
	CalculationPurpose,
	CashDirection,
	CashPurpose,
	CheckpointKind,
	CommitmentOrigin,
	Component,
	ContributionOrigin,
	ContributionSource,
	DeductionKind,
	DocumentRole,
	DueRule,
	ElectionContributionKind,
	FilingKind,
	FinancialScope,
	Form,
	GrossSuggestionMethod,
	Payer,
	PeriodKind,
	PlanAccountKind,
	PolicyEvidenceKind,
	PolicyLimitKind,
	Program,
	PublishedRateKind,
	RevisionKind,
	State,
	SubjectKind,
	SubmissionMethod,
	VersionOrigin
} from "./schema/vocabulary.ts"

// Cash is counted here once. Domain allocations qualify the same movement.

export const BankMovement = relation("BankMovement", {
	id: uuid,
	business: uuid,
	direction: closedId(CashDirection),
	paidOn: i64,
	amount: u64,
	evidence: str,
	recordedAt: i64
})
export const MercuryTransaction = relation("MercuryTransaction", { movement: uuid, reference: str })
export const PayrollTransaction = relation("PayrollTransaction", {
	wage: uuid,
	movement: uuid,
	business: uuid
})
export const PlanReceiptDate = relation("PlanReceiptDate", { receipt: uuid, day: i64, evidence: str })
export const BankObservation = relation("BankObservation", {
	id: uuid,
	business: uuid,
	artifact: uuid,
	row: u64,
	status: closedId(BankStatus),
	observedOn: i64,
	amount: u64,
	source: str,
	recordedAt: i64
})
export const BankSource = relation("BankSource", { movement: uuid, observation: uuid, business: uuid })
export const BankRetry = relation("BankRetry", { failed: uuid, succeeded: uuid, evidence: str })
export const CashAllocation = relation("CashAllocation", {
	id: uuid,
	movement: uuid,
	business: uuid,
	purpose: closedId(CashPurpose),
	amount: u64,
	evidence: str
})
export const PayrollCashBinding = relation("PayrollCashBinding", {
	allocation: uuid,
	wage: uuid,
	business: uuid
})
export const BankTaxPayment = relation("BankTaxPayment", { allocation: uuid, payment: uuid, business: uuid })
export const Owner = relation("Owner", { business: uuid, employee: uuid, evidence: str })
export const OwnerDistribution = relation("OwnerDistribution", {
	id: uuid,
	allocation: uuid,
	business: uuid,
	owner: uuid,
	paidOn: i64,
	amount: u64,
	evidence: str,
	recordedAt: i64
})
export const DistributionReturn = relation("DistributionReturn", {
	id: uuid,
	distribution: uuid,
	allocation: uuid,
	business: uuid,
	amount: u64,
	paidOn: i64,
	evidence: str,
	recordedAt: i64
})
export const DistributionReview = relation("DistributionReview", {
	id: uuid,
	business: uuid,
	year: i64,
	digest: str,
	evidence: str,
	recordedAt: i64
})
export const RetirementPlan = relation("RetirementPlan", {
	id: uuid,
	business: uuid,
	employee: uuid,
	name: str,
	ein: str,
	evidence: str,
	recordedAt: i64
})
export const PlanAccount = relation("PlanAccount", {
	id: uuid,
	plan: uuid,
	kind: closedId(PlanAccountKind),
	provider: str,
	reference: str,
	evidence: str
})
export const RetirementAnnual = relation("RetirementAnnual", {
	id: uuid,
	plan: uuid,
	employee: uuid,
	year: i64,
	valid: interval(i64),
	deferralLimit: u64,
	additionsLimit: u64,
	compensationCap: u64,
	outsideDeferrals: u64,
	outsideAdditions: u64,
	otherPlans: bool,
	outsideAssets: bool,
	evidence: str,
	recordedAt: i64
})
export const RetirementContribution = relation("RetirementContribution", {
	id: uuid,
	business: uuid,
	plan: uuid,
	employee: uuid,
	year: i64,
	amount: u64,
	source: closedId(ContributionSource),
	origin: closedId(ContributionOrigin),
	evidence: str,
	recordedAt: i64
})
export const ContributionCancellation = relation("ContributionCancellation", {
	contribution: uuid,
	evidence: str,
	recordedAt: i64
})
export const ContributionElection = relation("ContributionElection", {
	contribution: uuid,
	document: uuid,
	employee: uuid,
	year: i64
})
export const ContributionAuthorization = relation("ContributionAuthorization", {
	contribution: uuid,
	annual: uuid,
	employee: uuid,
	year: i64,
	authorizedOn: interval(i64, 1n)
})
export const ContributionDeduction = relation("ContributionDeduction", {
	contribution: uuid,
	wage: uuid,
	employee: uuid,
	year: i64,
	amount: u64,
	kind: closedId(DeductionKind)
})
// After-tax funding reuses the distribution allocation, never a second cash allocation.
export const ContributionFunding = relation("ContributionFunding", {
	contribution: uuid,
	allocation: uuid,
	business: uuid,
	source: closedId(ContributionSource),
	amount: u64
})

export const ProviderOperation = relation("ProviderOperation", {
	id: uuid,
	plan: uuid,
	provider: str,
	reference: str,
	evidence: str,
	recordedAt: i64
})
export const PlanReceipt = relation("PlanReceipt", {
	id: uuid,
	plan: uuid,
	operation: uuid,
	account: uuid,
	source: closedId(ContributionSource),
	year: i64,
	observedOn: i64,
	amount: u64,
	evidence: str,
	recordedAt: i64
})
export const ReceiptAllocation = relation("ReceiptAllocation", {
	receipt: uuid,
	contribution: uuid,
	plan: uuid,
	amount: u64
})
export const RothConversion = relation("RothConversion", {
	id: uuid,
	plan: uuid,
	operation: uuid,
	fromAccount: uuid,
	toAccount: uuid,
	convertedOn: i64,
	amount: u64,
	evidence: str,
	recordedAt: i64
})
export const ConversionReceipt = relation("ConversionReceipt", {
	conversion: uuid,
	receipt: uuid,
	plan: uuid,
	amount: u64
})
export const SuppliedConversionTax = relation("SuppliedConversionTax", {
	conversion: uuid,
	field: str,
	amount: u64,
	evidence: str
})
export const RetirementReport = relation("RetirementReport", {
	id: uuid,
	plan: uuid,
	year: i64,
	artifact: uuid,
	supplied: str,
	evidence: str,
	recordedAt: i64
})
// A supplied historical report can confirm a full receipt's conversion without
// inventing an event date. It cannot also consume dated conversion allocations.
export const ReportedReceiptConversion = relation("ReportedReceiptConversion", {
	receipt: uuid,
	report: uuid,
	plan: uuid,
	evidence: str,
	recordedAt: i64
})
export const PlanBalance = relation("PlanBalance", {
	id: uuid,
	account: uuid,
	asOf: i64,
	amount: u64,
	evidence: str,
	recordedAt: i64
})
export const RetirementSetup = relation("RetirementSetup", {
	id: uuid,
	plan: uuid,
	detail: str,
	evidence: str,
	recordedAt: i64
})
export const RetirementSetupResolution = relation("RetirementSetupResolution", {
	setup: uuid,
	evidence: str,
	recordedAt: i64
})
export const BookkeepingIssue = relation("BookkeepingIssue", {
	id: uuid,
	business: uuid,
	detail: str,
	evidence: str,
	recordedAt: i64
})
export const BookkeepingResolution = relation("BookkeepingResolution", {
	issue: uuid,
	evidence: str,
	recordedAt: i64
})
export const PlanSubject = relation("PlanSubject", { subject: uuid, plan: uuid, business: uuid })
export const RetirementFilingBasis = relation("RetirementFilingBasis", {
	version: uuid,
	filing: uuid,
	digest: str
})

export const Business = relation("Business", {
	id: uuid,
	name: str,
	ein: str,
	state: closedId(State),
	timeZone: str,
	recordedAt: i64
})
export const BusinessAddress = relation("BusinessAddress", {
	business: uuid,
	kind: str,
	street: str,
	city: str,
	state: str,
	zip: str,
	country: str
})
export const StateAccount = relation("StateAccount", {
	business: uuid,
	state: closedId(State),
	taxpayerNumber: str,
	evidence: str
})
export const Employee = relation("Employee", {
	id: uuid,
	business: uuid,
	firstName: str,
	lastName: str,
	ssn: str,
	address: str,
	filingStatus: str,
	recordedAt: i64
})
export const TaxAccount = relation("TaxAccount", {
	id: uuid,
	business: uuid,
	family: closedId(AccountFamily),
	evidence: str
})
export const AnnualBudget = relation("AnnualBudget", {
	id: uuid,
	employee: uuid,
	year: i64,
	limit: u64,
	evidence: str
})
export const BudgetCommitment = relation("BudgetCommitment", {
	id: uuid,
	employee: uuid,
	year: i64,
	amount: u64,
	origin: closedId(CommitmentOrigin),
	evidence: str
})
// Assignment is separate so an actual historical observation survives a missing budget.
export const BudgetAssignment = relation("BudgetAssignment", {
	commitment: uuid,
	budget: uuid,
	employee: uuid,
	year: i64,
	amount: u64
})
export const BankReference = relation("BankReference", {
	movement: uuid,
	issuer: str,
	scope: str,
	value: str,
	sourceText: str
})
export const Wage = relation("Wage", {
	id: uuid,
	requiresTransfer: bool,
	business: uuid,
	employee: uuid,
	year: i64,
	calendar: uuid,
	paidOn: interval(i64, 1n),
	commitment: uuid,
	gross: u64,
	initialRevision: uuid,
	recordedAt: i64
})
export const RegularWork = relation("RegularWork", { wage: uuid, employee: uuid, span: interval(i64) })
export const RegularCommitment = relation("RegularCommitment", { commitment: uuid, wage: uuid })
export const ObservedCompensation = relation("ObservedCompensation", {
	wage: uuid,
	commitment: uuid,
	evidence: str
})
export const Deduction = relation("Deduction", {
	wage: uuid,
	employee: uuid,
	year: i64,
	kind: closedId(DeductionKind),
	amount: u64,
	evidence: str
})
export const Election = relation("Election", {
	id: uuid,
	employee: uuid,
	year: i64,
	calendar: uuid,
	allowance: uuid,
	maximum: u64,
	signedOn: i64,
	effective: interval(i64),
	limit: u64,
	evidence: str
})
// Operational authorization is qualified by its signed source and annual review.
export const ElectionSource = relation("ElectionSource", {
	election: uuid,
	document: uuid,
	annual: uuid,
	employee: uuid,
	year: i64,
	signedOn: i64,
	kind: closedId(ElectionContributionKind),
	limit: u64
})
export const ElectionUse = relation("ElectionUse", {
	wage: uuid,
	election: uuid,
	employee: uuid,
	day: interval(i64, 1n),
	kind: closedId(DeductionKind),
	amount: u64
})
export const DeferralPolicy = relation("DeferralPolicy", {
	id: uuid,
	release: uuid,
	year: i64,
	limit: u64,
	evidence: str
})

export const GrossSuggestionPolicy = relation("GrossSuggestionPolicy", {
	id: uuid,
	release: uuid,
	method: closedId(GrossSuggestionMethod),
	evidence: str
})
export const EmployeeAllowance = relation("EmployeeAllowance", {
	id: uuid,
	employee: uuid,
	year: i64,
	policy: uuid,
	maximum: u64,
	limit: u64,
	evidence: str
})
export const Recovery = relation("Recovery", {
	id: uuid,
	fromWage: uuid,
	owedOnWage: uuid,
	employee: uuid,
	component: closedId(Component),
	kind: closedId(DeductionKind),
	amount: u64,
	evidence: str
})
export const Review = relation("Review", { id: uuid, employee: uuid, year: i64, topic: str, detail: str })
export const Resolution = relation("Resolution", { review: uuid, evidence: str, recordedAt: i64 })

export const PolicyRelease = relation("PolicyRelease", {
	id: uuid,
	sha256: str,
	title: str,
	evidence: str,
	recordedAt: i64
})
export const PolicyBinding = relation("PolicyBinding", { business: uuid, release: uuid, evidence: str })
// Published rules are independently observable. Employer approval is a separate,
// release-specific proof bounded by exactly one reviewed calendar year.

export const AnnualPolicy = relation("AnnualPolicy", {
	id: uuid,
	business: uuid,
	authority: closedId(Authority),
	year: i64,
	calendar: uuid,
	valid: interval(i64),
	evidence: str,
	recordedAt: i64
})
export const AnnualSource = relation("AnnualSource", {
	annual: uuid,
	artifact: uuid,
	evidence: str
})
export const PublishedRate = relation("PublishedRate", {
	annual: uuid,
	kind: closedId(PublishedRateKind),
	schedule: uuid,
	artifact: uuid,
	evidence: str
})
export const PolicyLimit = relation("PolicyLimit", {
	annual: uuid,
	kind: closedId(PolicyLimitKind),
	cents: u64,
	artifact: uuid,
	evidence: str
})
export const LookbackPeriod = relation("LookbackPeriod", {
	annual: uuid,
	span: interval(i64),
	artifact: uuid,
	evidence: str
})
export const AnnualEvidence = relation("AnnualEvidence", {
	annual: uuid,
	kind: closedId(PolicyEvidenceKind),
	artifact: uuid,
	evidence: str,
	recordedAt: i64
})
export const AnnualApproval = relation("AnnualApproval", {
	annual: uuid,
	release: uuid,
	business: uuid,
	authority: closedId(Authority),
	year: i64,
	valid: interval(i64),
	evidence: str,
	recordedAt: i64
})
export const CalculationPolicy = relation("CalculationPolicy", {
	calculation: uuid,
	annual: uuid,
	release: uuid,
	business: uuid,
	authority: closedId(Authority),
	day: interval(i64, 1n)
})

export const ElectionDocument = relation("ElectionDocument", {
	id: uuid,
	employee: uuid,
	year: i64,
	signedOn: i64,
	artifact: uuid,
	evidence: str,
	recordedAt: i64
})
export const ElectionDocumentRevision = relation("ElectionDocumentRevision", {
	document: uuid,
	predecessor: uuid,
	employee: uuid,
	year: i64
})
export const ElectionDocumentAmount = relation("ElectionDocumentAmount", {
	document: uuid,
	kind: closedId(ElectionContributionKind),
	cents: u64
})

export const EmployerRateNotice = relation("EmployerRateNotice", {
	id: uuid,
	business: uuid,
	state: closedId(State),
	schedule: uuid,
	valid: interval(i64),
	evidence: str
})
export const EmployerSchedule = relation("EmployerSchedule", {
	version: uuid,
	notice: uuid,
	business: uuid,
	schedule: uuid,
	valid: interval(i64)
})
export const FutaBasis = relation("FutaBasis", { version: uuid, evidence: str })
export const SupportedPayrollDomain = relation("SupportedPayrollDomain", {
	id: uuid,
	release: uuid,
	state: closedId(State),
	federalDepositLimit: u64,
	valid: interval(i64),
	evidence: str
})
export const MonthlyDepositor = relation("MonthlyDepositor", {
	id: uuid,
	business: uuid,
	valid: interval(i64),
	evidence: str
})
export const SupportedProgram = relation("SupportedProgram", {
	id: uuid,
	domain: uuid,
	program: closedId(Program),
	eligible: interval(u64),
	evidence: str
})
export const PolicyCoverage = relation("PolicyCoverage", {
	release: uuid,
	business: uuid,
	component: closedId(Component),
	span: interval(i64)
})
export const RateVersion = relation("RateVersion", {
	id: uuid,
	release: uuid,
	business: uuid,
	component: closedId(Component),
	valid: interval(i64),
	schedule: uuid,
	evidence: str
})
export const RateSchedule = relation("RateSchedule", {
	id: uuid,
	denominator: u64,
	domain: interval(u64),
	evidence: str
})
export const TaxBand = relation("TaxBand", {
	id: uuid,
	schedule: uuid,
	span: interval(u64),
	numerator: u64,
	role: closedId(BandRole)
})
export const TaxBaseScope = relation("TaxBaseScope", {
	id: uuid,
	business: uuid,
	employee: uuid,
	program: closedId(Program),
	year: i64,
	calendar: uuid,
	span: interval(i64)
})
export const StateBaseScope = relation("StateBaseScope", { scope: uuid, state: closedId(State) })
export const AssessmentSet = relation("AssessmentSet", {
	id: uuid,
	business: uuid,
	employee: uuid,
	paidOn: interval(i64, 1n),
	gross: u64,
	origin: closedId(AssessmentOrigin)
})
export const ObservedSet = relation("ObservedSet", { set: uuid, evidence: str })
export const PayrollCalculation = relation("PayrollCalculation", {
	id: uuid,
	set: uuid,
	request: uuid,
	domain: uuid,
	business: uuid,
	paidOn: interval(i64, 1n),
	release: uuid,
	purpose: closedId(CalculationPurpose),
	sourceStamp: str,
	recordingDay: i64,
	contextHash: str,
	evidence: str
})
export const ProposedWage = relation("ProposedWage", {
	calculation: uuid,
	business: uuid,
	paidOn: interval(i64, 1n),
	depositor: uuid,
	span: interval(i64),
	roth: u64,
	evidence: str
})
export const ProposedRevision = relation("ProposedRevision", {
	calculation: uuid,
	set: uuid,
	business: uuid,
	wage: uuid,
	predecessor: uuid,
	employee: uuid,
	paidOn: interval(i64, 1n),
	gross: u64,
	evidence: str
})
export const CalculationRecoveryClaim = relation("CalculationRecoveryClaim", {
	calculation: uuid,
	set: uuid,
	employee: uuid,
	owedOnWage: uuid,
	component: closedId(Component),
	amount: u64,
	evidence: str
})
export const Assessment = relation("Assessment", {
	set: uuid,
	origin: closedId(AssessmentOrigin),
	component: closedId(Component),
	method: closedId(CalculationMethod)
})
export const ObservedAssessment = relation("ObservedAssessment", {
	set: uuid,
	component: closedId(Component),
	amount: u64,
	evidence: str
})
export const TaxableWages = relation("TaxableWages", {
	set: uuid,
	program: closedId(Program),
	amount: u64,
	evidence: str
})
export const CalculatedAssessment = relation("CalculatedAssessment", {
	set: uuid,
	component: closedId(Component),
	basis: uuid
})
export const AppliedRule = relation("AppliedRule", {
	set: uuid,
	component: closedId(Component),
	version: uuid,
	schedule: uuid,
	release: uuid,
	business: uuid,
	day: interval(i64, 1n)
})
export const CalculationBasis = relation("CalculationBasis", {
	id: uuid,
	set: uuid,
	component: closedId(Component),
	scope: uuid,
	domain: uuid,
	support: uuid,
	business: uuid,
	employee: uuid,
	year: i64,
	paidOn: interval(i64, 1n),
	schedule: uuid,
	earning: interval(u64),
	cents: u64
})
// Components sharing a base program share one captured earning interval.
// Context evidence records the inspected wages; it is not an editable YTD override.
export const CalculationWageBase = relation("CalculationWageBase", {
	set: uuid,
	scope: uuid,
	cents: u64,
	earning: interval(u64),
	context: str
})
export const AssessmentRevision = relation("AssessmentRevision", {
	id: uuid,
	wage: uuid,
	set: uuid,
	business: uuid,
	employee: uuid,
	paidOn: interval(i64, 1n),
	gross: u64,
	kind: closedId(RevisionKind),
	recordedAt: i64
})
export const CorrectionAssessment = relation("CorrectionAssessment", {
	revision: uuid,
	predecessor: uuid,
	wage: uuid,
	evidence: str
})
export const RevisionAccount = relation("RevisionAccount", {
	revision: uuid,
	account: uuid,
	business: uuid,
	family: closedId(AccountFamily)
})

export const Artifact = relation("Artifact", { id: uuid, sha256: str, mediaType: str })
export const VerifiedArtifact = relation("VerifiedArtifact", { artifact: uuid, length: u64, verifiedAt: i64 })
export const ArtifactLocation = relation("ArtifactLocation", { artifact: uuid, locator: str, evidence: str })
export const TaxPayment = relation("TaxPayment", {
	id: uuid,
	business: uuid,
	account: uuid,
	sentOn: i64,
	amount: u64,
	evidence: str,
	recordedAt: i64
})
export const PaymentSettlement = relation("PaymentSettlement", {
	payment: uuid,
	settlesOn: i64,
	evidence: str
})
export const PaymentReference = relation("PaymentReference", {
	payment: uuid,
	issuer: str,
	scope: str,
	value: str,
	sourceText: str
})
export const PaymentEvidence = relation("PaymentEvidence", { payment: uuid, artifact: uuid })
export const PaymentReconciliation = relation("PaymentReconciliation", {
	id: uuid,
	payment: uuid,
	business: uuid,
	account: uuid,
	period: interval(i64),
	evidence: str,
	recordedAt: i64
})
export const PaymentAllocation = relation("PaymentAllocation", {
	revision: uuid,
	account: uuid,
	business: uuid,
	reconciliation: uuid,
	paidOn: interval(i64, 1n)
})
export const PaymentAdjustment = relation("PaymentAdjustment", {
	id: uuid,
	reconciliation: uuid,
	amount: i64,
	period: interval(i64),
	evidence: str
})

export const FinancialIssue = relation("FinancialIssue", {
	id: uuid,
	business: uuid,
	scope: closedId(FinancialScope),
	evidence: str,
	detail: str
})
export const PaymentIssue = relation("PaymentIssue", { issue: uuid, business: uuid, account: uuid })
export const FinancialResolution = relation("FinancialResolution", {
	issue: uuid,
	evidence: str,
	recordedAt: i64
})
export const SignedDisposition = relation("SignedDisposition", {
	revision: uuid,
	account: uuid,
	evidence: str,
	disposition: str
})

export const CalendarCoverage = relation("CalendarCoverage", {
	release: uuid,
	authority: closedId(Authority),
	kind: closedId(PeriodKind),
	span: interval(i64)
})
export const CalendarPeriod = relation("CalendarPeriod", {
	id: uuid,
	release: uuid,
	authority: closedId(Authority),
	kind: closedId(PeriodKind),
	span: interval(i64),
	year: i64,
	ordinal: u64
})
export const BusinessDayCoverage = relation("BusinessDayCoverage", {
	release: uuid,
	authority: closedId(Authority),
	span: interval(i64),
	evidence: str
})
export const BusinessDay = relation("BusinessDay", {
	release: uuid,
	authority: closedId(Authority),
	span: interval(i64, 1n),
	eligible: bool,
	evidence: str
})
export const DepositPolicy = relation("DepositPolicy", {
	id: uuid,
	release: uuid,
	business: uuid,
	account: uuid,
	family: closedId(AccountFamily),
	periodKind: closedId(PeriodKind),
	valid: interval(i64),
	authority: closedId(Authority),
	dueRule: closedId(DueRule),
	evidence: str
})
export const DepositTrigger = relation("DepositTrigger", {
	policy: uuid,
	kind: closedId(CheckpointKind),
	actionable: interval(u64)
})
export const DepositCheckpoint = relation("DepositCheckpoint", {
	id: uuid,
	policy: uuid,
	business: uuid,
	account: uuid,
	calendar: uuid,
	periodKind: closedId(PeriodKind),
	span: interval(i64),
	year: i64,
	kind: closedId(CheckpointKind),
	opensOn: i64,
	dueOn: i64,
	evidence: str
})
export const FilingRequirement = relation("FilingRequirement", {
	id: uuid,
	business: uuid,
	form: closedId(Form),
	subjectKind: closedId(SubjectKind),
	startsOn: i64,
	evidence: str
})
export const FilingRule = relation("FilingRule", {
	id: uuid,
	release: uuid,
	form: closedId(Form),
	periodKind: closedId(PeriodKind),
	authority: closedId(Authority),
	dueRule: closedId(DueRule),
	evidence: str
})
export const RequirementEnd = relation("RequirementEnd", {
	requirement: uuid,
	endsBefore: i64,
	evidence: str
})
export const FilingSubject = relation("FilingSubject", {
	id: uuid,
	business: uuid,
	kind: closedId(SubjectKind)
})
export const BusinessSubject = relation("BusinessSubject", { subject: uuid, business: uuid })
export const EmployeeSubject = relation("EmployeeSubject", { subject: uuid, employee: uuid, business: uuid })
export const FilingScope = relation("FilingScope", {
	id: uuid,
	requirement: uuid,
	subject: uuid,
	business: uuid,
	form: closedId(Form),
	kind: closedId(PeriodKind),
	span: interval(i64)
})
export const Filing = relation("Filing", {
	id: uuid,
	requirement: uuid,
	subject: uuid,
	business: uuid,
	form: closedId(Form),
	period: interval(i64),
	kind: closedId(FilingKind),
	opensOn: i64,
	dueOn: i64,
	evidence: str
})
export const OriginalFiling = relation("OriginalFiling", {
	filing: uuid,
	scope: uuid,
	requirement: uuid,
	subject: uuid,
	business: uuid,
	form: closedId(Form),
	canonical: uuid,
	kind: closedId(PeriodKind),
	period: interval(i64)
})
export const CorrectionFiling = relation("CorrectionFiling", {
	filing: uuid,
	parent: uuid,
	form: closedId(Form),
	parentForm: closedId(Form),
	business: uuid,
	subject: uuid,
	period: interval(i64),
	evidence: str
})
export const DeadlineRevision = relation("DeadlineRevision", {
	id: uuid,
	filing: uuid,
	sequence: u64,
	dueOn: i64,
	evidence: str,
	recordedAt: i64
})
export const FormMethodPolicy = relation("FormMethodPolicy", {
	id: uuid,
	release: uuid,
	form: closedId(Form),
	method: closedId(SubmissionMethod),
	requiredCount: u64
})
export const DocumentRequirement = relation("DocumentRequirement", {
	policy: uuid,
	slot: str,
	role: closedId(DocumentRole)
})
export const FilingVersion = relation("FilingVersion", {
	id: uuid,
	filing: uuid,
	business: uuid,
	form: closedId(Form),
	release: uuid,
	sequence: u64,
	origin: closedId(VersionOrigin),
	evidence: str,
	recordedAt: i64
})
export const PreparedVersion = relation("PreparedVersion", { version: uuid, snapshot: str })
export const AttestedVersion = relation("AttestedVersion", { version: uuid, attestation: str })
// One scoped association supplies both captured return bases and amendment
// liabilities. Its ownership/period proof is shared by those two uses.
export const FilingRevision = relation("FilingRevision", {
	filing: uuid,
	revision: uuid,
	business: uuid,
	subject: uuid,
	form: closedId(Form),
	family: closedId(AccountFamily),
	employee: uuid,
	paidOn: interval(i64, 1n)
})
export const FilingBasis = relation("FilingBasis", { version: uuid, filing: uuid, revision: uuid })
export const FilingDocument = relation("FilingDocument", {
	version: uuid,
	slot: str,
	role: closedId(DocumentRole),
	artifact: uuid,
	part: str
})
export const FormAdjustment = relation("FormAdjustment", {
	id: uuid,
	filing: uuid,
	amount: i64,
	evidence: str
})
export const FilingAdjustmentBasis = relation("FilingAdjustmentBasis", {
	version: uuid,
	filing: uuid,
	adjustment: uuid
})
export const AmendmentLiability = relation("AmendmentLiability", {
	filing: uuid,
	revision: uuid,
	account: uuid,
	business: uuid,
	family: closedId(AccountFamily),
	evidence: str
})
export const GrandfatheredEligibility = relation("GrandfatheredEligibility", {
	filing: uuid,
	attestation: str
})
export const CertifiedMailing = relation("CertifiedMailing", {
	id: uuid,
	business: uuid,
	carrier: str,
	number: str,
	mailedOn: i64,
	receipt: uuid,
	evidence: str
})
export const MailingEvidence = relation("MailingEvidence", { mailing: uuid, artifact: uuid })
export const Submission = relation("Submission", {
	id: uuid,
	version: uuid,
	business: uuid,
	form: closedId(Form),
	release: uuid,
	policy: uuid,
	method: closedId(SubmissionMethod),
	requiredCount: u64,
	recordedAt: i64
})
export const GrandfatheredSubmission = relation("GrandfatheredSubmission", {
	submission: uuid,
	version: uuid,
	filing: uuid,
	evidence: str
})
export const DigitalSubmission = relation("DigitalSubmission", {
	submission: uuid,
	submittedOn: i64,
	evidence: str
})
export const DigitalReference = relation("DigitalReference", {
	submission: uuid,
	version: uuid,
	filing: uuid,
	value: str,
	sourceText: str
})
export const CertifiedMailSubmission = relation("CertifiedMailSubmission", {
	submission: uuid,
	version: uuid,
	business: uuid,
	mailing: uuid
})
export const SubmissionDocument = relation("SubmissionDocument", {
	submission: uuid,
	version: uuid,
	policy: uuid,
	slot: str,
	role: closedId(DocumentRole),
	artifact: uuid,
	part: str
})
export const Rejection = relation("Rejection", { submission: uuid, evidence: str, recordedAt: i64 })
export const ImportProvenance = relation("ImportProvenance", {
	id: uuid,
	sourceHash: str,
	mapHash: str,
	auditHash: str,
	artifact: uuid,
	recordedAt: i64
})

export const relations = {
	ContributionCancellation,
	MercuryTransaction,
	PayrollTransaction,
	PlanReceiptDate,
	CashDirection,
	BankStatus,
	CashPurpose,
	ContributionSource,
	ContributionOrigin,
	PlanAccountKind,
	BankMovement,
	BankObservation,
	BankSource,
	BankRetry,
	CashAllocation,
	PayrollCashBinding,
	BankTaxPayment,
	Owner,
	OwnerDistribution,
	DistributionReturn,
	DistributionReview,
	RetirementPlan,
	PlanAccount,
	RetirementAnnual,
	RetirementContribution,
	ContributionElection,
	ContributionAuthorization,
	ContributionDeduction,
	ContributionFunding,
	ProviderOperation,
	PlanReceipt,
	ReceiptAllocation,
	RothConversion,
	ConversionReceipt,
	SuppliedConversionTax,
	RetirementReport,
	ReportedReceiptConversion,
	PlanBalance,
	RetirementSetup,
	RetirementSetupResolution,
	BookkeepingIssue,
	BookkeepingResolution,
	PlanSubject,
	RetirementFilingBasis,

	State,
	Payer,
	Program,
	AccountFamily,
	CalculationMethod,
	Component,
	Form,
	SubmissionMethod,
	DocumentRole,
	PeriodKind,
	Authority,
	AssessmentOrigin,
	RevisionKind,
	CalculationPurpose,
	CommitmentOrigin,
	DeductionKind,
	VersionOrigin,
	FilingKind,
	SubjectKind,
	BandRole,
	CheckpointKind,
	DueRule,
	Business,
	BusinessAddress,
	StateAccount,
	Employee,
	TaxAccount,
	AnnualBudget,
	BudgetCommitment,
	BudgetAssignment,
	BankReference,
	Wage,
	RegularWork,
	RegularCommitment,
	ObservedCompensation,
	Deduction,
	Election,
	ElectionSource,
	ElectionUse,
	DeferralPolicy,
	GrossSuggestionMethod,
	GrossSuggestionPolicy,
	EmployeeAllowance,
	Recovery,
	Review,
	Resolution,
	PolicyRelease,
	PolicyBinding,
	PublishedRateKind,
	PolicyLimitKind,
	PolicyEvidenceKind,
	AnnualPolicy,
	AnnualSource,
	PublishedRate,
	PolicyLimit,
	LookbackPeriod,
	AnnualEvidence,
	AnnualApproval,
	CalculationPolicy,
	ElectionContributionKind,
	ElectionDocument,
	ElectionDocumentAmount,
	ElectionDocumentRevision,
	EmployerRateNotice,
	EmployerSchedule,
	FutaBasis,
	SupportedPayrollDomain,
	MonthlyDepositor,
	SupportedProgram,
	PolicyCoverage,
	RateVersion,
	RateSchedule,
	TaxBand,
	TaxBaseScope,
	StateBaseScope,
	AssessmentSet,
	ObservedSet,
	PayrollCalculation,
	ProposedWage,
	ProposedRevision,
	CalculationRecoveryClaim,
	Assessment,
	ObservedAssessment,
	TaxableWages,
	CalculatedAssessment,
	AppliedRule,
	CalculationBasis,
	CalculationWageBase,
	AssessmentRevision,
	CorrectionAssessment,
	RevisionAccount,
	Artifact,
	VerifiedArtifact,
	ArtifactLocation,
	TaxPayment,
	PaymentSettlement,
	PaymentReference,
	PaymentEvidence,
	PaymentReconciliation,
	PaymentAllocation,
	PaymentAdjustment,
	FinancialIssue,
	FinancialScope,
	PaymentIssue,
	FinancialResolution,
	SignedDisposition,
	CalendarCoverage,
	CalendarPeriod,
	BusinessDay,
	BusinessDayCoverage,
	DepositPolicy,
	DepositTrigger,
	DepositCheckpoint,
	FilingRequirement,
	FilingRule,
	RequirementEnd,
	FilingSubject,
	BusinessSubject,
	EmployeeSubject,
	FilingScope,
	Filing,
	OriginalFiling,
	CorrectionFiling,
	DeadlineRevision,
	FormMethodPolicy,
	DocumentRequirement,
	FilingVersion,
	PreparedVersion,
	AttestedVersion,
	FilingBasis,
	FilingRevision,
	FilingDocument,
	FormAdjustment,
	FilingAdjustmentBasis,
	AmendmentLiability,
	GrandfatheredEligibility,
	CertifiedMailing,
	MailingEvidence,
	Submission,
	GrandfatheredSubmission,
	DigitalSubmission,
	DigitalReference,
	CertifiedMailSubmission,
	SubmissionDocument,
	Rejection,
	ImportProvenance
}

const submissionIdKey = key(Submission, ["id"])
const grandfatheredSubmissionSubmissionKey = key(GrandfatheredSubmission, ["submission"])
const digitalSubmissionSubmissionKey = key(DigitalSubmission, ["submission"])
const certifiedMailSubmissionSubmissionKey = key(CertifiedMailSubmission, ["submission"])
const assessmentSetIdKey = key(AssessmentSet, ["id"])
const observedSetSetKey = key(ObservedSet, ["set"])
const payrollCalculationSetKey = key(PayrollCalculation, ["set"])
const payrollCalculationIdKey = key(PayrollCalculation, ["id"])
const proposedWageCalculationKey = key(ProposedWage, ["calculation"])
const proposedRevisionCalculationKey = key(ProposedRevision, ["calculation"])
const filingVersionIdKey = key(FilingVersion, ["id"])
const preparedVersionVersionKey = key(PreparedVersion, ["version"])
const attestedVersionVersionKey = key(AttestedVersion, ["version"])
const filingIdKey = key(Filing, ["id"])
const originalFilingFilingKey = key(OriginalFiling, ["filing"])
const correctionFilingFilingKey = key(CorrectionFiling, ["filing"])
const filingSubjectIdKey = key(FilingSubject, ["id"])
const businessSubjectSubjectKey = key(BusinessSubject, ["subject"])
const employeeSubjectSubjectKey = key(EmployeeSubject, ["subject"])
const planSubjectSubjectKey = key(PlanSubject, ["subject"])
const budgetCommitmentIdKey = key(BudgetCommitment, ["id"])
const regularCommitmentCommitmentKey = key(RegularCommitment, ["commitment"])
const observedCompensationCommitmentKey = key(ObservedCompensation, ["commitment"])

export const identityLaws = [
	key(Business, ["id"]),
	key(Business, ["ein"]),
	key(BusinessAddress, ["business", "kind"]),
	key(StateAccount, ["business", "state"]),
	key(Employee, ["id"]),
	key(Employee, ["id", "business"]),
	key(TaxAccount, ["id"]),
	key(TaxAccount, ["business", "family"]),
	key(TaxAccount, ["id", "business", "family"]),
	key(TaxAccount, ["id", "business"]),
	key(AnnualBudget, ["id"]),
	key(AnnualBudget, ["employee", "year"]),
	key(AnnualBudget, ["id", "employee", "year"]),
	budgetCommitmentIdKey,
	key(BudgetCommitment, ["id", "employee", "year", "amount"]),
	key(BudgetCommitment, ["id", "employee", "amount"]),
	key(BudgetAssignment, ["commitment"]),
	key(BankReference, ["issuer", "scope", "value"]),
	key(Wage, ["id"]),
	key(Wage, ["id", "business"]),
	key(Wage, ["initialRevision", "id"]),
	key(Wage, ["commitment"]),
	key(Wage, ["id", "commitment"]),
	key(Wage, ["id", "employee"]),
	key(Wage, ["id", "employee", "year"]),
	key(Wage, ["id", "employee", "paidOn"]),
	key(Wage, ["id", "business", "employee", "gross", "paidOn"]),
	key(RegularWork, ["wage"]),
	key(RegularWork, ["employee", "span"]),
	regularCommitmentCommitmentKey,
	key(RegularCommitment, ["wage"]),
	observedCompensationCommitmentKey,
	key(ObservedCompensation, ["wage"]),
	key(Deduction, ["wage", "kind"]),
	key(Deduction, ["wage", "kind", "amount"]),
	key(Election, ["id"]),
	key(Election, ["id", "employee", "year", "signedOn", "limit"]),
	key(ElectionSource, ["election"]),
	key(ElectionSource, ["document"]),
	key(ElectionDocument, ["id", "employee", "year", "signedOn"]),
	key(RetirementAnnual, ["id", "employee", "year"]),
	key(Election, ["employee", "effective"]),
	key(Election, ["id", "employee", "effective"]),
	key(DeferralPolicy, ["id"]),
	key(GrossSuggestionPolicy, ["id"]),
	key(GrossSuggestionPolicy, ["release"]),
	key(DeferralPolicy, ["release", "year"]),
	key(DeferralPolicy, ["id", "year", "limit"]),
	key(EmployeeAllowance, ["id"]),
	key(EmployeeAllowance, ["employee", "year"]),
	key(EmployeeAllowance, ["id", "employee", "year", "limit"]),
	key(ElectionUse, ["wage"]),
	key(Recovery, ["id"]),
	key(Recovery, ["fromWage", "owedOnWage", "component"]),
	key(Review, ["id"]),
	key(Resolution, ["review"]),
	key(PolicyRelease, ["id"]),
	key(PolicyRelease, ["sha256"]),
	key(PolicyBinding, ["business"]),
	key(AnnualPolicy, ["id"]),
	key(AnnualPolicy, ["id", "business", "authority", "year", "valid"]),
	key(AnnualSource, ["annual", "artifact"]),
	key(PublishedRate, ["annual", "kind"]),
	key(PolicyLimit, ["annual", "kind"]),
	key(LookbackPeriod, ["annual"]),
	key(AnnualEvidence, ["annual", "kind"]),
	key(AnnualApproval, ["annual"]),
	key(AnnualApproval, ["release", "business", "authority", "year"]),
	key(AnnualApproval, ["annual", "release", "business", "authority", "valid"]),
	key(CalculationPolicy, ["calculation", "authority"]),
	key(ElectionDocument, ["id"]),
	key(ElectionDocument, ["id", "employee", "year"]),
	key(ElectionDocumentRevision, ["document"]),
	key(ElectionDocumentRevision, ["predecessor"]),
	key(ElectionDocument, ["employee", "artifact"]),
	key(ElectionDocumentAmount, ["document", "kind"]),
	key(ElectionDocumentAmount, ["document", "kind", "cents"]),
	key(CalendarPeriod, ["id", "authority", "year", "span"]),
	key(PayrollCalculation, ["id", "release", "business", "paidOn"]),

	key(EmployerRateNotice, ["id"]),
	key(EmployerRateNotice, ["id", "business", "schedule", "valid"]),
	key(EmployerSchedule, ["version"]),
	key(FutaBasis, ["version"]),
	key(EmployerSchedule, ["version", "business", "schedule", "valid"]),
	key(SupportedPayrollDomain, ["release", "state", "valid"]),
	key(SupportedPayrollDomain, ["id"]),
	key(SupportedPayrollDomain, ["id", "release", "valid"]),
	key(MonthlyDepositor, ["id"]),
	key(MonthlyDepositor, ["business", "valid"]),
	key(MonthlyDepositor, ["id", "business", "valid"]),
	key(SupportedProgram, ["id"]),
	key(SupportedProgram, ["domain", "program"]),
	key(SupportedProgram, ["id", "domain"]),
	key(SupportedProgram, ["id", "eligible"]),
	key(PolicyCoverage, ["release", "business", "component", "span"]),
	key(RateVersion, ["id"]),
	key(RateVersion, ["id", "business", "schedule", "valid"]),
	key(RateVersion, ["release", "business", "component", "valid"]),
	key(RateVersion, ["id", "release", "business", "component", "schedule", "valid"]),
	key(RateSchedule, ["id"]),
	key(RateSchedule, ["id", "domain"]),
	key(TaxBand, ["id"]),
	key(TaxBand, ["schedule", "span"]),
	key(TaxBand, ["id", "schedule", "span"]),
	key(TaxBaseScope, ["id"]),
	key(TaxBaseScope, ["id", "business", "employee", "year", "span"]),
	key(TaxBaseScope, ["business", "employee", "program", "year"]),
	key(StateBaseScope, ["scope"]),
	assessmentSetIdKey,
	key(AssessmentSet, ["id", "origin"]),
	key(AssessmentSet, ["id", "employee"]),
	key(AssessmentSet, ["id", "business", "employee", "gross", "paidOn"]),
	key(AssessmentSet, ["id", "gross"]),
	key(AssessmentSet, ["id", "business", "paidOn"]),
	observedSetSetKey,
	payrollCalculationIdKey,
	payrollCalculationSetKey,
	key(PayrollCalculation, ["request"]),
	key(PayrollCalculation, ["set", "domain"]),
	key(PayrollCalculation, ["id", "set"]),
	key(PayrollCalculation, ["id", "business", "paidOn"]),
	key(PayrollCalculation, ["set", "release"]),
	proposedWageCalculationKey,
	proposedRevisionCalculationKey,
	key(CalculationRecoveryClaim, ["calculation", "owedOnWage", "component"]),
	key(Assessment, ["set", "component"]),
	key(Assessment, ["set", "component", "method"]),
	key(ObservedAssessment, ["set", "component"]),
	key(TaxableWages, ["set", "program"]),
	key(CalculatedAssessment, ["set", "component"]),
	key(CalculatedAssessment, ["basis"]),
	key(AppliedRule, ["set", "component"]),
	key(AppliedRule, ["set", "component", "schedule"]),
	key(CalculationBasis, ["id"]),
	key(CalculationBasis, ["id", "cents", "earning"]),
	key(CalculationBasis, ["set", "component"]),
	key(CalculationBasis, ["id", "schedule", "earning"]),
	key(CalculationBasis, ["id", "set", "component"]),
	key(CalculationWageBase, ["set", "scope"]),
	key(CalculationWageBase, ["set", "scope", "cents", "earning"]),
	key(AssessmentRevision, ["id"]),
	key(AssessmentRevision, ["set"]),
	key(AssessmentRevision, ["id", "wage"]),
	key(AssessmentRevision, ["id", "business"]),
	key(AssessmentRevision, ["id", "business", "paidOn"]),
	key(AssessmentRevision, ["id", "business", "employee", "paidOn"]),
	key(CorrectionAssessment, ["revision"]),
	key(CorrectionAssessment, ["revision", "wage"]),
	key(CorrectionAssessment, ["predecessor"]),
	key(RevisionAccount, ["revision", "account"]),
	key(RevisionAccount, ["revision", "family"]),
	key(RevisionAccount, ["revision", "account", "business"]),
	key(RevisionAccount, ["revision", "account", "business", "family"]),
	key(Artifact, ["id"]),
	key(Artifact, ["sha256"]),
	key(VerifiedArtifact, ["artifact"]),
	key(ArtifactLocation, ["artifact", "locator"]),
	key(TaxPayment, ["id"]),
	key(TaxPayment, ["id", "business"]),
	key(TaxPayment, ["id", "business", "account"]),
	key(PaymentSettlement, ["payment"]),
	key(PaymentReference, ["issuer", "scope", "value"]),
	key(PaymentEvidence, ["payment", "artifact"]),
	key(PaymentReconciliation, ["id"]),
	key(PaymentReconciliation, ["payment"]),
	key(PaymentReconciliation, ["id", "business", "account"]),
	key(PaymentReconciliation, ["id", "business", "account", "period"]),
	key(PaymentAllocation, ["revision", "account"]),
	key(PaymentAdjustment, ["id"]),
	key(FinancialIssue, ["id"]),
	key(FinancialIssue, ["id", "business"]),
	key(PaymentIssue, ["issue"]),
	key(FinancialResolution, ["issue"]),
	key(SignedDisposition, ["revision", "account"]),
	key(CalendarCoverage, ["release", "authority", "kind", "span"]),
	key(CalendarPeriod, ["id"]),
	key(CalendarPeriod, ["release", "authority", "kind", "span"]),
	key(CalendarPeriod, ["id", "kind", "span"]),
	key(CalendarPeriod, ["id", "year", "span"]),
	key(CalendarPeriod, ["id", "kind", "year", "span"]),
	key(BusinessDayCoverage, ["release", "authority", "span"]),
	key(BusinessDay, ["release", "authority", "span"]),
	key(DepositPolicy, ["id"]),
	key(DepositPolicy, ["release", "account", "valid"]),
	key(DepositPolicy, ["id", "business", "account", "periodKind", "valid"]),
	key(DepositTrigger, ["policy", "kind"]),
	key(DepositCheckpoint, ["id"]),
	key(DepositCheckpoint, ["account", "calendar"]),
	key(DepositCheckpoint, ["policy", "business", "account", "periodKind", "span"]),
	key(FilingRequirement, ["id"]),
	key(FilingRequirement, ["business", "form"]),
	key(FilingRequirement, ["id", "business", "form"]),
	key(FilingRule, ["release", "form"]),
	key(FilingRule, ["id"]),
	key(RequirementEnd, ["requirement"]),
	filingSubjectIdKey,
	key(FilingSubject, ["id", "business"]),
	businessSubjectSubjectKey,
	key(BusinessSubject, ["business"]),
	employeeSubjectSubjectKey,
	key(EmployeeSubject, ["employee"]),
	key(EmployeeSubject, ["subject", "employee", "business"]),
	key(FilingScope, ["id"]),
	key(FilingScope, ["requirement", "subject"]),
	key(FilingScope, ["id", "kind", "span"]),
	key(FilingScope, ["id", "requirement", "subject", "business", "form"]),
	filingIdKey,
	key(Filing, ["id", "business", "form"]),
	key(Filing, ["id", "form"]),
	key(Filing, ["id", "business", "subject", "period"]),
	key(Filing, ["id", "business", "subject", "form", "period"]),
	key(Filing, ["id", "period"]),
	key(Filing, ["id", "requirement", "subject", "business", "form"]),
	originalFilingFilingKey,
	key(OriginalFiling, ["scope", "kind", "period"]),
	key(OriginalFiling, ["scope", "canonical"]),
	key(OriginalFiling, ["scope", "period"]),
	correctionFilingFilingKey,
	key(CorrectionFiling, ["parent"]),
	key(DeadlineRevision, ["id"]),
	key(DeadlineRevision, ["filing", "sequence"]),
	key(FormMethodPolicy, ["id"]),
	key(FormMethodPolicy, ["release", "form", "method"]),
	key(FormMethodPolicy, ["id", "release", "form", "method", "requiredCount"]),
	key(DocumentRequirement, ["policy", "slot"]),
	key(DocumentRequirement, ["policy", "slot", "role"]),
	filingVersionIdKey,
	key(FilingVersion, ["filing", "sequence"]),
	key(FilingVersion, ["id", "filing"]),
	key(FilingVersion, ["id", "business"]),
	key(FilingVersion, ["id", "business", "form", "release"]),
	preparedVersionVersionKey,
	attestedVersionVersionKey,
	key(FilingBasis, ["version", "revision"]),
	key(FilingRevision, ["filing", "revision"]),
	key(FilingRevision, ["filing", "revision", "business", "family"]),
	key(FilingDocument, ["version", "slot"]),
	key(FilingDocument, ["version", "slot", "role", "artifact", "part"]),
	key(FormAdjustment, ["id"]),
	key(FormAdjustment, ["id", "filing"]),
	key(FilingAdjustmentBasis, ["version", "adjustment"]),
	key(AmendmentLiability, ["filing", "revision", "account"]),
	key(GrandfatheredEligibility, ["filing"]),
	key(CertifiedMailing, ["id"]),
	key(CertifiedMailing, ["carrier", "number"]),
	key(CertifiedMailing, ["id", "business"]),
	key(MailingEvidence, ["mailing", "artifact"]),
	submissionIdKey,
	key(Submission, ["id", "version", "business"]),
	key(Submission, ["id", "version"]),
	key(Submission, ["id", "version", "policy"]),
	grandfatheredSubmissionSubmissionKey,
	digitalSubmissionSubmissionKey,
	key(DigitalReference, ["filing", "value"]),
	certifiedMailSubmissionSubmissionKey,
	key(CertifiedMailSubmission, ["mailing", "version"]),
	key(SubmissionDocument, ["submission", "slot"]),
	key(Rejection, ["submission"]),
	key(ImportProvenance, ["id"]),
	key(ImportProvenance, ["sourceHash"])
]

export const laws = [
	...alternatives(submissionIdKey, "method", SubmissionMethod, {
		Grandfathered: grandfatheredSubmissionSubmissionKey,
		Digital: digitalSubmissionSubmissionKey,
		CertifiedMail: certifiedMailSubmissionSubmissionKey
	}),
	...alternatives(assessmentSetIdKey, "origin", AssessmentOrigin, {
		Observed: observedSetSetKey,
		Calculated: payrollCalculationSetKey
	}),
	...alternatives(payrollCalculationIdKey, "purpose", CalculationPurpose, {
		NewWage: proposedWageCalculationKey,
		TaxRevision: proposedRevisionCalculationKey
	}),
	...alternatives(filingVersionIdKey, "origin", VersionOrigin, {
		Prepared: preparedVersionVersionKey,
		Attested: attestedVersionVersionKey
	}),
	...alternatives(filingIdKey, "kind", FilingKind, {
		Original: originalFilingFilingKey,
		Correction: correctionFilingFilingKey
	}),
	...alternatives(filingSubjectIdKey, "kind", SubjectKind, {
		Business: businessSubjectSubjectKey,
		Employee: employeeSubjectSubjectKey,
		Plan: planSubjectSubjectKey
	}),
	...alternatives(budgetCommitmentIdKey, "origin", CommitmentOrigin, {
		Regular: regularCommitmentCommitmentKey,
		Observed: observedCompensationCommitmentKey
	}),
	key(ReportedReceiptConversion, ["receipt"]),
	key(RetirementReport, ["id", "plan"]),
	contained(on(ReportedReceiptConversion, ["report", "plan"]), on(RetirementReport, ["id", "plan"])),
	contained(on(ReportedReceiptConversion, ["receipt", "plan"]), on(PlanReceipt, ["id", "plan"])),
	contained(
		on(ReportedReceiptConversion, "receipt"),
		on(select(PlanReceipt, { source: "EmployeeAfterTax" }), "id")
	),
	capacity(on(ReportedReceiptConversion, "receipt"), {
		from: on(ConversionReceipt, "receipt"),
		within: within(0n)
	}),
	key(DistributionReturn, ["allocation"]),
	key(ContributionCancellation, ["contribution"]),
	contained(
		on(ContributionCancellation, "contribution"),
		on(select(RetirementContribution, { origin: "Authorized" }), "id")
	),
	capacity(on(ContributionCancellation, "contribution"), {
		from: on(ContributionFunding, "contribution"),
		within: within(0n)
	}),
	capacity(on(ContributionCancellation, "contribution"), {
		from: on(ReceiptAllocation, "contribution"),
		within: within(0n)
	}),
	key(RetirementPlan, ["id", "business", "employee"]),
	key(RetirementContribution, ["id", "business"]),
	contained(
		on(RetirementContribution, ["plan", "business", "employee"]),
		on(RetirementPlan, ["id", "business", "employee"])
	),
	contained(
		on(ContributionFunding, ["contribution", "business"]),
		on(RetirementContribution, ["id", "business"])
	),
	mirrors(
		on(select(RetirementContribution, { source: "EmployeeRothDeferral" }), "id"),
		on(ContributionDeduction, "contribution")
	),
	mirrors(on(select(CashAllocation, { purpose: "PayrollCash" }), "id"), on(PayrollCashBinding, "allocation")),
	mirrors(
		on(select(CashAllocation, { purpose: "OwnerDistribution" }), "id"),
		on(OwnerDistribution, "allocation")
	),
	mirrors(
		on(select(CashAllocation, { purpose: "DistributionReturn" }), "id"),
		on(DistributionReturn, "allocation")
	),
	mirrors(on(select(CashAllocation, { purpose: "TaxPayment" }), "id"), on(BankTaxPayment, "allocation")),
	key(CashAllocation, ["id", "amount"]),
	capacity(on(select(CashAllocation, { purpose: "RothRemittance" }), "id"), {
		from: on(select(ContributionFunding, { source: "EmployeeRothDeferral" }), "allocation"),
		within: within(1n)
	}),
	contained(
		on(select(ContributionFunding, { source: "EmployeeRothDeferral" }), ["allocation", "amount"]),
		on(CashAllocation, ["id", "amount"])
	),
	...[
		BankMovement,
		CashAllocation,
		OwnerDistribution,
		DistributionReturn,
		RetirementContribution,
		PlanReceipt,
		RothConversion
	].map((r) =>
		capacity(on(r, "id"), { from: on(r, "id"), weight: weigh("amount"), within: within(1n, "*") })
	),
	key(Deduction, ["wage", "kind", "employee", "year", "amount"]),
	contained(on(ContributionDeduction, "kind"), on(DeductionKind, "id")),
	contained(
		on(ContributionDeduction, "contribution"),
		on(select(ContributionDeduction, { kind: "Roth" }), "contribution")
	),

	key(MercuryTransaction, ["movement"]),
	key(MercuryTransaction, ["reference"]),
	key(PayrollTransaction, ["wage", "movement"]),
	key(PlanReceiptDate, ["receipt"]),
	mirrors(on(BankMovement, "id"), on(MercuryTransaction, "movement")),
	capacity(on(select(MercuryTransaction, { reference: "" }), "movement"), {
		from: on(MercuryTransaction, "movement"),
		within: within(0n)
	}),
	contained(on(PayrollTransaction, ["wage", "business"]), on(Wage, ["id", "business"])),
	contained(on(PayrollTransaction, ["movement", "business"]), on(BankMovement, ["id", "business"])),
	// Every banked wage retains its actual Mercury movement(s). No-transfer wages
	// cannot have any bank movement. Arithmetic is proved at the posting boundary.
	contained(on(PayrollTransaction, "wage"), on(select(Wage, { requiresTransfer: true }), "id")),
	capacity(on(select(Wage, { requiresTransfer: true }), "id"), {
		from: on(PayrollTransaction, "wage"),
		within: within(1n, "*")
	}),
	contained(on(PlanReceiptDate, "receipt"), on(PlanReceipt, "id")),

	contained(on(ContributionFunding, "source"), on(ContributionSource, "id")),
	key(BankMovement, ["id"]),
	key(BankObservation, ["id"]),
	key(CashAllocation, ["id"]),
	key(OwnerDistribution, ["id"]),
	key(DistributionReturn, ["id"]),
	key(DistributionReview, ["id"]),
	key(RetirementPlan, ["id"]),
	key(PlanAccount, ["id"]),
	key(RetirementAnnual, ["id"]),
	key(RetirementContribution, ["id"]),
	key(ProviderOperation, ["id"]),
	key(PlanReceipt, ["id"]),
	key(RothConversion, ["id"]),
	key(RetirementReport, ["id"]),
	key(PlanBalance, ["id"]),
	key(RetirementSetup, ["id"]),
	key(BookkeepingIssue, ["id"]),
	key(BankMovement, ["id", "business"]),
	key(BankMovement, ["id", "amount"]),
	key(BankObservation, ["artifact", "row"]),
	key(BankObservation, ["id", "business"]),
	key(BankSource, ["observation"]),
	key(BankRetry, ["failed"]),
	key(CashAllocation, ["id", "business", "amount"]),
	key(CashAllocation, ["id", "business"]),
	key(Owner, ["business"]),
	key(Owner, ["business", "employee"]),
	key(OwnerDistribution, ["allocation"]),
	key(OwnerDistribution, ["id", "business"]),
	key(RetirementPlan, ["business"]),
	key(RetirementPlan, ["id", "business"]),
	key(RetirementPlan, ["id", "employee"]),
	key(PlanAccount, ["provider", "reference"]),
	key(PlanAccount, ["id", "plan"]),
	key(RetirementAnnual, ["plan", "year"]),
	key(RetirementAnnual, ["id", "employee", "year", "valid"]),
	key(RetirementContribution, ["id", "employee", "year", "amount"]),
	key(RetirementContribution, ["id", "employee", "year"]),
	key(RetirementContribution, ["id", "source"]),
	key(RetirementContribution, ["id", "plan"]),
	key(ContributionElection, ["contribution"]),
	key(ContributionAuthorization, ["contribution"]),
	key(ContributionDeduction, ["contribution"]),
	key(ContributionDeduction, ["wage"]),
	key(ContributionFunding, ["contribution", "allocation"]),
	key(ProviderOperation, ["plan", "provider", "reference"]),
	key(ProviderOperation, ["id", "plan"]),
	key(PlanReceipt, ["id", "plan"]),
	key(ReceiptAllocation, ["receipt", "contribution"]),
	key(RothConversion, ["id", "plan"]),
	key(ConversionReceipt, ["conversion", "receipt"]),
	key(SuppliedConversionTax, ["conversion", "field"]),
	key(RetirementSetupResolution, ["setup"]),
	key(BookkeepingResolution, ["issue"]),
	planSubjectSubjectKey,
	key(PlanSubject, ["plan"]),
	key(RetirementFilingBasis, ["version"]),
	key(PayrollCashBinding, ["allocation"]),
	key(BankTaxPayment, ["allocation"]),
	contained(on(BankMovement, "business"), on(Business, "id")),
	contained(on(BankMovement, "direction"), on(CashDirection, "id")),
	contained(on(BankObservation, "business"), on(Business, "id")),
	contained(on(BankObservation, "artifact"), on(Artifact, "id")),
	contained(on(BankObservation, "status"), on(BankStatus, "id")),
	contained(on(BankSource, ["movement", "business"]), on(BankMovement, ["id", "business"])),
	contained(on(BankSource, ["observation", "business"]), on(BankObservation, ["id", "business"])),
	contained(on(BankSource, "observation"), on(select(BankObservation, { status: "Sent" }), "id")),
	contained(on(BankRetry, "failed"), on(select(BankObservation, { status: "Failed" }), "id")),
	contained(on(BankRetry, "succeeded"), on(select(BankObservation, { status: "Sent" }), "id")),
	contained(on(CashAllocation, ["movement", "business"]), on(BankMovement, ["id", "business"])),
	contained(on(CashAllocation, "purpose"), on(CashPurpose, "id")),
	contained(on(Owner, ["employee", "business"]), on(Employee, ["id", "business"])),
	contained(on(OwnerDistribution, ["business", "owner"]), on(Owner, ["business", "employee"])),
	contained(
		on(OwnerDistribution, ["allocation", "business", "amount"]),
		on(CashAllocation, ["id", "business", "amount"])
	),
	contained(
		on(DistributionReturn, ["allocation", "business", "amount"]),
		on(CashAllocation, ["id", "business", "amount"])
	),
	contained(on(DistributionReturn, ["distribution", "business"]), on(OwnerDistribution, ["id", "business"])),
	contained(on(DistributionReview, "business"), on(Business, "id")),
	contained(on(PayrollCashBinding, ["allocation", "business"]), on(CashAllocation, ["id", "business"])),
	contained(on(PayrollCashBinding, ["wage", "business"]), on(Wage, ["id", "business"])),
	contained(on(BankTaxPayment, ["allocation", "business"]), on(CashAllocation, ["id", "business"])),
	contained(on(BankTaxPayment, ["payment", "business"]), on(TaxPayment, ["id", "business"])),
	contained(on(RetirementPlan, ["employee", "business"]), on(Owner, ["employee", "business"])),
	contained(on(PlanAccount, "plan"), on(RetirementPlan, "id")),
	contained(on(PlanAccount, "kind"), on(PlanAccountKind, "id")),
	contained(on(RetirementAnnual, ["plan", "employee"]), on(RetirementPlan, ["id", "employee"])),
	contained(on(RetirementContribution, ["plan", "employee"]), on(RetirementPlan, ["id", "employee"])),
	contained(on(RetirementContribution, "source"), on(ContributionSource, "id")),
	contained(on(RetirementContribution, "origin"), on(ContributionOrigin, "id")),
	contained(
		on(ContributionElection, ["contribution", "employee", "year"]),
		on(RetirementContribution, ["id", "employee", "year"])
	),
	contained(
		on(ContributionElection, ["document", "employee", "year"]),
		on(ElectionDocument, ["id", "employee", "year"])
	),
	contained(
		on(ContributionAuthorization, ["contribution", "employee", "year"]),
		on(RetirementContribution, ["id", "employee", "year"])
	),
	contained(
		on(ContributionAuthorization, ["annual", "employee", "year", "authorizedOn"]),
		on(RetirementAnnual, ["id", "employee", "year", "valid"])
	),
	contained(
		on(ContributionDeduction, ["contribution", "employee", "year", "amount"]),
		on(RetirementContribution, ["id", "employee", "year", "amount"])
	),
	contained(
		on(ContributionDeduction, ["wage", "kind", "employee", "year", "amount"]),
		on(Deduction, ["wage", "kind", "employee", "year", "amount"])
	),
	contained(
		on(ContributionFunding, ["contribution", "source"]),
		on(RetirementContribution, ["id", "source"])
	),
	contained(on(ContributionFunding, ["allocation", "business"]), on(CashAllocation, ["id", "business"])),
	contained(on(ProviderOperation, "plan"), on(RetirementPlan, "id")),
	contained(on(PlanReceipt, ["operation", "plan"]), on(ProviderOperation, ["id", "plan"])),
	contained(on(PlanReceipt, ["account", "plan"]), on(PlanAccount, ["id", "plan"])),
	contained(on(PlanReceipt, "source"), on(ContributionSource, "id")),
	contained(on(ReceiptAllocation, ["receipt", "plan"]), on(PlanReceipt, ["id", "plan"])),
	contained(on(ReceiptAllocation, ["contribution", "plan"]), on(RetirementContribution, ["id", "plan"])),
	contained(on(RothConversion, ["operation", "plan"]), on(ProviderOperation, ["id", "plan"])),
	contained(on(RothConversion, ["fromAccount", "plan"]), on(PlanAccount, ["id", "plan"])),
	contained(on(RothConversion, ["toAccount", "plan"]), on(PlanAccount, ["id", "plan"])),
	contained(on(ConversionReceipt, ["conversion", "plan"]), on(RothConversion, ["id", "plan"])),
	contained(on(ConversionReceipt, ["receipt", "plan"]), on(PlanReceipt, ["id", "plan"])),
	contained(on(SuppliedConversionTax, "conversion"), on(RothConversion, "id")),
	contained(on(RetirementReport, "plan"), on(RetirementPlan, "id")),
	contained(on(RetirementReport, "artifact"), on(Artifact, "id")),
	contained(on(PlanBalance, "account"), on(PlanAccount, "id")),
	contained(on(RetirementSetup, "plan"), on(RetirementPlan, "id")),
	contained(on(RetirementSetupResolution, "setup"), on(RetirementSetup, "id")),
	contained(on(BookkeepingIssue, "business"), on(Business, "id")),
	contained(on(BookkeepingResolution, "issue"), on(BookkeepingIssue, "id")),
	contained(on(PlanSubject, ["plan", "business"]), on(RetirementPlan, ["id", "business"])),
	contained(on(PlanSubject, ["subject", "business"]), on(FilingSubject, ["id", "business"])),
	contained(on(RetirementFilingBasis, ["version", "filing"]), on(FilingVersion, ["id", "filing"])),
	contained(
		on(select(CashAllocation, { purpose: "PayrollCash" }), "movement"),
		on(select(BankMovement, { direction: "Outflow" }), "id")
	),
	contained(
		on(select(CashAllocation, { purpose: "RothRemittance" }), "movement"),
		on(select(BankMovement, { direction: "Outflow" }), "id")
	),
	contained(
		on(select(CashAllocation, { purpose: "OwnerDistribution" }), "movement"),
		on(select(BankMovement, { direction: "Outflow" }), "id")
	),
	contained(
		on(select(CashAllocation, { purpose: "TaxPayment" }), "movement"),
		on(select(BankMovement, { direction: "Outflow" }), "id")
	),
	contained(
		on(select(CashAllocation, { purpose: "DistributionReturn" }), "movement"),
		on(select(BankMovement, { direction: "Inflow" }), "id")
	),
	contained(
		on(select(ContributionFunding, { source: "EmployeeRothDeferral" }), "allocation"),
		on(select(CashAllocation, { purpose: "RothRemittance" }), "id")
	),
	contained(
		on(select(ContributionFunding, { source: "EmployeeAfterTax" }), "allocation"),
		on(select(CashAllocation, { purpose: "OwnerDistribution" }), "id")
	),
	capacity(on(BankMovement, "id"), {
		from: on(CashAllocation, "movement"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(CashAllocation, "id"), {
		from: on(ContributionFunding, "allocation"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(RetirementContribution, "id"), {
		from: on(ContributionFunding, "contribution"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(PlanReceipt, "id"), {
		from: on(ReceiptAllocation, "receipt"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(RetirementContribution, "id"), {
		from: on(ReceiptAllocation, "contribution"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(PlanReceipt, "id"), {
		from: on(ConversionReceipt, "receipt"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(RothConversion, "id"), {
		from: on(ConversionReceipt, "conversion"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	capacity(on(OwnerDistribution, "id"), {
		from: on(DistributionReturn, "distribution"),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	mirrors(
		on(select(RetirementContribution, { origin: "Authorized" }), "id"),
		on(ContributionAuthorization, "contribution")
	),

	...identityLaws,
	contained(on(AnnualPolicy, "business"), on(Business, "id")),
	contained(on(AnnualPolicy, "authority"), on(Authority, "id")),
	contained(
		on(AnnualPolicy, ["calendar", "authority", "year", "valid"]),
		on(select(CalendarPeriod, { kind: "Year" }), ["id", "authority", "year", "span"])
	),
	contained(on(AnnualSource, "annual"), on(AnnualPolicy, "id")),
	contained(on(AnnualSource, "artifact"), on(VerifiedArtifact, "artifact")),
	capacity(on(AnnualPolicy, "id"), { from: on(AnnualSource, "annual"), within: within(1n, 1000n) }),
	contained(on(PublishedRate, "kind"), on(PublishedRateKind, "id")),
	contained(on(PublishedRate, ["annual", "artifact"]), on(AnnualSource, ["annual", "artifact"])),
	contained(on(PublishedRate, "schedule"), on(RateSchedule, "id")),
	contained(on(PolicyLimit, "kind"), on(PolicyLimitKind, "id")),
	contained(on(PolicyLimit, ["annual", "artifact"]), on(AnnualSource, ["annual", "artifact"])),
	contained(on(LookbackPeriod, ["annual", "artifact"]), on(AnnualSource, ["annual", "artifact"])),
	contained(on(AnnualEvidence, "kind"), on(PolicyEvidenceKind, "id")),
	contained(on(AnnualEvidence, "annual"), on(AnnualPolicy, "id")),
	contained(on(AnnualEvidence, "artifact"), on(VerifiedArtifact, "artifact")),
	contained(on(AnnualApproval, "authority"), on(Authority, "id")),
	...Authority.handles.flatMap((authority) => [
		...annualRequirements[authority].rates.map((kind) =>
			capacity(on(select(AnnualApproval, { authority }), "annual"), {
				from: on(select(PublishedRate, { kind }), "annual"),
				within: within(1n, 1n)
			})
		),
		...annualRequirements[authority].limits.map((kind) =>
			capacity(on(select(AnnualApproval, { authority }), "annual"), {
				from: on(select(PolicyLimit, { kind }), "annual"),
				within: within(1n, 1n)
			})
		),
		...annualRequirements[authority].evidence.map((kind) =>
			capacity(on(select(AnnualApproval, { authority }), "annual"), {
				from: on(select(AnnualEvidence, { kind }), "annual"),
				within: within(1n, 1n)
			})
		)
	]),
	contained(on(select(AnnualApproval, { authority: "FederalDC" }), "annual"), on(LookbackPeriod, "annual")),
	contained(on(AnnualApproval, "release"), on(PolicyRelease, "id")),
	contained(
		on(AnnualApproval, ["annual", "business", "authority", "year", "valid"]),
		on(AnnualPolicy, ["id", "business", "authority", "year", "valid"])
	),
	contained(on(CalculationPolicy, "authority"), on(Authority, "id")),
	contained(
		on(CalculationPolicy, ["calculation", "release", "business", "day"]),
		on(PayrollCalculation, ["id", "release", "business", "paidOn"])
	),
	contained(
		on(CalculationPolicy, ["annual", "release", "business", "authority", "day"]),
		on(AnnualApproval, ["annual", "release", "business", "authority", "valid"])
	),
	capacity(on(PayrollCalculation, "id"), {
		from: on(CalculationPolicy, "calculation"),
		within: within(BigInt(Authority.handles.length), BigInt(Authority.handles.length))
	}),
	contained(on(ElectionDocument, "employee"), on(Employee, "id")),
	contained(on(ElectionDocument, "artifact"), on(VerifiedArtifact, "artifact")),
	contained(
		on(ElectionDocumentRevision, ["document", "employee", "year"]),
		on(ElectionDocument, ["id", "employee", "year"])
	),
	contained(
		on(ElectionDocumentRevision, ["predecessor", "employee", "year"]),
		on(ElectionDocument, ["id", "employee", "year"])
	),
	contained(on(ElectionDocumentAmount, "document"), on(ElectionDocument, "id")),
	contained(on(ElectionDocumentAmount, "kind"), on(ElectionContributionKind, "id")),
	capacity(on(ElectionDocument, "id"), {
		from: on(ElectionDocumentAmount, "document"),
		within: within(
			BigInt(ElectionContributionKind.handles.length),
			BigInt(ElectionContributionKind.handles.length)
		)
	}),

	contained(on(Business, "state"), on(State, "id")),
	contained(on(StateAccount, "state"), on(State, "id")),
	contained(on(TaxAccount, "family"), on(AccountFamily, "id")),
	contained(on(Deduction, "kind"), on(DeductionKind, "id")),
	contained(on(Recovery, "component"), on(Component, "id")),
	contained(on(Recovery, "kind"), on(DeductionKind, "id")),
	contained(on(EmployerRateNotice, "state"), on(State, "id")),
	contained(on(SupportedPayrollDomain, "state"), on(State, "id")),
	contained(on(SupportedProgram, "program"), on(Program, "id")),
	contained(on(PolicyCoverage, "component"), on(Component, "id")),
	contained(on(RateVersion, "component"), on(Component, "id")),
	contained(on(TaxBand, "role"), on(BandRole, "id")),
	contained(on(TaxBaseScope, "program"), on(Program, "id")),
	contained(on(StateBaseScope, "state"), on(State, "id")),
	contained(on(Assessment, "origin"), on(AssessmentOrigin, "id")),
	contained(on(Assessment, "component"), on(Component, "id")),
	contained(on(Assessment, "method"), on(CalculationMethod, "id")),
	contained(on(ObservedAssessment, "component"), on(Component, "id")),
	contained(on(TaxableWages, "program"), on(Program, "id")),
	contained(on(CalculatedAssessment, "component"), on(Component, "id")),
	contained(on(AppliedRule, "component"), on(Component, "id")),
	contained(on(CalculationBasis, "component"), on(Component, "id")),
	contained(on(AssessmentRevision, "kind"), on(RevisionKind, "id")),
	contained(on(RevisionAccount, "family"), on(AccountFamily, "id")),
	contained(on(CalendarCoverage, "authority"), on(Authority, "id")),
	contained(on(CalendarCoverage, "kind"), on(PeriodKind, "id")),
	contained(on(CalendarPeriod, "authority"), on(Authority, "id")),
	contained(on(CalendarPeriod, "kind"), on(PeriodKind, "id")),
	contained(on(BusinessDay, "authority"), on(Authority, "id")),
	contained(on(BusinessDayCoverage, "authority"), on(Authority, "id")),
	contained(on(DepositPolicy, "authority"), on(Authority, "id")),
	contained(on(DepositPolicy, "family"), on(AccountFamily, "id")),
	contained(on(DepositPolicy, "periodKind"), on(PeriodKind, "id")),
	contained(on(DepositPolicy, "dueRule"), on(DueRule, "id")),
	contained(on(DepositTrigger, "kind"), on(CheckpointKind, "id")),
	contained(on(DepositCheckpoint, "kind"), on(CheckpointKind, "id")),
	contained(on(DepositCheckpoint, "periodKind"), on(PeriodKind, "id")),
	contained(on(FilingRequirement, "form"), on(Form, "id")),
	contained(on(FilingRequirement, "subjectKind"), on(SubjectKind, "id")),
	contained(on(FilingScope, "form"), on(Form, "id")),
	contained(on(FilingScope, "kind"), on(PeriodKind, "id")),
	contained(on(Filing, "form"), on(Form, "id")),
	contained(on(OriginalFiling, "kind"), on(PeriodKind, "id")),
	contained(on(FormMethodPolicy, "form"), on(Form, "id")),
	contained(on(FormMethodPolicy, "method"), on(SubmissionMethod, "id")),
	contained(on(DocumentRequirement, "role"), on(DocumentRole, "id")),
	contained(on(FilingVersion, "form"), on(Form, "id")),
	contained(on(FilingDocument, "role"), on(DocumentRole, "id")),
	contained(on(Submission, "form"), on(Form, "id")),
	contained(on(SubmissionDocument, "role"), on(DocumentRole, "id")),
	contained(on(Component, "payer"), on(Payer, "id")),
	contained(on(Component, "program"), on(Program, "id")),
	contained(on(Component, "family"), on(AccountFamily, "id")),
	contained(on(Component, "method"), on(CalculationMethod, "id")),
	contained(on(Employee, "business"), on(Business, "id")),
	contained(on(BusinessAddress, "business"), on(Business, "id")),
	contained(on(StateAccount, "business"), on(Business, "id")),
	contained(on(TaxAccount, "business"), on(Business, "id")),
	contained(on(AnnualBudget, "employee"), on(Employee, "id")),
	contained(on(BudgetCommitment, "employee"), on(Employee, "id")),
	contained(
		on(BudgetAssignment, ["commitment", "employee", "year", "amount"]),
		on(BudgetCommitment, ["id", "employee", "year", "amount"])
	),
	contained(
		on(BudgetAssignment, ["budget", "employee", "year"]),
		on(AnnualBudget, ["id", "employee", "year"])
	),
	capacity(on(AnnualBudget, "id"), {
		from: on(BudgetAssignment, "budget"),
		weight: weigh("amount"),
		within: within(0n, ref("limit"))
	}),
	contained(on(BankReference, "movement"), on(BankMovement, "id")),
	contained(on(Wage, ["employee", "business"]), on(Employee, ["id", "business"])),
	contained(
		on(Wage, ["calendar", "year", "paidOn"]),
		on(select(CalendarPeriod, { kind: "Year" }), ["id", "year", "span"])
	),
	contained(
		on(Wage, ["commitment", "employee", "year", "gross"]),
		on(BudgetCommitment, ["id", "employee", "year", "amount"])
	),
	contained(on(RegularWork, ["wage", "employee"]), on(Wage, ["id", "employee"])),
	contained(on(RegularCommitment, ["wage", "commitment"]), on(Wage, ["id", "commitment"])),
	mirrors(on(RegularCommitment, "wage"), on(RegularWork, "wage")),
	contained(on(ObservedCompensation, ["wage", "commitment"]), on(Wage, ["id", "commitment"])),
	contained(on(Deduction, "wage"), on(Wage, "id")),
	contained(on(Deduction, ["wage", "employee", "year"]), on(Wage, ["id", "employee", "year"])),
	capacity(on(Wage, "id"), {
		from: on(Deduction, "wage"),
		weight: weigh("amount"),
		within: within(0n, ref("gross"))
	}),
	contained(on(ElectionSource, "kind"), on(ElectionContributionKind, "id")),
	mirrors(on(Election, "id"), on(ElectionSource, "election")),
	contained(
		on(ElectionSource, ["election", "employee", "year", "signedOn", "limit"]),
		on(Election, ["id", "employee", "year", "signedOn", "limit"])
	),
	contained(
		on(ElectionSource, ["document", "employee", "year", "signedOn"]),
		on(ElectionDocument, ["id", "employee", "year", "signedOn"])
	),
	contained(
		on(ElectionSource, ["document", "kind", "limit"]),
		on(ElectionDocumentAmount, ["document", "kind", "cents"])
	),
	contained(
		on(ElectionSource, ["annual", "employee", "year"]),
		on(RetirementAnnual, ["id", "employee", "year"])
	),
	contained(on(ElectionSource, "election"), on(select(ElectionSource, { kind: "Roth" }), "election")),
	contained(on(Election, "employee"), on(Employee, "id")),
	contained(
		on(Election, ["calendar", "year", "effective"]),
		on(select(CalendarPeriod, { kind: "Year" }), ["id", "year", "span"])
	),
	contained(
		on(Election, ["allowance", "employee", "year", "maximum"]),
		on(EmployeeAllowance, ["id", "employee", "year", "limit"])
	),
	capacity(on(Election, "id"), {
		from: on(Election, "id"),
		weight: weigh("limit"),
		within: within(0n, ref("maximum"))
	}),
	contained(on(DeferralPolicy, "release"), on(PolicyRelease, "id")),
	contained(on(GrossSuggestionPolicy, "release"), on(PolicyRelease, "id")),
	contained(on(GrossSuggestionPolicy, "method"), on(GrossSuggestionMethod, "id")),
	contained(on(EmployeeAllowance, "employee"), on(Employee, "id")),
	contained(
		on(EmployeeAllowance, ["policy", "year", "maximum"]),
		on(DeferralPolicy, ["id", "year", "limit"])
	),
	capacity(on(EmployeeAllowance, "id"), {
		from: on(EmployeeAllowance, "id"),
		weight: weigh("limit"),
		within: within(0n, ref("maximum"))
	}),
	// Historical Roth remains observable without an election or allowance.
	// Once an allowance exists, ALL observed Roth counts toward its capacity.
	capacity(on(EmployeeAllowance, ["employee", "year"]), {
		from: on(select(Deduction, { kind: "Roth" }), ["employee", "year"]),
		weight: weigh("amount"),
		within: within(0n, ref("limit"))
	}),
	contained(on(ElectionUse, ["wage", "employee", "day"]), on(Wage, ["id", "employee", "paidOn"])),
	contained(on(ElectionUse, "kind"), on(DeductionKind, "id")),
	contained(on(ElectionUse, "wage"), on(select(ElectionUse, { kind: "Roth" }), "wage")),
	contained(on(ElectionUse, ["wage", "kind", "amount"]), on(Deduction, ["wage", "kind", "amount"])),
	contained(on(ElectionUse, ["election", "employee", "day"]), on(Election, ["id", "employee", "effective"])),
	capacity(on(Election, "id"), {
		from: on(ElectionUse, "election"),
		weight: weigh("amount"),
		within: within(0n, ref("limit"))
	}),
	contained(on(Recovery, ["fromWage", "employee"]), on(Wage, ["id", "employee"])),
	contained(on(Recovery, ["owedOnWage", "employee"]), on(Wage, ["id", "employee"])),
	contained(on(Recovery, "component"), on(select(Component, { payer: "Employee" }), "id")),
	contained(on(Recovery, ["fromWage", "kind"]), on(Deduction, ["wage", "kind"])),
	contained(on(Recovery, "id"), on(select(Recovery, { kind: "Recovery" }), "id")),
	capacity(on(Deduction, ["wage", "kind"]), {
		from: on(Recovery, ["fromWage", "kind"]),
		weight: weigh("amount"),
		within: within(0n, ref("amount"))
	}),
	contained(on(Review, "employee"), on(Employee, "id")),
	contained(on(Resolution, "review"), on(Review, "id")),
	contained(on(PolicyBinding, "business"), on(Business, "id")),
	contained(on(PolicyBinding, "release"), on(PolicyRelease, "id")),
	contained(on(EmployerRateNotice, "business"), on(Business, "id")),
	contained(on(EmployerRateNotice, "schedule"), on(RateSchedule, "id")),
	mirrors(on(select(RateVersion, { component: "FUTA" }), "id"), on(FutaBasis, "version")),
	mirrors(on(select(RateVersion, { component: "SUTA" }), "id"), on(EmployerSchedule, "version")),
	mirrors(
		on(select(RateVersion, { component: "SUTA" }), ["id", "business", "schedule", "valid"]),
		on(EmployerSchedule, ["version", "business", "schedule", "valid"])
	),
	contained(
		on(EmployerSchedule, ["notice", "business", "schedule", "valid"]),
		on(EmployerRateNotice, ["id", "business", "schedule", "valid"])
	),
	contained(on(SupportedPayrollDomain, "release"), on(PolicyRelease, "id")),
	capacity(on(SupportedPayrollDomain, "id"), {
		from: on(SupportedPayrollDomain, "id"),
		weight: weigh("federalDepositLimit"),
		within: within(1n, ref("federalDepositLimit"))
	}),
	contained(on(MonthlyDepositor, "business"), on(Business, "id")),
	contained(on(SupportedProgram, "domain"), on(SupportedPayrollDomain, "id")),
	...Array.from(
		new Set(
			components
				.filter((component) => componentPolicy[component].method === "MarginalBands")
				.map((component) => componentPolicy[component].program)
		)
	).map((program) =>
		capacity(on(SupportedPayrollDomain, "id"), {
			from: on(select(SupportedProgram, { program }), "domain"),
			within: within(1n)
		})
	),
	capacity(on(SupportedPayrollDomain, "id"), {
		from: on(select(SupportedProgram, { program: "Income" }), "domain"),
		within: within(0n)
	}),
	contained(on(PolicyCoverage, "release"), on(PolicyRelease, "id")),
	contained(on(PolicyCoverage, "business"), on(Business, "id")),
	mirrors(
		on(PolicyCoverage, ["release", "business", "component", "span"]),
		on(RateVersion, ["release", "business", "component", "valid"])
	),
	contained(on(RateVersion, "schedule"), on(RateSchedule, "id")),
	capacity(on(RateSchedule, "id"), {
		from: on(RateSchedule, "id"),
		weight: weigh("denominator"),
		within: within(1n, ref("denominator"))
	}),
	mirrors(on(TaxBand, ["schedule", "span"]), on(RateSchedule, ["id", "domain"])),
	capacity(on(select(TaxBand, { role: "Excess" }), "id"), {
		from: on(TaxBand, "id"),
		weight: weigh("numerator"),
		within: within(0n)
	}),
	contained(on(TaxBaseScope, ["employee", "business"]), on(Employee, ["id", "business"])),
	contained(
		on(TaxBaseScope, ["calendar", "year", "span"]),
		on(select(CalendarPeriod, { kind: "Year" }), ["id", "year", "span"])
	),
	mirrors(on(select(TaxBaseScope, { program: "StateUnemployment" }), "id"), on(StateBaseScope, "scope")),
	contained(on(AssessmentSet, ["employee", "business"]), on(Employee, ["id", "business"])),
	contained(on(PayrollCalculation, "release"), on(PolicyRelease, "id")),
	contained(
		on(PayrollCalculation, ["set", "business", "paidOn"]),
		on(AssessmentSet, ["id", "business", "paidOn"])
	),
	contained(
		on(PayrollCalculation, ["domain", "release", "paidOn"]),
		on(SupportedPayrollDomain, ["id", "release", "valid"])
	),
	contained(
		on(ProposedWage, ["calculation", "business", "paidOn"]),
		on(PayrollCalculation, ["id", "business", "paidOn"])
	),
	contained(
		on(ProposedWage, ["depositor", "business", "paidOn"]),
		on(MonthlyDepositor, ["id", "business", "valid"])
	),
	contained(on(ProposedRevision, ["predecessor", "wage"]), on(AssessmentRevision, ["id", "wage"])),
	contained(on(ProposedRevision, ["calculation", "set"]), on(PayrollCalculation, ["id", "set"])),
	contained(
		on(CalculationRecoveryClaim, ["calculation", "set"]),
		on(select(PayrollCalculation, { purpose: "NewWage" }), ["id", "set"])
	),
	contained(on(CalculationRecoveryClaim, ["set", "employee"]), on(AssessmentSet, ["id", "employee"])),
	contained(on(CalculationRecoveryClaim, ["owedOnWage", "employee"]), on(Wage, ["id", "employee"])),
	contained(
		on(CalculationRecoveryClaim, "component"),
		on(select(Component, { payer: "Employee", method: "MarginalBands" }), "id")
	),
	contained(
		on(ProposedRevision, ["set", "business", "employee", "gross", "paidOn"]),
		on(AssessmentSet, ["id", "business", "employee", "gross", "paidOn"])
	),
	contained(
		on(ProposedRevision, ["wage", "business", "employee", "gross", "paidOn"]),
		on(Wage, ["id", "business", "employee", "gross", "paidOn"])
	),
	contained(on(Assessment, ["set", "origin"]), on(AssessmentSet, ["id", "origin"])),
	...CalculationMethod.handles.map((method) =>
		contained(
			on(select(Assessment, { origin: "Calculated", method }), "component"),
			on(select(Component, { method }), "id")
		)
	),
	capacity(on(select(AssessmentSet, { origin: "Observed" }), "id"), {
		from: on(select(Assessment, { method: "MarginalBands" }), "set"),
		within: within(0n)
	}),
	mirrors(
		on(select(Assessment, { method: "SuppliedAmount" }), ["set", "component"]),
		on(ObservedAssessment, ["set", "component"])
	),
	mirrors(
		on(select(Assessment, { method: "MarginalBands" }), ["set", "component"]),
		on(CalculatedAssessment, ["set", "component"])
	),
	capacity(on(AssessmentSet, "id"), {
		from: on(Assessment, "set"),
		within: within(BigInt(components.length), BigInt(components.length))
	}),
	contained(on(ObservedAssessment, ["set", "component"]), on(Assessment, ["set", "component"])),
	contained(on(TaxableWages, "set"), on(AssessmentSet, "id")),
	contained(
		on(CalculatedAssessment, ["basis", "set", "component"]),
		on(CalculationBasis, ["id", "set", "component"])
	),
	mirrors(on(CalculatedAssessment, ["set", "component"]), on(AppliedRule, ["set", "component"])),
	contained(on(AppliedRule, ["set", "release"]), on(PayrollCalculation, ["set", "release"])),
	contained(on(AppliedRule, ["set", "business", "day"]), on(AssessmentSet, ["id", "business", "paidOn"])),
	contained(
		on(AppliedRule, ["version", "release", "business", "component", "schedule", "day"]),
		on(RateVersion, ["id", "release", "business", "component", "schedule", "valid"])
	),
	contained(
		on(CalculationBasis, ["set", "component", "schedule"]),
		on(AppliedRule, ["set", "component", "schedule"])
	),
	contained(on(CalculationWageBase, "set"), on(PayrollCalculation, "set")),
	contained(on(CalculationWageBase, "scope"), on(TaxBaseScope, "id")),
	contained(
		on(CalculationBasis, ["set", "scope", "cents", "earning"]),
		on(CalculationWageBase, ["set", "scope", "cents", "earning"])
	),
	capacity(on(CalculationWageBase, ["set", "scope"]), {
		from: on(CalculationBasis, ["set", "scope"]),
		within: within(1n, BigInt(components.length))
	}),
	capacity(on(CalculationWageBase, ["set", "scope"]), {
		from: on(CalculationWageBase, ["set", "scope"]),
		weight: weigh("cents"),
		within: within(0n, duration("earning"))
	}),
	capacity(on(CalculationWageBase, ["set", "scope"]), {
		from: on(CalculationWageBase, ["set", "scope"]),
		weight: weigh(duration("earning")),
		within: within(0n, ref("cents"))
	}),
	contained(
		on(CalculationBasis, ["set", "business", "employee", "cents", "paidOn"]),
		on(AssessmentSet, ["id", "business", "employee", "gross", "paidOn"])
	),
	contained(
		on(CalculationBasis, ["scope", "business", "employee", "year", "paidOn"]),
		on(TaxBaseScope, ["id", "business", "employee", "year", "span"])
	),
	...components.map((component) =>
		contained(
			on(select(CalculationBasis, { component }), "scope"),
			on(select(TaxBaseScope, { program: componentPolicy[component].program }), "id")
		)
	),
	contained(on(CalculationBasis, ["set", "domain"]), on(PayrollCalculation, ["set", "domain"])),
	contained(on(CalculationBasis, ["support", "domain"]), on(SupportedProgram, ["id", "domain"])),
	contained(on(CalculationBasis, ["support", "earning"]), on(SupportedProgram, ["id", "eligible"])),
	...components.map((component) =>
		contained(
			on(select(CalculationBasis, { component }), "support"),
			on(select(SupportedProgram, { program: componentPolicy[component].program }), "id")
		)
	),
	// TaxBand's pointwise key forbids overlap; its partition of RateSchedule
	// forbids gaps. Every captured earning range must lie in that exact schedule.
	contained(on(CalculationBasis, ["schedule", "earning"]), on(RateSchedule, ["id", "domain"])),
	capacity(on(CalculationBasis, "id"), {
		from: on(CalculationBasis, "id"),
		weight: weigh("cents"),
		within: within(0n, duration("earning"))
	}),
	capacity(on(CalculationBasis, "id"), {
		from: on(CalculationBasis, "id"),
		weight: weigh(duration("earning")),
		within: within(0n, ref("cents"))
	}),
	contained(
		on(AssessmentRevision, ["wage", "business", "employee", "gross", "paidOn"]),
		on(Wage, ["id", "business", "employee", "gross", "paidOn"])
	),
	contained(
		on(AssessmentRevision, ["set", "business", "employee", "gross", "paidOn"]),
		on(AssessmentSet, ["id", "business", "employee", "gross", "paidOn"])
	),
	mirrors(
		on(Wage, ["initialRevision", "id"]),
		on(select(AssessmentRevision, { kind: "Initial" }), ["id", "wage"])
	),
	mirrors(
		on(select(AssessmentRevision, { kind: "Correction" }), ["id", "wage"]),
		on(CorrectionAssessment, ["revision", "wage"])
	),
	contained(on(CorrectionAssessment, ["predecessor", "wage"]), on(AssessmentRevision, ["id", "wage"])),
	contained(on(RevisionAccount, ["revision", "business"]), on(AssessmentRevision, ["id", "business"])),
	capacity(on(AssessmentRevision, "id"), {
		from: on(RevisionAccount, "revision"),
		within: within(BigInt(AccountFamily.handles.length))
	}),
	contained(
		on(RevisionAccount, ["account", "business", "family"]),
		on(TaxAccount, ["id", "business", "family"])
	),
	contained(on(VerifiedArtifact, "artifact"), on(Artifact, "id")),
	contained(on(ArtifactLocation, "artifact"), on(Artifact, "id")),
	contained(on(TaxPayment, ["account", "business"]), on(TaxAccount, ["id", "business"])),
	contained(on(PaymentSettlement, "payment"), on(TaxPayment, "id")),
	contained(on(PaymentReference, "payment"), on(TaxPayment, "id")),
	contained(on(PaymentEvidence, "payment"), on(TaxPayment, "id")),
	contained(on(PaymentEvidence, "artifact"), on(Artifact, "id")),
	contained(
		on(PaymentReconciliation, ["payment", "business", "account"]),
		on(TaxPayment, ["id", "business", "account"])
	),
	contained(
		on(PaymentAllocation, ["revision", "account", "business"]),
		on(RevisionAccount, ["revision", "account", "business"])
	),
	contained(
		on(PaymentAllocation, ["reconciliation", "business", "account"]),
		on(PaymentReconciliation, ["id", "business", "account"])
	),
	contained(
		on(PaymentAllocation, ["revision", "business", "paidOn"]),
		on(AssessmentRevision, ["id", "business", "paidOn"])
	),
	contained(
		on(PaymentAllocation, ["reconciliation", "business", "account", "paidOn"]),
		on(PaymentReconciliation, ["id", "business", "account", "period"])
	),
	contained(on(PaymentAdjustment, "reconciliation"), on(PaymentReconciliation, "id")),
	contained(on(FinancialIssue, "business"), on(Business, "id")),
	contained(on(FinancialIssue, "scope"), on(FinancialScope, "id")),
	mirrors(on(select(FinancialIssue, { scope: "TaxAccount" }), "id"), on(PaymentIssue, "issue")),
	contained(on(PaymentIssue, ["issue", "business"]), on(FinancialIssue, ["id", "business"])),
	contained(on(PaymentIssue, ["account", "business"]), on(TaxAccount, ["id", "business"])),
	contained(on(FinancialResolution, "issue"), on(FinancialIssue, "id")),
	contained(on(SignedDisposition, ["revision", "account"]), on(RevisionAccount, ["revision", "account"])),
	contained(on(CalendarCoverage, "release"), on(PolicyRelease, "id")),
	mirrors(
		on(CalendarCoverage, ["release", "authority", "kind", "span"]),
		on(CalendarPeriod, ["release", "authority", "kind", "span"])
	),
	contained(on(BusinessDay, "release"), on(PolicyRelease, "id")),
	contained(on(BusinessDayCoverage, "release"), on(PolicyRelease, "id")),
	mirrors(
		on(BusinessDayCoverage, ["release", "authority", "span"]),
		on(BusinessDay, ["release", "authority", "span"])
	),
	contained(on(DepositPolicy, "release"), on(PolicyRelease, "id")),
	contained(
		on(DepositPolicy, ["account", "business", "family"]),
		on(TaxAccount, ["id", "business", "family"])
	),
	contained(on(DepositTrigger, "policy"), on(DepositPolicy, "id")),
	capacity(on(DepositPolicy, "id"), {
		from: on(DepositTrigger, "policy"),
		within: within(BigInt(CheckpointKind.handles.length))
	}),
	mirrors(
		on(DepositPolicy, ["id", "business", "account", "periodKind", "valid"]),
		on(DepositCheckpoint, ["policy", "business", "account", "periodKind", "span"])
	),
	contained(
		on(DepositCheckpoint, ["calendar", "periodKind", "year", "span"]),
		on(CalendarPeriod, ["id", "kind", "year", "span"])
	),
	contained(on(FilingRequirement, "business"), on(Business, "id")),
	contained(on(FilingRule, "release"), on(PolicyRelease, "id")),
	contained(on(FilingRule, "form"), on(Form, "id")),
	contained(on(FilingRule, "periodKind"), on(PeriodKind, "id")),
	contained(on(FilingRule, "authority"), on(Authority, "id")),
	contained(on(FilingRule, "dueRule"), on(DueRule, "id")),
	contained(on(RequirementEnd, "requirement"), on(FilingRequirement, "id")),
	contained(on(FilingSubject, "business"), on(Business, "id")),
	contained(on(BusinessSubject, ["subject", "business"]), on(FilingSubject, ["id", "business"])),
	contained(on(EmployeeSubject, ["subject", "business"]), on(FilingSubject, ["id", "business"])),
	contained(on(EmployeeSubject, ["employee", "business"]), on(Employee, ["id", "business"])),
	contained(
		on(FilingScope, ["requirement", "business", "form"]),
		on(FilingRequirement, ["id", "business", "form"])
	),
	contained(on(FilingScope, ["subject", "business"]), on(FilingSubject, ["id", "business"])),
	...forms.flatMap((form) => [
		contained(
			on(select(FilingRule, { form }), "id"),
			on(select(FilingRule, { periodKind: formPolicy[form].period }), "id")
		),
		contained(
			on(select(FilingRequirement, { form }), "id"),
			on(select(FilingRequirement, { subjectKind: formPolicy[form].subject }), "id")
		),
		contained(
			on(select(FilingScope, { form }), "id"),
			on(select(FilingScope, { kind: formPolicy[form].period }), "id")
		),
		contained(
			on(select(FilingScope, { form }), "subject"),
			on(select(FilingSubject, { kind: formPolicy[form].subject }), "id")
		),
		contained(
			on(select(Filing, { form }), "subject"),
			on(select(FilingSubject, { kind: formPolicy[form].subject }), "id")
		)
	]),
	contained(
		on(Filing, ["requirement", "business", "form"]),
		on(FilingRequirement, ["id", "business", "form"])
	),
	contained(on(Filing, ["subject", "business"]), on(FilingSubject, ["id", "business"])),
	contained(on(OriginalFiling, ["filing", "period"]), on(Filing, ["id", "period"])),
	contained(
		on(OriginalFiling, ["filing", "requirement", "subject", "business", "form"]),
		on(Filing, ["id", "requirement", "subject", "business", "form"])
	),
	contained(
		on(OriginalFiling, ["scope", "requirement", "subject", "business", "form"]),
		on(FilingScope, ["id", "requirement", "subject", "business", "form"])
	),
	mirrors(on(FilingScope, ["id", "kind", "span"]), on(OriginalFiling, ["scope", "kind", "period"])),
	contained(on(OriginalFiling, ["canonical", "kind", "period"]), on(CalendarPeriod, ["id", "kind", "span"])),
	contained(
		on(CorrectionFiling, ["filing", "business", "subject", "period"]),
		on(Filing, ["id", "business", "subject", "period"])
	),
	contained(
		on(CorrectionFiling, ["parent", "business", "subject", "period"]),
		on(Filing, ["id", "business", "subject", "period"])
	),
	contained(on(CorrectionFiling, ["filing", "form"]), on(Filing, ["id", "form"])),
	contained(on(CorrectionFiling, ["parent", "parentForm"]), on(Filing, ["id", "form"])),
	contained(on(CorrectionFiling, "form"), on(Form, "id")),
	contained(on(CorrectionFiling, "parentForm"), on(Form, "id")),
	...forms.map((parentForm) =>
		contained(
			on(select(CorrectionFiling, { parentForm }), "filing"),
			on(select(CorrectionFiling, { form: formPolicy[parentForm].correction }), "filing")
		)
	),
	contained(on(DeadlineRevision, "filing"), on(Filing, "id")),
	contained(on(FormMethodPolicy, "release"), on(PolicyRelease, "id")),
	contained(on(DocumentRequirement, "policy"), on(FormMethodPolicy, "id")),
	...submissionSlots.flatMap(({ form, method, slots }) => [
		...slots.map((role) =>
			capacity(on(select(FormMethodPolicy, { form, method }), "id"), {
				from: on(select(DocumentRequirement, { slot: role, role }), "policy"),
				within: within(1n)
			})
		),
		capacity(on(select(FormMethodPolicy, { form, method }), "id"), {
			from: on(DocumentRequirement, "policy"),
			within: within(BigInt(slots.length))
		}),
		capacity(on(select(FormMethodPolicy, { form, method }), "id"), {
			from: on(FormMethodPolicy, "id"),
			weight: weigh("requiredCount"),
			within: within(BigInt(slots.length))
		}),
		capacity(on(select(Submission, { form, method }), "id"), {
			from: on(SubmissionDocument, "submission"),
			within: within(BigInt(slots.length))
		})
	]),
	contained(on(FilingVersion, ["filing", "business", "form"]), on(Filing, ["id", "business", "form"])),
	contained(on(FilingVersion, "release"), on(PolicyRelease, "id")),
	contained(on(FilingBasis, ["version", "filing"]), on(FilingVersion, ["id", "filing"])),
	contained(on(FilingBasis, ["filing", "revision"]), on(FilingRevision, ["filing", "revision"])),
	contained(
		on(FilingRevision, ["filing", "business", "subject", "form", "paidOn"]),
		on(Filing, ["id", "business", "subject", "form", "period"])
	),
	contained(
		on(FilingRevision, ["revision", "business", "employee", "paidOn"]),
		on(AssessmentRevision, ["id", "business", "employee", "paidOn"])
	),
	contained(on(FilingRevision, "form"), on(Form, "id")),
	...(["F1099RIRS", "F1099RRecipient"] as const).map((form) =>
		capacity(on(select(Filing, { form }), "id"), { from: on(FilingRevision, "filing"), within: within(0n) })
	),
	contained(on(FilingRevision, "family"), on(AccountFamily, "id")),
	...payrollForms.flatMap((form) => [
		contained(
			on(select(FilingRevision, { form }), ["filing", "revision"]),
			on(select(FilingRevision, { family: formPolicy[form].family }), ["filing", "revision"])
		),
		...(formPolicy[form].subject === "Employee"
			? [
					contained(
						on(select(FilingRevision, { form }), ["subject", "employee", "business"]),
						on(EmployeeSubject, ["subject", "employee", "business"])
					)
				]
			: [])
	]),
	contained(on(FilingDocument, "version"), on(FilingVersion, "id")),
	contained(on(FilingDocument, "artifact"), on(Artifact, "id")),
	contained(on(FormAdjustment, "filing"), on(Filing, "id")),
	contained(on(FilingAdjustmentBasis, ["version", "filing"]), on(FilingVersion, ["id", "filing"])),
	contained(on(FilingAdjustmentBasis, ["adjustment", "filing"]), on(FormAdjustment, ["id", "filing"])),
	contained(on(AmendmentLiability, "filing"), on(CorrectionFiling, "filing")),
	...forms
		.filter((form) => !formPolicy[form].payment)
		.map((form) =>
			capacity(on(select(FilingRevision, { form }), ["filing", "revision"]), {
				from: on(AmendmentLiability, ["filing", "revision"]),
				within: within(0n)
			})
		),
	contained(
		on(AmendmentLiability, ["filing", "revision", "business", "family"]),
		on(FilingRevision, ["filing", "revision", "business", "family"])
	),
	contained(
		on(AmendmentLiability, ["revision", "account", "business", "family"]),
		on(RevisionAccount, ["revision", "account", "business", "family"])
	),
	contained(on(GrandfatheredEligibility, "filing"), on(select(Filing, { kind: "Original" }), "id")),
	contained(on(CertifiedMailing, "business"), on(Business, "id")),
	contained(on(CertifiedMailing, "receipt"), on(Artifact, "id")),
	contained(on(MailingEvidence, "mailing"), on(CertifiedMailing, "id")),
	contained(on(MailingEvidence, "artifact"), on(Artifact, "id")),
	contained(
		on(Submission, ["version", "business", "form", "release"]),
		on(FilingVersion, ["id", "business", "form", "release"])
	),
	contained(
		on(Submission, ["policy", "release", "form", "method", "requiredCount"]),
		on(FormMethodPolicy, ["id", "release", "form", "method", "requiredCount"])
	),
	contained(on(DigitalReference, "submission"), on(DigitalSubmission, "submission")),
	contained(on(DigitalReference, ["submission", "version"]), on(Submission, ["id", "version"])),
	contained(on(DigitalReference, ["version", "filing"]), on(FilingVersion, ["id", "filing"])),
	contained(on(GrandfatheredSubmission, ["submission", "version"]), on(Submission, ["id", "version"])),
	contained(on(GrandfatheredSubmission, ["version", "filing"]), on(FilingVersion, ["id", "filing"])),
	contained(on(GrandfatheredSubmission, "filing"), on(GrandfatheredEligibility, "filing")),
	contained(
		on(CertifiedMailSubmission, ["submission", "version", "business"]),
		on(Submission, ["id", "version", "business"])
	),
	contained(on(CertifiedMailSubmission, ["mailing", "business"]), on(CertifiedMailing, ["id", "business"])),
	contained(
		on(SubmissionDocument, ["submission", "version", "policy"]),
		on(Submission, ["id", "version", "policy"])
	),
	contained(
		on(SubmissionDocument, ["policy", "slot", "role"]),
		on(DocumentRequirement, ["policy", "slot", "role"])
	),
	contained(
		on(SubmissionDocument, ["version", "slot", "role", "artifact", "part"]),
		on(FilingDocument, ["version", "slot", "role", "artifact", "part"])
	),

	contained(on(Rejection, "submission"), on(Submission, "id")),
	contained(on(ImportProvenance, "artifact"), on(Artifact, "id"))
]

export const ledger = schema("WagieTools", relations, laws)
export default ledger
