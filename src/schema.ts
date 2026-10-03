import {
	alternatives,
	bool,
	capacity,
	closed,
	closedId,
	contained,
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

/* Representation first: every fact is stored once, and every invariant the
 * library can state is a law. Money is u64 cents. A day is an i64 epoch day, or
 * a unit interval where a law places it inside a span. A period is a half-open
 * interval of days. A rate is u64 parts per million. Identities are natural: a
 * Mercury Tracking ID, an EFT or TWC number, a TIN, or a UUIDv8 derived from a
 * day or from a form and period. */

// ── Rosters: closed vocabularies and the rules they carry ──────────────────

/** Who the forms name. The ledger keeps at most one of each. */
export const Role = closed("Role", ["Employer", "Employee", "Plan"])
/** Texas is a closed entry: employing in another state means new roster
 * entries (its jurisdiction, tax, account and return), a deliberate change. */
export const Jurisdiction = closed(
	"Jurisdiction",
	["Federal", "TX"],
	{ state: bool },
	{ Federal: { state: false }, TX: { state: true } }
)
export const Periodicity = closed("Periodicity", ["Month", "Quarter", "Year"])
/** What makes a return due for a period: being employed in its jurisdiction,
 * paying wages in it, or plan activity in it. */
export const Trigger = closed("Trigger", ["Employment", "Wages", "PlanActivity"])
export const Processor = closed("Processor", ["EFTPS", "TWC"])

const due = (dueDay: bigint, dueOffset: bigint) => ({ dueDay, dueOffset })
const files = (electronic: boolean, certifiedMail: boolean, furnished: boolean) => ({
	electronic,
	certifiedMail,
	furnished
})
/** Every return the ledger files. A return is due on the next business day
 * after day `dueDay` (clamped to the month) of the month `dueOffset` months
 * after the month holding the period's last day, and may be filed only the
 * ways its flags allow. A 941-X is a `Correction`, not a form. */
export const Form = closed(
	"Form",
	["F941", "F940", "W2", "W3", "C3", "F1099R", "F1096"],
	{
		jurisdiction: closedId(Jurisdiction),
		period: closedId(Periodicity),
		trigger: closedId(Trigger),
		dueDay: u64,
		dueOffset: u64,
		electronic: bool,
		certifiedMail: bool,
		furnished: bool
	},
	{
		F941: {
			jurisdiction: "Federal",
			period: "Quarter",
			trigger: "Employment",
			...due(31n, 1n),
			...files(false, true, false)
		},
		F940: {
			jurisdiction: "Federal",
			period: "Year",
			trigger: "Wages",
			...due(31n, 1n),
			...files(false, true, false)
		},
		W2: {
			jurisdiction: "Federal",
			period: "Year",
			trigger: "Wages",
			...due(31n, 1n),
			...files(false, false, true)
		},
		W3: {
			jurisdiction: "Federal",
			period: "Year",
			trigger: "Wages",
			...due(31n, 1n),
			...files(true, true, false)
		},
		C3: {
			jurisdiction: "TX",
			period: "Quarter",
			trigger: "Employment",
			...due(31n, 1n),
			...files(true, false, false)
		},
		F1099R: {
			jurisdiction: "Federal",
			period: "Year",
			trigger: "PlanActivity",
			...due(31n, 1n),
			...files(false, false, true)
		},
		F1096: {
			jurisdiction: "Federal",
			period: "Year",
			trigger: "PlanActivity",
			...due(28n, 2n),
			...files(false, true, false)
		}
	}
)
export type FormHandle = (typeof Form.handles)[number]

/** The 1099-R reports these moves: G is a direct rollover or an in-plan Roth
 * conversion, H a designated Roth rollover to a Roth IRA. The after-tax
 * conversion is implied by AfterTax transfers; the rest are recorded. */
export const reportedMoves = ["Pretax_G", "AfterTax_G", "Roth_G", "Roth_H"] as const
/** Every line of every form, in the form's order. `src/forms.ts` computes each. */
export const formLines = {
	F941: [
		"F941_1",
		"F941_2",
		"F941_3",
		"F941_5a1",
		"F941_5a2",
		"F941_5c1",
		"F941_5c2",
		"F941_5e",
		"F941_6",
		"F941_7",
		"F941_10",
		"F941_12",
		"F941_13",
		"F941_14",
		"F941_15",
		"F941_16_1",
		"F941_16_2",
		"F941_16_3"
	],
	F940: ["F940_3", "F940_5", "F940_7", "F940_8", "F940_12", "F940_13", "F940_14", "F940_15"],
	W2: ["W2_1", "W2_2", "W2_3", "W2_4", "W2_5", "W2_6", "W2_12AA", "W2_13"],
	W3: ["W3_c", "W3_1", "W3_2", "W3_3", "W3_4", "W3_5", "W3_6", "W3_12a"],
	C3: ["C3_employees_1", "C3_employees_2", "C3_employees_3", "C3_wages", "C3_taxable", "C3_rate", "C3_tax"],
	F1099R: [
		"F1099R_Pretax_G_1",
		"F1099R_Pretax_G_2a",
		"F1099R_Pretax_G_5",
		"F1099R_AfterTax_G_1",
		"F1099R_AfterTax_G_2a",
		"F1099R_AfterTax_G_5",
		"F1099R_Roth_G_1",
		"F1099R_Roth_G_2a",
		"F1099R_Roth_G_5",
		"F1099R_Roth_H_1",
		"F1099R_Roth_H_2a",
		"F1099R_Roth_H_5"
	],
	F1096: ["F1096_3", "F1096_5"]
} as const satisfies { readonly [F in FormHandle]: readonly string[] }
export type LineHandle = (typeof formLines)[FormHandle][number]
/** The 941 lines a 941-X restates: wages, FIT, the taxable wages and the
 * fractions of cents. Every other line follows from these. */
export const correctable = [
	"F941_2",
	"F941_3",
	"F941_5a1",
	"F941_5c1",
	"F941_7"
] as const satisfies readonly LineHandle[]
const lineHandles = [
	...formLines.F941,
	...formLines.F940,
	...formLines.W2,
	...formLines.W3,
	...formLines.C3,
	...formLines.F1099R,
	...formLines.F1096
] as const
const formOfLine = Object.fromEntries(
	Object.entries(formLines).flatMap(([form, lines]) => lines.map((line) => [line, form]))
) as { readonly [L in LineHandle]: FormHandle }
export const Line = closed(
	"Line",
	lineHandles,
	{ form: closedId(Form), correctable: bool },
	Object.fromEntries(
		lineHandles.map((line) => [
			line,
			{ form: formOfLine[line], correctable: (correctable as readonly string[]).includes(line) }
		])
	) as { readonly [L in LineHandle]: { readonly form: FormHandle; readonly correctable: boolean } }
)

/** Where tax is paid. A payment names its account's `period`; tax accrues by
 * `accrues` and each accrual is due by the same rule as a return. Once the
 * account's return is filed for a period, its `liability` line is what the
 * period owes. */
export const TaxAccount = closed(
	"TaxAccount",
	["Federal941", "Federal940", "TexasUI"],
	{
		jurisdiction: closedId(Jurisdiction),
		processor: closedId(Processor),
		period: closedId(Periodicity),
		accrues: closedId(Periodicity),
		dueDay: u64,
		dueOffset: u64,
		liability: closedId(Line)
	},
	{
		Federal941: {
			jurisdiction: "Federal",
			processor: "EFTPS",
			period: "Quarter",
			accrues: "Month",
			...due(15n, 1n),
			liability: "F941_12"
		},
		Federal940: {
			jurisdiction: "Federal",
			processor: "EFTPS",
			period: "Year",
			accrues: "Year",
			...due(31n, 1n),
			liability: "F940_12"
		},
		TexasUI: {
			jurisdiction: "TX",
			processor: "TWC",
			period: "Quarter",
			accrues: "Quarter",
			...due(31n, 1n),
			liability: "C3_tax"
		}
	}
)
export type AccountHandle = (typeof TaxAccount.handles)[number]

const tax = (account: AccountHandle, employee: boolean, employer: boolean, banded: boolean) => ({
	account,
	employee,
	employer,
	banded
})
/** Each payroll tax: the account it is paid into, who bears it, and whether
 * it is priced by a band of the year's policy. FIT is supplied, not banded. */
export const Tax = closed(
	"Tax",
	["FIT", "SocialSecurity", "Medicare", "FederalUnemployment", "TexasUnemployment"],
	{ account: closedId(TaxAccount), employee: bool, employer: bool, banded: bool },
	{
		FIT: tax("Federal941", true, false, false),
		SocialSecurity: tax("Federal941", true, true, true),
		Medicare: tax("Federal941", true, true, true),
		FederalUnemployment: tax("Federal940", false, true, true),
		TexasUnemployment: tax("TexasUI", false, true, true)
	}
)
export type TaxHandle = (typeof Tax.handles)[number]
const federal = (handle: TaxHandle) =>
	TaxAccount.axioms[Tax.axioms[handle].account].jurisdiction === "Federal"
/** The taxes every year's policy must price, and every paycheck must withhold. */
export const federalBanded = Tax.handles.filter((handle) => federal(handle) && Tax.axioms[handle].banded)
export const federalWithheld = Tax.handles.filter((handle) => federal(handle) && Tax.axioms[handle].employee)

export const TransferKind = closed("TransferKind", [
	"NetPay",
	"RothDeferral",
	"AfterTax",
	"Distribution",
	"Tax"
])
/** Deposit and Balance pay the period's tax; a Penalty never does. */
export const PaymentKind = closed("PaymentKind", ["Deposit", "Balance", "Penalty"])
/** Every tax payment is funded by its Mercury debit, except history's. */
export const Funding = closed("Funding", ["Mercury", "OutsideMercury"])
/** How a return was filed. Attested is history's: filed, but how is unknown. */
export const Method = closed("Method", ["Electronic", "CertifiedMail", "Furnished", "Attested"])
export const PlanAccount = closed("PlanAccount", ["Pretax", "AfterTax", "Roth"])
/** Form 1099-R box 7: G direct rollover or conversion, H Roth to Roth IRA. */
export const DistributionCode = closed("DistributionCode", ["G", "H"])
/** The plan moves recorded for the 1099-R. */
export const PlanMove = closed(
	"PlanMove",
	["Pretax_G", "Roth_G", "Roth_H"],
	{ account: closedId(PlanAccount), code: closedId(DistributionCode) },
	{
		Pretax_G: { account: "Pretax", code: "G" },
		Roth_G: { account: "Roth", code: "G" },
		Roth_H: { account: "Roth", code: "H" }
	}
)

// ── Who and where ───────────────────────────────────────────────────────────

/** The employer, its one employee and the 401(k) plan, which files its own
 * 1099-R and 1096. `tin` is the EIN or SSN. */
export const Party = relation("Party", { role: closedId(Role), name: str, tin: str, address: str })
/** The employer's account with each state it employs in (TWC for Texas). */
export const Registration = relation("Registration", { state: closedId(Jurisdiction), number: str })
/** When and where the owner works for the business: 941 line 1, the C-3's
 * monthly counts, and which state's taxes and returns apply. */
export const Employment = relation("Employment", { span: interval(i64), state: closedId(Jurisdiction) })
/** Where each plan account is held, and its number there. */
export const Custody = relation("Custody", { account: closedId(PlanAccount), custodian: str, number: str })
/** Days the ledger did not record. A filing for a period inside them may be
 * attested; a payment made inside them may have been paid outside Mercury.
 * Only an import writes it. */
export const History = relation("History", { span: interval(i64) })

// ── Policy, per year ────────────────────────────────────────────────────────

/** The year's federal plan limits and the ceiling on wages the ledger holds:
 * above $200,000 Additional Medicare and faster deposit rules would apply. */
export const TaxYear = relation("TaxYear", {
	year: i64,
	span: interval(i64),
	deferralLimit: u64,
	additionsLimit: u64,
	compensationLimit: u64,
	wageCeiling: u64
})
/** The slice of the year's wage axis a tax applies to, at its rate. Wages
 * beyond the band are not taxed: a wage base is just where the band ends. */
export const TaxBand = relation("TaxBand", { year: i64, tax: closedId(Tax), wages: interval(u64), rate: u64 })
export const PayPlan = relation("PayPlan", { year: i64, salary: u64, fitPerCheck: u64 })
/** The signed plan election for a year: employee Roth and voluntary after-tax. */
export const Election = relation("Election", { year: i64, roth: u64, afterTax: u64, signedOn: i64 })

// ── Paychecks ───────────────────────────────────────────────────────────────

/** One paycheck per day. Its place on the year's wage axis, [ytd, ytd + gross),
 * follows from the gross paid on earlier days, so it is never stored. */
export const Wage = relation("Wage", { id: uuid, paidOn: interval(i64, 1n), year: i64, gross: u64, roth: u64 })
/** What each employee tax took from a paycheck, as assessed. FICA on a
 * paycheck that could not cover it was advanced and is recovered later. */
export const Withholding = relation("Withholding", { wage: uuid, tax: closedId(Tax), amount: u64 })
/** Net pay overpaid on `wage`, withheld back from `recoveredBy`'s net. */
export const Recovery = relation("Recovery", { wage: uuid, recoveredBy: uuid, amount: u64 })

// ── Money out ───────────────────────────────────────────────────────────────

/** Every movement out of Mercury, keyed by its Mercury Tracking ID. Exactly one
 * arm says what it was and holds what Mercury sent. */
export const Transfer = relation("Transfer", { mercury: str, sentOn: i64, kind: closedId(TransferKind) })
export const NetPay = relation("NetPay", { transfer: str, wage: uuid, amount: u64 })
/** Wired to the plan's Roth account. */
export const RothDeferral = relation("RothDeferral", { transfer: str, wage: uuid, amount: u64 })
/** The mega backdoor: wired to the plan's after-tax account as an S-corp
 * distribution, converted in-plan. `year` is the plan's contribution year. */
export const AfterTax = relation("AfterTax", { transfer: str, year: i64, amount: u64 })
export const Distribution = relation("Distribution", { transfer: str, amount: u64 })
/** The Mercury debit that paid a tax payment: an arm of both. */
export const TaxDebit = relation("TaxDebit", { transfer: str, payment: str })

/** EFTPS and TWC alike, keyed by the processor's tracker (EFT # or TWC
 * confirmation #). The processor follows from the account. */
export const TaxPayment = relation("TaxPayment", {
	tracker: str,
	account: closedId(TaxAccount),
	kind: closedId(PaymentKind),
	period: interval(i64),
	amount: u64,
	initiatedOn: interval(i64, 1n),
	funding: closedId(Funding)
})

// ── Filings ─────────────────────────────────────────────────────────────────

export const Filing = relation("Filing", {
	id: uuid,
	form: closedId(Form),
	period: interval(i64),
	method: closedId(Method)
})
export const Electronic = relation("Electronic", { filing: uuid, on: i64, confirmation: str })
export const CertifiedMail = relation("CertifiedMail", { filing: uuid, mailedOn: i64, tracking: str })
/** Recipient copies: the W-2 to the employee, the 1099-R to the recipient. */
export const Furnished = relation("Furnished", { filing: uuid, on: i64 })
/** Every line of a return exactly as filed. Once filed, a return's liability
 * line is what its period owes. */
export const FiledFigures = relation("FiledFigures", { filing: uuid, line: closedId(Line), value: i64 })
/** A 941-X: the correction of a filed 941, mailed certified. */
export const Correction = relation("Correction", { filing: uuid, mailedOn: i64, tracking: str })
/** The correctable lines as corrected. The originals are the 941's figures. */
export const CorrectedFigures = relation("CorrectedFigures", {
	filing: uuid,
	line: closedId(Line),
	value: i64
})
/** A plan move that needs a 1099-R, as the plan reports it: gross (box 1),
 * taxable (box 2a) and the basis it carries (box 5). */
export const PlanDistribution = relation("PlanDistribution", {
	year: i64,
	move: closedId(PlanMove),
	gross: u64,
	taxable: u64,
	basis: u64
})

export const relations = {
	Role,
	Jurisdiction,
	Periodicity,
	Trigger,
	Processor,
	Form,
	Line,
	TaxAccount,
	Tax,
	TransferKind,
	PaymentKind,
	Funding,
	Method,
	PlanAccount,
	DistributionCode,
	PlanMove,
	Party,
	Registration,
	Employment,
	Custody,
	History,
	TaxYear,
	TaxBand,
	PayPlan,
	Election,
	Wage,
	Withholding,
	Recovery,
	Transfer,
	NetPay,
	RothDeferral,
	AfterTax,
	Distribution,
	TaxDebit,
	TaxPayment,
	Filing,
	Electronic,
	CertifiedMail,
	Furnished,
	FiledFigures,
	Correction,
	CorrectedFigures,
	PlanDistribution
}

// ── Laws ───────────────────────────────────────────────────────────────────

export const WageById = key(Wage, ["id"])
export const WageByDay = key(Wage, ["paidOn"])
export const TransferByMercury = key(Transfer, ["mercury"])
export const PaymentByTracker = key(TaxPayment, ["tracker"])
export const FilingById = key(Filing, ["id"])
export const FilingByPeriod = key(Filing, ["form", "period"])
const transferArms = {
	NetPay: key(NetPay, ["transfer"]),
	RothDeferral: key(RothDeferral, ["transfer"]),
	AfterTax: key(AfterTax, ["transfer"]),
	Distribution: key(Distribution, ["transfer"]),
	Tax: key(TaxDebit, ["transfer"])
}
/** Methods with something to record; Attested has nothing, so no arm. */
const methodArms = { Electronic, CertifiedMail, Furnished }
const filed = ["Electronic", "CertifiedMail", "Furnished"] as const

export const ledger = schema("WagieTools", relations, [
	// Identity: natural keys; intervals keyed pointwise never overlap.
	key(Party, ["role"]),
	key(Party, ["tin"]),
	key(Registration, ["state"]),
	key(Employment, ["span"]),
	key(Custody, ["account"]),
	key(Custody, ["number"]),
	key(History, ["span"]),
	key(TaxYear, ["year"]),
	key(TaxYear, ["year", "span"]),
	key(TaxBand, ["year", "tax"]),
	key(PayPlan, ["year"]),
	key(Election, ["year"]),
	WageById,
	WageByDay,
	key(Withholding, ["wage", "tax"]),
	key(Recovery, ["wage", "recoveredBy"]),
	TransferByMercury,
	PaymentByTracker,
	key(TaxDebit, ["payment"]),
	FilingById,
	FilingByPeriod,
	...Object.values(transferArms),
	...Object.values(methodArms).map((arm) => key(arm, ["filing"])),
	key(CertifiedMail, ["tracking"]),
	key(FiledFigures, ["filing", "line"]),
	key(Correction, ["filing"]),
	key(Correction, ["tracking"]),
	key(CorrectedFigures, ["filing", "line"]),
	key(PlanDistribution, ["year", "move"]),

	// The rosters' columns name rosters.
	contained(on(Form, "jurisdiction"), on(Jurisdiction, "id")),
	contained(on(Form, "period"), on(Periodicity, "id")),
	contained(on(Form, "trigger"), on(Trigger, "id")),
	contained(on(Line, "form"), on(Form, "id")),
	contained(on(TaxAccount, "jurisdiction"), on(Jurisdiction, "id")),
	contained(on(TaxAccount, "processor"), on(Processor, "id")),
	contained(on(TaxAccount, "period"), on(Periodicity, "id")),
	contained(on(TaxAccount, "accrues"), on(Periodicity, "id")),
	contained(on(TaxAccount, "liability"), on(Line, "id")),
	contained(on(Tax, "account"), on(TaxAccount, "id")),
	contained(on(PlanMove, "account"), on(PlanAccount, "id")),
	contained(on(PlanMove, "code"), on(DistributionCode, "id")),

	// Who and where: one of each party; registered wherever the owner works.
	contained(on(Party, "role"), on(Role, "id")),
	contained(on(Registration, "state"), on(select(Jurisdiction, { state: true }), "id")),
	contained(on(Employment, "state"), on(Registration, "state")),
	contained(on(Custody, "account"), on(PlanAccount, "id")),

	// Policy: every year prices every federal banded tax exactly once.
	contained(on(TaxBand, "year"), on(TaxYear, "year")),
	contained(on(TaxBand, "tax"), on(select(Tax, { banded: true }), "id")),
	...federalBanded.map((handle) =>
		capacity(on(TaxYear, "year"), { from: on(select(TaxBand, { tax: handle }), "year"), within: within(1n) })
	),
	contained(on(PayPlan, "year"), on(TaxYear, "year")),
	contained(on(Election, "year"), on(TaxYear, "year")),
	capacity(on(TaxYear, "year"), {
		from: on(Election, "year"),
		weight: weigh("roth"),
		within: within(0n, ref("deferralLimit"))
	}),

	// A paycheck: paid while employed, in its tax year, under an election, at
	// least a cent, never more Roth than gross, every federal withholding once.
	contained(on(Wage, "paidOn"), on(Employment, "span")),
	contained(on(Wage, ["year", "paidOn"]), on(TaxYear, ["year", "span"])),
	contained(on(Wage, "year"), on(Election, "year")),
	capacity(on(Wage, "id"), { from: on(Wage, "id"), weight: weigh("gross"), within: within(1n, "*") }),
	capacity(on(Wage, "id"), { from: on(Wage, "id"), weight: weigh("roth"), within: within(0n, ref("gross")) }),
	capacity(on(Election, "year"), { from: on(Wage, "year"), weight: weigh("roth"), within: within(0n, ref("roth")) }),
	capacity(on(TaxYear, "year"), {
		from: on(Wage, "year"),
		weight: weigh("gross"),
		within: within(0n, ref("wageCeiling"))
	}),
	contained(on(Withholding, "wage"), on(Wage, "id")),
	contained(on(Withholding, "tax"), on(select(Tax, { employee: true }), "id")),
	...federalWithheld.map((handle) =>
		capacity(on(Wage, "id"), { from: on(select(Withholding, { tax: handle }), "wage"), within: within(1n) })
	),
	contained(on(Recovery, "wage"), on(Wage, "id")),
	contained(on(Recovery, "recoveredBy"), on(Wage, "id")),
	capacity(on(Recovery, ["wage", "recoveredBy"]), {
		from: on(Recovery, ["wage", "recoveredBy"]),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),

	// Money out: exactly one arm per transfer, real paychecks, never more Roth
	// wired than withheld, after-tax within the election, and never zero.
	...alternatives(TransferByMercury, "kind", TransferKind, transferArms),
	contained(on(NetPay, "wage"), on(Wage, "id")),
	contained(on(RothDeferral, "wage"), on(Wage, "id")),
	capacity(on(Wage, "id"), {
		from: on(RothDeferral, "wage"),
		weight: weigh("amount"),
		within: within(0n, ref("roth"))
	}),
	contained(on(AfterTax, "year"), on(Election, "year")),
	capacity(on(Election, "year"), {
		from: on(AfterTax, "year"),
		weight: weigh("amount"),
		within: within(0n, ref("afterTax"))
	}),
	capacity(on(NetPay, "transfer"), { from: on(NetPay, "transfer"), weight: weigh("amount"), within: within(1n, "*") }),
	capacity(on(RothDeferral, "transfer"), {
		from: on(RothDeferral, "transfer"),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),
	capacity(on(AfterTax, "transfer"), {
		from: on(AfterTax, "transfer"),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),
	capacity(on(Distribution, "transfer"), {
		from: on(Distribution, "transfer"),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),

	// Tax payments: funded by exactly one Mercury debit, or made in history.
	contained(on(TaxPayment, "account"), on(TaxAccount, "id")),
	contained(on(TaxPayment, "kind"), on(PaymentKind, "id")),
	contained(on(TaxPayment, "funding"), on(Funding, "id")),
	mirrors(on(select(TaxPayment, { funding: "Mercury" }), "tracker"), on(TaxDebit, "payment")),
	contained(on(select(TaxPayment, { funding: "OutsideMercury" }), "initiatedOn"), on(History, "span")),
	capacity(on(TaxPayment, "tracker"), {
		from: on(TaxPayment, "tracker"),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),

	// Filings: filed only as the form allows, attested only in history, and
	// every line of the form exactly once.
	contained(on(Filing, "form"), on(Form, "id")),
	contained(on(Filing, "method"), on(Method, "id")),
	...filed.map((method) => mirrors(on(select(Filing, { method }), "id"), on(methodArms[method], "filing"))),
	contained(
		on(select(Filing, { method: "Electronic" }), "form"),
		on(select(Form, { electronic: true }), "id")
	),
	contained(
		on(select(Filing, { method: "CertifiedMail" }), "form"),
		on(select(Form, { certifiedMail: true }), "id")
	),
	contained(on(select(Filing, { method: "Furnished" }), "form"), on(select(Form, { furnished: true }), "id")),
	contained(on(select(Filing, { method: "Attested" }), "period"), on(History, "span")),
	contained(on(FiledFigures, "line"), on(Line, "id")),
	...Form.handles.map((form) =>
		capacity(on(select(Filing, { form }), "id"), {
			from: on(FiledFigures, "filing"),
			within: within(BigInt(formLines[form].length))
		})
	),
	...lineHandles.map((line) =>
		contained(on(select(FiledFigures, { line }), "filing"), on(select(Filing, { form: formOfLine[line] }), "id"))
	),

	// A 941-X corrects a 941 and restates every correctable line.
	contained(on(Correction, "filing"), on(select(Filing, { form: "F941" }), "id")),
	contained(on(CorrectedFigures, "filing"), on(Correction, "filing")),
	contained(on(CorrectedFigures, "line"), on(select(Line, { correctable: true }), "id")),
	capacity(on(Correction, "filing"), {
		from: on(CorrectedFigures, "filing"),
		within: within(BigInt(correctable.length))
	}),

	// Plan moves: what the plan reports, never more taxable or basis than gross.
	contained(on(PlanDistribution, "move"), on(PlanMove, "id")),
	capacity(on(PlanDistribution, ["year", "move"]), {
		from: on(PlanDistribution, ["year", "move"]),
		weight: weigh("gross"),
		within: within(1n, "*")
	}),
	capacity(on(PlanDistribution, ["year", "move"]), {
		from: on(PlanDistribution, ["year", "move"]),
		weight: weigh("taxable"),
		within: within(0n, ref("gross"))
	}),
	capacity(on(PlanDistribution, ["year", "move"]), {
		from: on(PlanDistribution, ["year", "move"]),
		weight: weigh("basis"),
		within: within(0n, ref("gross"))
	})
])
export default ledger
