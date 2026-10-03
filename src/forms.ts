import type { Fact, Uuid } from "@bjornpagen/bumbledb"
import { nearest, type Paycheck, paychecks, subjectTo } from "./check.ts"
import { formatDollars, formatPercent, PPM } from "./core/boundary.ts"
import { covers, months, type Span, sameSpan, yearOf } from "./core/time.ts"
import { max, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import { distributions } from "./plan.ts"
import {
	type AccountHandle,
	correctable,
	type FormHandle,
	formLines,
	type JurisdictionHandle,
	type LineHandle,
	type PlanAccountHandle,
	Tax,
	type TaxHandle,
	type TaxPayment
} from "./schema.ts"

/* Every line of every form the ledger files, computed from stored facts.
 * Every line has a value; a line that is not on the return is 0. Figures are
 * what `filing.record` stores and what `report` shows; nothing else computes
 * a form. */

type Unit = "Money" | "Count" | "Rate"
export type Period = {
	readonly facts: Facts
	readonly span: Span
	/** The paychecks paid in the span. */
	readonly checks: readonly Paycheck[]
}
type Line = {
	readonly unit: Unit
	readonly value: (period: Period) => bigint
	/** Computed from payments, which go on after a return is filed. */
	readonly paid?: true
}

export const periodOf = (facts: Facts, span: Span): Period => ({
	facts,
	span,
	checks: paychecks(facts).filter((check) => covers(span, check.wage.paidOn.start))
})

const total = (period: Period, of: (check: Paycheck) => bigint) => sum(period.checks.map(of))
const gross = (period: Period) => total(period, (check) => check.gross)
const roth = (period: Period) => total(period, (check) => check.roth)
const withheld = (period: Period, tax: TaxHandle) => total(period, (check) => check.withheld.get(tax) ?? 0n)
/** The part of the period's wages a tax applies to, and that part priced at
 * its rate in cents × ppm, exact until a line rounds it once. */
const subject = (period: Period, tax: TaxHandle) =>
	total(period, (check) => {
		const band = check.bands.find((row) => row.tax === tax)
		return band ? subjectTo(band.wages, check.ytd, check.gross) : 0n
	})
const weighted = (period: Period, tax: TaxHandle) =>
	total(period, (check) => {
		const band = check.bands.find((row) => row.tax === tax)
		return band ? subjectTo(band.wages, check.ytd, check.gross) * band.rate : 0n
	})
const stateWages = (period: Period, state: JurisdictionHandle) =>
	total(period, (check) => (check.state === state ? check.gross : 0n))
const rateOf = (facts: Facts, year: bigint, tax: TaxHandle) =>
	facts.TaxBand.find((band) => band.year === year && band.tax === tax)?.rate ?? 0n

/** Deposit and Balance payments toward an account's period; a Penalty never
 * counts toward tax. */
export const towardTax = (payment: Fact<typeof TaxPayment>) => payment.kind !== "Penalty"
export const paidToward = (facts: Facts, account: AccountHandle, span: Span) =>
	sum(
		facts.TaxPayment.filter(
			(payment) => payment.account === account && towardTax(payment) && sameSpan(payment.period, span)
		).map((payment) => payment.amount)
	)
const paid = (period: Period, account: AccountHandle) => paidToward(period.facts, account, period.span)

const employedOn = (period: Period, day: bigint | undefined, state?: JurisdictionHandle) =>
	day === undefined
		? 0n
		: BigInt(
				period.facts.Employment.filter(
					(employment) => covers(employment.span, day) && (state === undefined || employment.state === state)
				).length
			)
const twelfth = (period: Period, month: number) => {
	const span = months(period.span)[month]
	return span === undefined ? undefined : span.start + 11n
}

// ── 941 ─────────────────────────────────────────────────────────────────────

/** The 941's taxes borne by both sides: priced on the quarter's totals. */
const shared = Tax.handles.filter(
	(tax) => Tax.axioms[tax].account === "Federal941" && Tax.axioms[tax].employee && Tax.axioms[tax].employer
)
const ss941 = (period: Period) => nearest(2n * weighted(period, "SocialSecurity"), PPM)
const medicare941 = (period: Period) => nearest(2n * weighted(period, "Medicare"), PPM)
/** Line 7: what was withheld less the employee's share priced on the
 * quarter's totals, rounded once. */
const fractions941 = (period: Period) =>
	nearest(sum(shared.map((tax) => PPM * withheld(period, tax) - weighted(period, tax))), PPM)
const tax941 = (period: Period) =>
	withheld(period, "FIT") + ss941(period) + medicare941(period) + fractions941(period)
/** Line 16: each month is its paychecks' FIT plus both halves of FICA as
 * withheld; the last month with a paycheck absorbs the quarter's rounding so
 * the months sum to line 12. */
const months941 = (period: Period): bigint[] => {
	const spans = months(period.span)
	const ofCheck = (check: Paycheck) =>
		sum(
			Tax.handles
				.filter((tax) => Tax.axioms[tax].account === "Federal941")
				.map((tax) => (check.withheld.get(tax) ?? 0n) * (Tax.axioms[tax].employer ? 2n : 1n))
		)
	const paidIn = (span: Span) => period.checks.filter((check) => covers(span, check.wage.paidOn.start))
	const values = spans.map((span) => sum(paidIn(span).map(ofCheck)))
	const last = spans.findLastIndex((span) => paidIn(span).length > 0)
	if (last >= 0) values[last] = (values[last] ?? 0n) + tax941(period) - sum(values)
	return values
}

// ── 940 and the C-3 ─────────────────────────────────────────────────────────

/** FUTA is rounded once a year, and TWC rounds Texas UI once a quarter. */
const futa = (period: Period) => nearest(weighted(period, "FederalUnemployment"), PPM)
const sutaTax = (period: Period) => nearest(weighted(period, "TexasUnemployment"), PPM)

// ── W-2 and W-3 ─────────────────────────────────────────────────────────────

/** Social security withheld, less FICA the business advanced on a paycheck
 * that netted below zero and has not yet recovered. */
const ssWithheld = (period: Period) =>
	withheld(period, "SocialSecurity") - total(period, (check) => max(0n, -check.owedNet))
const wagesPaid = (period: Period) => (period.checks.length > 0 ? 1n : 0n)

// ── 1099-R and 1096 ─────────────────────────────────────────────────────────

const plan = (period: Period) => distributions(period.facts, BigInt(yearOf(period.span.start)))
const box = (account: PlanAccountHandle, field: "gross" | "taxable" | "basis") =>
	money((period) => plan(period).find((row) => row.account === account)?.[field] ?? 0n)

const money = (value: (period: Period) => bigint): Line => ({ unit: "Money", value })
const count = (value: (period: Period) => bigint): Line => ({ unit: "Count", value })
const payments = (value: (period: Period) => bigint): Line => ({ unit: "Money", value, paid: true })

export const lines: { readonly [L in LineHandle]: Line } = {
	F941_1: count((period) => employedOn(period, twelfth(period, 2))),
	F941_2: money(gross),
	F941_3: money((period) => withheld(period, "FIT")),
	F941_5a1: money((period) => subject(period, "SocialSecurity")),
	F941_5a2: money(ss941),
	F941_5c1: money((period) => subject(period, "Medicare")),
	F941_5c2: money(medicare941),
	F941_5e: money((period) => ss941(period) + medicare941(period)),
	F941_6: money((period) => withheld(period, "FIT") + ss941(period) + medicare941(period)),
	F941_7: money(fractions941),
	F941_10: money(tax941),
	F941_12: money(tax941),
	F941_13: payments((period) => paid(period, "Federal941")),
	F941_14: payments((period) => max(0n, tax941(period) - paid(period, "Federal941"))),
	F941_15: payments((period) => max(0n, paid(period, "Federal941") - tax941(period))),
	F941_16_1: money((period) => months941(period)[0] ?? 0n),
	F941_16_2: money((period) => months941(period)[1] ?? 0n),
	F941_16_3: money((period) => months941(period)[2] ?? 0n),
	F940_3: money(gross),
	F940_5: money((period) => gross(period) - subject(period, "FederalUnemployment")),
	F940_7: money((period) => subject(period, "FederalUnemployment")),
	F940_8: money(futa),
	F940_12: money(futa),
	F940_13: payments((period) => paid(period, "Federal940")),
	F940_14: payments((period) => max(0n, futa(period) - paid(period, "Federal940"))),
	F940_15: payments((period) => max(0n, paid(period, "Federal940") - futa(period))),
	W2_1: money(gross),
	W2_2: money((period) => withheld(period, "FIT")),
	W2_3: money((period) => subject(period, "SocialSecurity")),
	W2_4: money(ssWithheld),
	W2_5: money((period) => subject(period, "Medicare")),
	W2_6: money((period) => withheld(period, "Medicare")),
	W2_12AA: money(roth),
	W2_13: count(wagesPaid),
	W3_c: count(wagesPaid),
	W3_1: money(gross),
	W3_2: money((period) => withheld(period, "FIT")),
	W3_3: money((period) => subject(period, "SocialSecurity")),
	W3_4: money(ssWithheld),
	W3_5: money((period) => subject(period, "Medicare")),
	W3_6: money((period) => withheld(period, "Medicare")),
	W3_12a: money(roth),
	C3_employees_1: count((period) => employedOn(period, twelfth(period, 0), "TX")),
	C3_employees_2: count((period) => employedOn(period, twelfth(period, 1), "TX")),
	C3_employees_3: count((period) => employedOn(period, twelfth(period, 2), "TX")),
	C3_wages: money((period) => stateWages(period, "TX")),
	C3_taxable: money((period) => subject(period, "TexasUnemployment")),
	C3_rate: {
		unit: "Rate",
		value: (period) => rateOf(period.facts, BigInt(yearOf(period.span.start)), "TexasUnemployment")
	},
	C3_tax: money(sutaTax),
	F1099R_Pretax_G_1: box("Pretax", "gross"),
	F1099R_Pretax_G_2a: box("Pretax", "taxable"),
	F1099R_Pretax_G_5: box("Pretax", "basis"),
	F1099R_AfterTax_G_1: box("AfterTax", "gross"),
	F1099R_AfterTax_G_2a: box("AfterTax", "taxable"),
	F1099R_AfterTax_G_5: box("AfterTax", "basis"),
	F1099R_Roth_H_1: box("Roth", "gross"),
	F1099R_Roth_H_2a: box("Roth", "taxable"),
	F1099R_Roth_H_5: box("Roth", "basis"),
	F1096_3: count((period) => BigInt(plan(period).filter((row) => row.gross > 0n).length)),
	F1096_5: money((period) => sum(plan(period).map((row) => row.gross)))
}

/** Every line of a form for a period, in roster order. */
export const figures = (form: FormHandle, period: Period): ReadonlyMap<LineHandle, bigint> =>
	new Map(formLines[form].map((line) => [line, lines[line].value(period)] as const))

/** A line's value at the boundary: dollars, a percent for a rate, or a count. */
export const formatLine = (line: LineHandle, value: bigint): string | number =>
	lines[line].unit === "Money"
		? formatDollars(value)
		: lines[line].unit === "Rate"
			? formatPercent(value)
			: Number(value)

/** The 941 facts a quarter reports: wages, FIT and the taxable wages. A 941-X
 * is owed when they change; line 7 is rounding and follows from them. */
export const reported941 = correctable.filter((line) => line !== "F941_7")
/** Lines that depend on payments made after a return was filed. */
export const paymentLine = (line: LineHandle) => lines[line].paid === true

/** A 941-X: each correctable line as filed and as corrected, and column 4,
 * the tax each difference carries, rounded per line: taxable wages at both
 * shares of their tax, FIT and line 7 at face value, wages not at all. The
 * sum of column 4 is line 27, owed when positive. */
export const correction = (facts: Facts, filing: Uuid) => {
	const of = (rows: Facts["FiledFigures"]) =>
		new Map(rows.filter((row) => row.filing === filing).map((row) => [row.line, row.value] as const))
	const original = of(facts.FiledFigures)
	const corrected = of(facts.CorrectedFigures)
	const period = facts.Filing.find((row) => row.id === filing)?.period
	const year = period === undefined ? 0n : BigInt(yearOf(period.start))
	const rate: { readonly [L in (typeof correctable)[number]]: bigint } = {
		F941_2: 0n,
		F941_3: PPM,
		F941_5a1: 2n * rateOf(facts, year, "SocialSecurity"),
		F941_5c1: 2n * rateOf(facts, year, "Medicare"),
		F941_7: PPM
	}
	const rows = correctable.map((line) => {
		const difference = (corrected.get(line) ?? 0n) - (original.get(line) ?? 0n)
		return {
			line,
			original: original.get(line) ?? 0n,
			corrected: corrected.get(line) ?? 0n,
			difference,
			tax: nearest(difference * rate[line], PPM)
		}
	})
	return { rows, owed: sum(rows.map((row) => row.tax)) }
}
