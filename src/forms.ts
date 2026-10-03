import type { Fact } from "@bjornpagen/bumbledb"
import { grossOf, nearest, paychecks, type Rules, under } from "./check.ts"
import { formatDollars } from "./core/boundary.ts"
import { covers, months, type Span, sameSpan, yearOf } from "./core/time.ts"
import { max, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import {
	type FormHandle,
	formLines,
	type LineHandle,
	type PlanMove,
	type TaxAccount,
	type Wage
} from "./schema.ts"

/* Every line of every form the ledger files, computed from stored facts. A
 * line is undefined when it is not on the return (a 1099-R move with no
 * distribution). Figures are what `filing.record` stores and what `report`
 * shows; nothing else computes a form. */

type Unit = "Money" | "Count" | "Rate"
export type Period = {
	readonly facts: Facts
	readonly span: Span
	readonly wages: readonly Fact<typeof Wage>[]
	readonly rules: (wage: Fact<typeof Wage>) => Rules
}
type Line = { readonly unit: Unit; readonly value: (period: Period) => bigint | undefined }

const total = (period: Period, of: (wage: Fact<typeof Wage>) => bigint) => sum(period.wages.map(of))
const gross = (period: Period) => total(period, grossOf)
const ssWages = (period: Period) => total(period, (wage) => under(wage.earnings, period.rules(wage).ssBase))
const futaWages = (period: Period) =>
	total(period, (wage) => under(wage.earnings, period.rules(wage).futaBase))
const sutaWages = (period: Period) =>
	total(period, (wage) => under(wage.earnings, period.rules(wage).sutaBase))
/** A period's rate is its year's; a quarter with no wages has no tax to price. */
const rate = (period: Period, of: (rules: Rules) => bigint) => {
	const wage = period.wages[0]
	return wage === undefined ? 0n : of(period.rules(wage))
}
/** What the 941 owes for wages paid in a span: FIT plus both halves of FICA. */
export const liability = (wages: readonly Fact<typeof Wage>[]) =>
	sum(wages.map((wage) => wage.fit + 2n * wage.ss + 2n * wage.medicare))
/** Deposit and Balance payments toward an account's period; a Penalty never
 * counts toward tax. */
export const paidToward = (facts: Facts, account: (typeof TaxAccount.handles)[number], span: Span) =>
	sum(
		facts.TaxPayment.filter(
			(payment) => payment.account === account && payment.kind !== "Penalty" && sameSpan(payment.period, span)
		).map((payment) => payment.amount)
	)
const paid = (period: Period, account: (typeof TaxAccount.handles)[number]) =>
	paidToward(period.facts, account, period.span)
/** Social security withheld: the paychecks' ss, less FICA the business
 * advanced on a paycheck that netted below zero and has not yet recovered. */
const ssWithheld = (period: Period) => {
	const ids = new Set(period.wages.map((wage) => wage.id))
	const advanced = paychecks(period.facts)
		.filter((check) => ids.has(check.wage.id))
		.map((check) => max(0n, -check.owedNet))
	return total(period, (wage) => wage.ss) - sum(advanced)
}
const employedOn = (period: Period, day: bigint) =>
	BigInt(period.facts.Employment.filter((employment) => covers(employment.span, day)).length)
const twelfth = (period: Period, month: number) => {
	const span = months(period.span)[month]
	return span === undefined ? 0n : span.start + 11n
}
const ss941 = (period: Period) =>
	nearest(ssWages(period) * rate(period, (rules) => 2n * rules.ssRate), 10_000n)
const medicare941 = (period: Period) =>
	nearest(gross(period) * rate(period, (rules) => 2n * rules.medicareRate), 10_000n)
const tax941 = (period: Period) => liability(period.wages)
export const futaTax = (period: Period) =>
	nearest(futaWages(period) * rate(period, (rules) => rules.futaRate), 10_000n)
const afterTaxOf = (period: Period) =>
	sum(
		period.facts.AfterTax.filter((row) => row.year === BigInt(yearOf(period.span.start))).map(
			(row) => row.amount
		)
	)
const move = (period: Period, name: (typeof PlanMove.handles)[number]) =>
	period.facts.PlanDistribution.find(
		(row) => row.move === name && row.year === BigInt(yearOf(period.span.start))
	)
const moves = ["Pretax_G", "Pretax_H", "AfterTax_H", "Roth_G", "Roth_H"] as const
const forms1099R = (period: Period) =>
	BigInt(moves.filter((name) => move(period, name) !== undefined).length + (afterTaxOf(period) > 0n ? 1 : 0))
const gross1099R = (period: Period) =>
	sum(moves.map((name) => move(period, name)?.gross ?? 0n)) + afterTaxOf(period)

const money = (value: (period: Period) => bigint | undefined): Line => ({ unit: "Money", value })
const count = (value: (period: Period) => bigint | undefined): Line => ({ unit: "Count", value })
const reported = (name: (typeof moves)[number], field: "gross" | "taxable") =>
	money((period) => move(period, name)?.[field])
const afterTax = (value: (total: bigint) => bigint) =>
	money((period) => (afterTaxOf(period) > 0n ? value(afterTaxOf(period)) : undefined))

export const lines: { readonly [L in LineHandle]: Line } = {
	F941_1: count((period) => employedOn(period, twelfth(period, 2))),
	F941_2: money(gross),
	F941_3: money((period) => total(period, (wage) => wage.fit)),
	F941_5a1: money(ssWages),
	F941_5a2: money(ss941),
	F941_5c1: money(gross),
	F941_5c2: money(medicare941),
	F941_5e: money((period) => ss941(period) + medicare941(period)),
	F941_6: money((period) => total(period, (wage) => wage.fit) + ss941(period) + medicare941(period)),
	F941_7: money(
		(period) =>
			total(period, (wage) => 2n * wage.ss + 2n * wage.medicare) - ss941(period) - medicare941(period)
	),
	F941_10: money(tax941),
	F941_12: money(tax941),
	F941_13: money((period) => paid(period, "Federal941")),
	F941_14: money((period) => max(0n, tax941(period) - paid(period, "Federal941"))),
	F941_15: money((period) => max(0n, paid(period, "Federal941") - tax941(period))),
	F941_16_1: money((period) => monthLiability(period, 0)),
	F941_16_2: money((period) => monthLiability(period, 1)),
	F941_16_3: money((period) => monthLiability(period, 2)),
	F940_3: money(gross),
	F940_5: money((period) => gross(period) - futaWages(period)),
	F940_7: money(futaWages),
	F940_8: money(futaTax),
	F940_12: money(futaTax),
	F940_13: money((period) => paid(period, "Federal940")),
	F940_14: money((period) => max(0n, futaTax(period) - paid(period, "Federal940"))),
	F940_15: money((period) => max(0n, paid(period, "Federal940") - futaTax(period))),
	W2_1: money(gross),
	W2_2: money((period) => total(period, (wage) => wage.fit)),
	W2_3: money(ssWages),
	W2_4: money(ssWithheld),
	W2_5: money(gross),
	W2_6: money((period) => total(period, (wage) => wage.medicare)),
	W2_12AA: money((period) => total(period, (wage) => wage.roth)),
	W2_13: count(() => 1n),
	W3_c: count((period) => (period.wages.length > 0 ? 1n : 0n)),
	W3_1: money(gross),
	W3_2: money((period) => total(period, (wage) => wage.fit)),
	W3_3: money(ssWages),
	W3_4: money(ssWithheld),
	W3_5: money(gross),
	W3_6: money((period) => total(period, (wage) => wage.medicare)),
	W3_12a: money((period) => total(period, (wage) => wage.roth)),
	C3_employees_1: count((period) => employedOn(period, twelfth(period, 0))),
	C3_employees_2: count((period) => employedOn(period, twelfth(period, 1))),
	C3_employees_3: count((period) => employedOn(period, twelfth(period, 2))),
	C3_wages: money(gross),
	C3_taxable: money(sutaWages),
	C3_rate: { unit: "Rate", value: (period) => rate(period, (rules) => rules.sutaRate) },
	C3_tax: money((period) => sutaTax(period)),
	F1099R_Pretax_G_1: reported("Pretax_G", "gross"),
	F1099R_Pretax_G_2a: reported("Pretax_G", "taxable"),
	F1099R_Pretax_H_1: reported("Pretax_H", "gross"),
	F1099R_Pretax_H_2a: reported("Pretax_H", "taxable"),
	F1099R_AfterTax_G_1: afterTax((total) => total),
	F1099R_AfterTax_G_2a: afterTax(() => 0n),
	F1099R_AfterTax_G_5: afterTax((total) => total),
	F1099R_AfterTax_H_1: reported("AfterTax_H", "gross"),
	F1099R_AfterTax_H_2a: reported("AfterTax_H", "taxable"),
	F1099R_Roth_G_1: reported("Roth_G", "gross"),
	F1099R_Roth_G_2a: reported("Roth_G", "taxable"),
	F1099R_Roth_H_1: reported("Roth_H", "gross"),
	F1099R_Roth_H_2a: reported("Roth_H", "taxable"),
	F1096_3: count(forms1099R),
	F1096_5: money(gross1099R)
}

function monthLiability(period: Period, month: number) {
	const span = months(period.span)[month]
	return span === undefined ? 0n : liability(period.wages.filter((wage) => covers(span, wage.paidOn.start)))
}
/** TWC computes the tax on the quarter's taxable wages, rounded once. */
export function sutaTax(period: Period) {
	return nearest(sutaWages(period) * rate(period, (rules) => rules.sutaRate), 10_000n)
}

/** The lines a 941-X corrects; the 941-X obligation compares only these. */
export const correctable = [
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
	"F941_12"
] as const satisfies readonly LineHandle[]

export const periodOf = (facts: Facts, span: Span): Period => ({
	facts,
	span,
	wages: facts.Wage.filter((wage) => covers(span, wage.paidOn.start)),
	rules: (wage) => {
		const rules = facts.TaxYear.find((row) => row.year === wage.year)
		if (!rules) throw new Error(`No TaxYear ${wage.year}`)
		return rules
	}
})

/** Every line of a form for a period, in roster order. */
export const figures = (form: FormHandle, period: Period): ReadonlyMap<LineHandle, bigint> =>
	new Map(
		formLines[form].flatMap((line) => {
			const value = lines[line].value(period)
			return value === undefined ? [] : [[line, value] as const]
		})
	)

/** A line's value at the boundary: dollars, or a plain number for counts and rates. */
export const formatLine = (line: LineHandle, value: bigint): string | number =>
	lines[line].unit === "Money" ? formatDollars(value) : Number(value)
