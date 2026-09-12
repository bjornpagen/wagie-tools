import { closed, closedId, u64 } from "@bjornpagen/bumbledb"

// This catalog defines mechanisms and vocabulary. Dated rates live in PolicyRelease facts.
const componentHandles = [
	"FIT",
	"EmployeeSS",
	"EmployerSS",
	"EmployeeMedicare",
	"EmployerMedicare",
	"FUTA",
	"SUTA"
] as const
const componentAxioms = {
	FIT: {
		payer: "Employee",
		program: "Income",
		family: "Federal941",
		method: "SuppliedAmount"
	},
	EmployeeSS: {
		payer: "Employee",
		program: "SocialSecurity",
		family: "Federal941",
		method: "MarginalBands"
	},
	EmployerSS: { payer: "Employer", program: "SocialSecurity", family: "Federal941", method: "MarginalBands" },
	EmployeeMedicare: {
		payer: "Employee",
		program: "Medicare",
		family: "Federal941",
		method: "MarginalBands"
	},
	EmployerMedicare: { payer: "Employer", program: "Medicare", family: "Federal941", method: "MarginalBands" },
	FUTA: { payer: "Employer", program: "FederalUnemployment", family: "Federal940", method: "MarginalBands" },
	SUTA: {
		payer: "Employer",
		program: "StateUnemployment",
		family: "TexasUnemployment",
		method: "MarginalBands"
	}
} as const
export const payrollForms = ["F941", "F941X", "F940", "TexasUnemployment", "W2SSA", "W2Employee"] as const
export const retirementForms = ["F1099RIRS", "F1099RRecipient"] as const
const formHandles = [...payrollForms, ...retirementForms] as const
const methodHandles = ["Grandfathered", "Digital", "CertifiedMail"] as const
const documentRoleHandles = ["Return", "Transmittal", "Confirmation", "Receipt", "Supporting"] as const
export const formPolicy = {
	F1099RIRS: {
		correction: "F1099RIRS",
		payment: false,
		authority: "FederalDC",
		period: "Year",
		subject: "Plan",
		family: null,
		due: "RecordedEvent"
	},
	F1099RRecipient: {
		correction: "F1099RRecipient",
		payment: false,
		authority: "FederalDC",
		period: "Year",
		subject: "Plan",
		family: null,
		due: "RecordedEvent"
	},
	F941: {
		correction: "F941X",
		payment: true,
		authority: "FederalDC",
		period: "Quarter",
		subject: "Business",
		family: "Federal941",
		due: "MonthEnd"
	},
	F941X: {
		correction: "F941X",
		payment: true,
		authority: "FederalDC",
		period: "Quarter",
		subject: "Business",
		family: "Federal941",
		due: "RecordedEvent"
	},
	F940: {
		correction: "F940",
		payment: true,
		authority: "FederalDC",
		period: "Year",
		subject: "Business",
		family: "Federal940",
		due: "MonthEnd"
	},
	TexasUnemployment: {
		correction: "TexasUnemployment",
		payment: true,
		authority: "Texas",
		period: "Quarter",
		subject: "Business",
		family: "TexasUnemployment",
		due: "MonthEnd"
	},
	W2SSA: {
		correction: "W2SSA",
		payment: false,
		authority: "FederalDC",
		period: "Year",
		subject: "Employee",
		family: "Federal941",
		due: "MonthEnd"
	},
	W2Employee: {
		correction: "W2Employee",
		payment: false,
		authority: "FederalDC",
		period: "Year",
		subject: "Employee",
		family: "Federal941",
		due: "MonthEnd"
	}
} as const

export const withholdingPolicy = [
	{ component: "FIT", kind: "FIT" },
	{ component: "EmployeeSS", kind: "SocialSecurity" },
	{ component: "EmployeeMedicare", kind: "Medicare" }
] as const

// Closed requirements describe applicability, never a default numeric value.
export const annualRequirements = {
	FederalDC: {
		rates: [
			"EmployeeSS",
			"EmployerSS",
			"EmployeeMedicare",
			"EmployerMedicare",
			"AdditionalMedicare",
			"FUTAGross",
			"FUTAMaximumCredit",
			"FUTAFullCredit",
			"TexasCreditReduction"
		],
		limits: [
			"RegularDeferral",
			"AnnualAdditions",
			"MonthlyLookbackMaximum",
			"NextDayDepositMinimum",
			"FUTAInterimMinimum"
		],
		evidence: ["OriginalLookbackReturns", "FUTACreditEligibility"]
	},
	Texas: { rates: ["SUTAEntry"], limits: ["StateWageBase"], evidence: ["AssignedStateRate"] }
} as const

export const State = closed("State", ["TX"])
export const Payer = closed("Payer", ["Employee", "Employer"])
export const Program = closed("Program", [
	"Income",
	"SocialSecurity",
	"Medicare",
	"FederalUnemployment",
	"StateUnemployment"
])
export const AccountFamily = closed("AccountFamily", ["Federal941", "Federal940", "TexasUnemployment"])
export const CalculationMethod = closed("CalculationMethod", ["MarginalBands", "SuppliedAmount"])
export const Component = closed(
	"Component",
	componentHandles,
	{
		payer: closedId(Payer),
		program: closedId(Program),
		family: closedId(AccountFamily),
		method: closedId(CalculationMethod)
	},
	componentAxioms
)
export const Form = closed("Form", formHandles)
export const SubmissionMethod = closed("SubmissionMethod", methodHandles)
export const DocumentRole = closed("DocumentRole", documentRoleHandles)
export const PeriodKind = closed("PeriodKind", ["Year", "Quarter", "Month"])
export const Authority = closed("Authority", ["FederalDC", "Texas"])
export const AssessmentOrigin = closed("AssessmentOrigin", ["Calculated", "Observed"])
export const RevisionKind = closed("RevisionKind", ["Initial", "Correction"])
export const CalculationPurpose = closed("CalculationPurpose", ["NewWage", "TaxRevision"])
export const CommitmentOrigin = closed("CommitmentOrigin", ["Regular", "Observed"])
export const DeductionKind = closed("DeductionKind", [
	"FIT",
	"SocialSecurity",
	"Medicare",
	"Roth",
	"Recovery"
])
export const VersionOrigin = closed("VersionOrigin", ["Prepared", "Attested"])
export const FilingKind = closed("FilingKind", ["Original", "Correction"])
export const SubjectKind = closed("SubjectKind", ["Business", "Employee", "Plan"])
export const BandRole = closed(
	"BandRole",
	["WithinBase", "Excess"],
	{ taxable: u64 },
	{
		WithinBase: { taxable: 1n },
		Excess: { taxable: 0n }
	}
)
export const CheckpointKind = closed("CheckpointKind", ["Interim", "Terminal"])
export const DueRule = closed("DueRule", ["FollowingMonth15", "FollowingMonthEnd"])
export const CashDirection = closed("CashDirection", ["Outflow", "Inflow"])
export const BankStatus = closed("BankStatus", ["Sent", "Failed"])
export const CashPurpose = closed("CashPurpose", [
	"PayrollCash",
	"RothRemittance",
	"OwnerDistribution",
	"DistributionReturn",
	"TaxPayment"
])
export const ContributionSource = closed("ContributionSource", ["EmployeeRothDeferral", "EmployeeAfterTax"])
export const ContributionOrigin = closed("ContributionOrigin", ["Authorized", "Observed"])
export const PlanAccountKind = closed("PlanAccountKind", ["AfterTax", "Roth", "Pretax", "RothIRA"])
export const GrossSuggestionMethod = closed("GrossSuggestionMethod", ["RemainingBudgetDays"])
export const PublishedRateKind = closed("PublishedRateKind", [
	"EmployeeSS",
	"EmployerSS",
	"EmployeeMedicare",
	"EmployerMedicare",
	"AdditionalMedicare",
	"FUTAGross",
	"FUTAMaximumCredit",
	"FUTAFullCredit",
	"TexasCreditReduction",
	"SUTAEntry"
])
export const PolicyLimitKind = closed("PolicyLimitKind", [
	"RegularDeferral",
	"AnnualAdditions",
	"MonthlyLookbackMaximum",
	"NextDayDepositMinimum",
	"FUTAInterimMinimum",
	"StateWageBase"
])
export const PolicyEvidenceKind = closed("PolicyEvidenceKind", [
	"OriginalLookbackReturns",
	"FUTACreditEligibility",
	"AssignedStateRate"
])
export const ElectionContributionKind = closed("ElectionContributionKind", [
	"Roth",
	"Traditional",
	"OptionalAfterTax",
	"EmployerProfitSharing"
])
export const FinancialScope = closed("FinancialScope", ["TaxAccount"])

export const components = Component.handles
export const componentPolicy = Component.axioms
export const forms = Form.handles
export const methods = SubmissionMethod.handles
export const documentRoles = DocumentRole.handles

export const submissionSlots = forms.flatMap((form) =>
	methods.map((method) => ({
		form,
		method,
		slots:
			method === "Grandfathered"
				? ([] as const)
				: (form === "W2SSA" || form === "F1099RIRS") && method === "CertifiedMail"
					? (["Return", "Transmittal"] as const)
					: (["Return"] as const)
	}))
)
