import {
	alternatives,
	bool,
	capacity,
	closed,
	closedId,
	contained,
	duration,
	i64,
	interval,
	key,
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
import { quarterSpan, yearSpan } from "./core/time.ts"

/* Representation first. Every fact is stored once; every invariant is a law.
 * Money is u64 cents, a day is an i64 Unix epoch day, a period is a half-open
 * day interval, and a rate is u64 basis points over 10,000. The ledger is one
 * business with one employee (the owner), so no row names either of them. */

// ── Rosters: closed vocabularies and the ground facts they carry ──────────

export const TransferKind = closed("TransferKind", [
	"NetPay",
	"RothDeferral",
	"AfterTax",
	"Distribution",
	"Tax"
])
export const Processor = closed("Processor", ["EFTPS", "TWC"])
export const TaxAccount = closed(
	"TaxAccount",
	["Federal941", "Federal940", "TexasUI"],
	{ processor: closedId(Processor) },
	{ Federal941: { processor: "EFTPS" }, Federal940: { processor: "EFTPS" }, TexasUI: { processor: "TWC" } }
)
/** Deposit and Balance pay the period's tax; a Penalty never does. */
export const PaymentKind = closed("PaymentKind", ["Deposit", "Balance", "Penalty"])
export const Funding = closed("Funding", ["Mercury", "OutsideMercury"])
export const Method = closed("Method", ["Electronic", "CertifiedMail", "Furnished", "Prior"])

const allows = (electronic: boolean, certifiedMail: boolean, furnished: boolean) => ({
	electronic,
	certifiedMail,
	furnished
})
/** How each form may be filed. Prior (pre-ledger history) is allowed for every
 * form but capped by `LegacyFiling`. A 941-X is a `Correction`, not a form. */
export const Form = closed(
	"Form",
	["F941", "F940", "W2", "W3", "C3", "F1099R", "F1096"],
	{ electronic: bool, certifiedMail: bool, furnished: bool },
	{
		F941: allows(false, true, false),
		F940: allows(false, true, false),
		W2: allows(false, false, true),
		W3: allows(true, true, false),
		C3: allows(true, false, false),
		F1099R: allows(false, false, true),
		F1096: allows(false, true, false)
	}
)

/** Every line the ledger files, by form. `src/forms.ts` computes each one. */
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
		"F1099R_Pretax_H_1",
		"F1099R_Pretax_H_2a",
		"F1099R_AfterTax_G_1",
		"F1099R_AfterTax_G_2a",
		"F1099R_AfterTax_G_5",
		"F1099R_AfterTax_H_1",
		"F1099R_AfterTax_H_2a",
		"F1099R_Roth_G_1",
		"F1099R_Roth_G_2a",
		"F1099R_Roth_H_1",
		"F1099R_Roth_H_2a"
	],
	F1096: ["F1096_3", "F1096_5"]
} as const
export type FormHandle = (typeof Form.handles)[number]
export type LineHandle = (typeof formLines)[FormHandle][number]
const lineHandles = [
	...formLines.F941,
	...formLines.F940,
	...formLines.W2,
	...formLines.W3,
	...formLines.C3,
	...formLines.F1099R,
	...formLines.F1096
] as const
export const Line = closed(
	"Line",
	lineHandles,
	{ form: closedId(Form) },
	Object.fromEntries(
		Object.entries(formLines).flatMap(([form, lines]) => lines.map((line) => [line, { form }]))
	) as { readonly [L in LineHandle]: { readonly form: FormHandle } }
)

/** The 15 filings made before the ledger recorded how. Import-only. */
export const LegacyFiling = closed(
	"LegacyFiling",
	[
		"F941_2025Q2",
		"F941_2025Q3",
		"F941_2025Q4",
		"F941_2026Q1",
		"F941_2026Q2",
		"C3_2025Q2",
		"C3_2025Q3",
		"C3_2025Q4",
		"C3_2026Q1",
		"C3_2026Q2",
		"F940_2025",
		"W2_2025",
		"W3_2025",
		"F1099R_2025",
		"F1096_2025"
	],
	{ form: closedId(Form), period: interval(i64) },
	{
		F941_2025Q2: { form: "F941", period: quarterSpan(2025, 2) },
		F941_2025Q3: { form: "F941", period: quarterSpan(2025, 3) },
		F941_2025Q4: { form: "F941", period: quarterSpan(2025, 4) },
		F941_2026Q1: { form: "F941", period: quarterSpan(2026, 1) },
		F941_2026Q2: { form: "F941", period: quarterSpan(2026, 2) },
		C3_2025Q2: { form: "C3", period: quarterSpan(2025, 2) },
		C3_2025Q3: { form: "C3", period: quarterSpan(2025, 3) },
		C3_2025Q4: { form: "C3", period: quarterSpan(2025, 4) },
		C3_2026Q1: { form: "C3", period: quarterSpan(2026, 1) },
		C3_2026Q2: { form: "C3", period: quarterSpan(2026, 2) },
		F940_2025: { form: "F940", period: yearSpan(2025) },
		W2_2025: { form: "W2", period: yearSpan(2025) },
		W3_2025: { form: "W3", period: yearSpan(2025) },
		F1099R_2025: { form: "F1099R", period: yearSpan(2025) },
		F1096_2025: { form: "F1096", period: yearSpan(2025) }
	}
)
/** The two TWC payments made outside Mercury. Import-only. */
export const LegacyTwcPayment = closed("LegacyTwcPayment", ["TWC_37834317", "TWC_39613546"])
export const PlanAccount = closed("PlanAccount", ["Pretax", "AfterTax", "Roth"])
/** Form 1099-R box 7: G direct rollover or conversion, H Roth to Roth IRA. */
export const DistributionCode = closed("DistributionCode", ["G", "H"])
/** The Carry-side moves a 1099-R can report. The after-tax conversion
 * (AfterTax, G) is implied by AfterTax transfers, so it is not a move. */
export const PlanMove = closed(
	"PlanMove",
	["Pretax_G", "Pretax_H", "AfterTax_H", "Roth_G", "Roth_H"],
	{ account: closedId(PlanAccount), code: closedId(DistributionCode) },
	{
		Pretax_G: { account: "Pretax", code: "G" },
		Pretax_H: { account: "Pretax", code: "H" },
		AfterTax_H: { account: "AfterTax", code: "H" },
		Roth_G: { account: "Roth", code: "G" },
		Roth_H: { account: "Roth", code: "H" }
	}
)

// ── Relations ──────────────────────────────────────────────────────────────

export const Business = relation("Business", { ein: str, name: str, twcAccount: str })
export const Employee = relation("Employee", { ssn: str, firstName: str, lastName: str, address: str })
/** Drives 941 line 1 and the C-3 "12th of the month" counts. */
export const Employment = relation("Employment", { span: interval(i64) })
export const TaxYear = relation("TaxYear", {
	year: i64,
	span: interval(i64),
	ssRate: u64,
	ssBase: u64,
	medicareRate: u64,
	futaRate: u64,
	futaBase: u64,
	sutaRate: u64,
	sutaBase: u64,
	deferralLimit: u64,
	additionsLimit: u64,
	compensationLimit: u64,
	wageCeiling: u64
})
export const PayPlan = relation("PayPlan", { year: i64, salary: u64, fitPerCheck: u64 })
/** The signed Carry election for a year: employee Roth and voluntary after-tax. */
export const Election = relation("Election", { year: i64, roth: u64, afterTax: u64, signedOn: i64 })
/** One paycheck per day. `earnings` is its coordinate on the year's wage axis,
 * [ytd, ytd + gross): gross is its width. The amounts are the paycheck as
 * assessed; the employer's FICA match equals `ss` and `medicare`. */
export const Wage = relation("Wage", {
	id: uuid,
	paidOn: interval(i64, 1n),
	year: i64,
	earnings: interval(u64),
	fit: u64,
	ss: u64,
	medicare: u64,
	roth: u64
})
/** Net pay overpaid on `wage`, withheld back from `recoveredBy`'s net. */
export const Recovery = relation("Recovery", { wage: uuid, recoveredBy: uuid, amount: u64 })

/** Every movement out of Mercury, keyed by its Mercury Tracking ID. Exactly one
 * arm says what it was and holds what Mercury sent. */
export const Transfer = relation("Transfer", { mercury: str, sentOn: i64, kind: closedId(TransferKind) })
export const NetPay = relation("NetPay", { transfer: str, wage: uuid, amount: u64 })
/** Wired to Carry Roth (QCRH000004). */
export const RothDeferral = relation("RothDeferral", { transfer: str, wage: uuid, amount: u64 })
/** The mega backdoor: wired to Carry after-tax (QCEP000007), an S-corp
 * distribution, converted in-plan. `year` is Carry's contribution year. */
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
	initiatedOn: i64,
	funding: closedId(Funding)
})
export const OutsideMercury = relation("OutsideMercury", { payment: str, legacy: closedId(LegacyTwcPayment) })

export const Filing = relation("Filing", {
	id: uuid,
	form: closedId(Form),
	period: interval(i64),
	method: closedId(Method)
})
export const Electronic = relation("Electronic", { filing: uuid, on: i64, confirmation: str })
export const CertifiedMail = relation("CertifiedMail", { filing: uuid, mailedOn: i64, tracking: str })
export const Furnished = relation("Furnished", { filing: uuid, on: i64 })
export const Prior = relation("Prior", { filing: uuid, legacy: closedId(LegacyFiling) })
/** Every line of a return exactly as filed. */
export const FiledFigures = relation("FiledFigures", { filing: uuid, line: closedId(Line), value: i64 })
/** A 941-X: the correction of a filed 941, mailed certified. */
export const Correction = relation("Correction", { filing: uuid, mailedOn: i64, tracking: str })
/** The corrected 941 lines. Originals are the 941's figures; differences are computed. */
export const CorrectedFigures = relation("CorrectedFigures", {
	filing: uuid,
	line: closedId(Line),
	value: i64
})
/** Carry-side moves that need a 1099-R: rollovers and conversions. */
export const PlanDistribution = relation("PlanDistribution", {
	year: i64,
	move: closedId(PlanMove),
	gross: u64,
	taxable: u64
})

export const relations = {
	TransferKind,
	Processor,
	TaxAccount,
	PaymentKind,
	Funding,
	Method,
	Form,
	Line,
	LegacyFiling,
	LegacyTwcPayment,
	PlanAccount,
	DistributionCode,
	PlanMove,
	Business,
	Employee,
	Employment,
	TaxYear,
	PayPlan,
	Election,
	Wage,
	Recovery,
	Transfer,
	NetPay,
	RothDeferral,
	AfterTax,
	Distribution,
	TaxDebit,
	TaxPayment,
	OutsideMercury,
	Filing,
	Electronic,
	CertifiedMail,
	Furnished,
	Prior,
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
const fundingArms = { Mercury: key(TaxDebit, ["payment"]), OutsideMercury: key(OutsideMercury, ["payment"]) }
const methodArms = {
	Electronic: key(Electronic, ["filing"]),
	CertifiedMail: key(CertifiedMail, ["filing"]),
	Furnished: key(Furnished, ["filing"]),
	Prior: key(Prior, ["filing"])
}
const filed = ["Electronic", "CertifiedMail", "Furnished"] as const

export const ledger = schema("WagieTools", relations, [
	// Identity: natural keys; intervals keyed pointwise never overlap.
	key(Business, ["ein"]),
	key(Employee, ["ssn"]),
	key(Employment, ["span"]),
	key(TaxYear, ["year"]),
	key(TaxYear, ["year", "span"]),
	key(PayPlan, ["year"]),
	key(Election, ["year"]),
	WageById,
	WageByDay,
	key(Wage, ["year", "earnings"]),
	key(Recovery, ["wage", "recoveredBy"]),
	TransferByMercury,
	PaymentByTracker,
	FilingById,
	FilingByPeriod,
	...Object.values(transferArms),
	...Object.values(fundingArms),
	...Object.values(methodArms),
	key(CertifiedMail, ["tracking"]),
	key(Prior, ["legacy"]),
	key(OutsideMercury, ["legacy"]),
	key(FiledFigures, ["filing", "line"]),
	key(Correction, ["filing"]),
	key(Correction, ["tracking"]),
	key(CorrectedFigures, ["filing", "line"]),
	key(PlanDistribution, ["year", "move"]),

	// Sum types: exactly one arm per transfer, payment and filing.
	...alternatives(TransferByMercury, "kind", TransferKind, transferArms),
	...alternatives(PaymentByTracker, "funding", Funding, fundingArms),
	...alternatives(FilingById, "method", Method, methodArms),
	contained(on(TaxAccount, "processor"), on(Processor, "id")),
	contained(on(Line, "form"), on(Form, "id")),
	contained(on(LegacyFiling, "form"), on(Form, "id")),
	contained(on(TaxPayment, "account"), on(TaxAccount, "id")),
	contained(on(TaxPayment, "kind"), on(PaymentKind, "id")),
	contained(on(Filing, "form"), on(Form, "id")),
	contained(on(Prior, "legacy"), on(LegacyFiling, "id")),
	contained(on(OutsideMercury, "legacy"), on(LegacyTwcPayment, "id")),
	contained(on(FiledFigures, "line"), on(Line, "id")),
	contained(on(CorrectedFigures, "line"), on(Line, "id")),
	contained(on(PlanMove, "account"), on(PlanAccount, "id")),
	contained(on(PlanMove, "code"), on(DistributionCode, "id")),
	contained(on(PlanDistribution, "move"), on(PlanMove, "id")),

	// A wage is paid during employment, in its tax year, under a signed election.
	contained(on(Wage, "paidOn"), on(Employment, "span")),
	contained(on(Wage, ["year", "paidOn"]), on(TaxYear, ["year", "span"])),
	contained(on(Wage, "year"), on(Election, "year")),
	contained(on(PayPlan, "year"), on(TaxYear, "year")),
	contained(on(Election, "year"), on(TaxYear, "year")),
	contained(on(AfterTax, "year"), on(Election, "year")),

	// Limits. Roth + after-tax ≤ 415(c) spans two columns; election.set and year.set check it.
	capacity(on(Election, "year"), {
		from: on(Wage, "year"),
		weight: weigh("roth"),
		within: within(0n, ref("roth"))
	}),
	capacity(on(Election, "year"), {
		from: on(AfterTax, "year"),
		weight: weigh("amount"),
		within: within(0n, ref("afterTax"))
	}),
	capacity(on(TaxYear, "year"), {
		from: on(Election, "year"),
		weight: weigh("roth"),
		within: within(0n, ref("deferralLimit"))
	}),
	capacity(on(TaxYear, "year"), {
		from: on(Wage, "year"),
		weight: weigh(duration("earnings")),
		within: within(0n, ref("wageCeiling"))
	}),

	// Money out pays real paychecks, never more Roth than withheld, and never zero.
	contained(on(NetPay, "wage"), on(Wage, "id")),
	contained(on(RothDeferral, "wage"), on(Wage, "id")),
	capacity(on(Wage, "id"), {
		from: on(RothDeferral, "wage"),
		weight: weigh("amount"),
		within: within(0n, ref("roth"))
	}),
	contained(on(Recovery, "wage"), on(Wage, "id")),
	contained(on(Recovery, "recoveredBy"), on(Wage, "id")),
	capacity(on(NetPay, "transfer"), {
		from: on(NetPay, "transfer"),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),
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
	capacity(on(TaxPayment, "tracker"), {
		from: on(TaxPayment, "tracker"),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),
	capacity(on(Recovery, ["wage", "recoveredBy"]), {
		from: on(Recovery, ["wage", "recoveredBy"]),
		weight: weigh("amount"),
		within: within(1n, "*")
	}),

	// Filings: allowed methods, every line as filed, and corrections only of a 941.
	contained(
		on(select(Filing, { method: "Electronic" }), "form"),
		on(select(Form, { electronic: true }), "id")
	),
	contained(
		on(select(Filing, { method: "CertifiedMail" }), "form"),
		on(select(Form, { certifiedMail: true }), "id")
	),
	contained(on(select(Filing, { method: "Furnished" }), "form"), on(select(Form, { furnished: true }), "id")),
	...filed.map((method) =>
		capacity(on(select(Filing, { method }), "id"), {
			from: on(FiledFigures, "filing"),
			within: within(1n, "*")
		})
	),
	capacity(on(select(Filing, { method: "Prior" }), "id"), {
		from: on(FiledFigures, "filing"),
		within: within(0n)
	}),
	contained(on(FiledFigures, "filing"), on(Filing, "id")),
	contained(on(Correction, "filing"), on(select(Filing, { form: "F941" }), "id")),
	contained(on(CorrectedFigures, "filing"), on(Correction, "filing")),
	capacity(on(Correction, "filing"), { from: on(CorrectedFigures, "filing"), within: within(1n, "*") }),
	contained(on(CorrectedFigures, "line"), on(select(Line, { form: "F941" }), "id"))
])
export default ledger
