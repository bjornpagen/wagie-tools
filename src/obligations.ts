import type { Fact } from "@bjornpagen/bumbledb"
import { nextBusinessDay } from "./calendar.ts"
import { grossOf, paychecks } from "./check.ts"
import {
	civil,
	covers,
	dayOf,
	monthOf,
	months,
	quarterOf,
	type Span,
	sameSpan,
	yearOf,
	yearSpan
} from "./core/time.ts"
import { max, min, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import {
	correctable,
	figures,
	formatLine,
	futaTax,
	liability,
	paidToward,
	periodOf,
	sutaTax
} from "./forms.ts"
import type { FormHandle, LineHandle, TaxAccount, Wage } from "./schema.ts"

/* Control flow as data: what is owed, when it opens, when it is due, and the
 * op that clears it. Payroll is blocked while anything here is open. */

export type Obligation = {
	readonly what: string
	readonly next: string
	readonly opensOn: bigint
	readonly dueOn?: bigint
	readonly amount?: bigint
	readonly period?: Span
	readonly paidOn?: bigint
}

type Account = (typeof TaxAccount.handles)[number]
const followingMonthEnd = (end: bigint) => nextBusinessDay(monthOf(end).end - 1n)
const fifteenthAfter = (end: bigint) => {
	const { year, month } = civil(end)
	return nextBusinessDay(dayOf(year, month, 15))
}
const januaryAfter = (year: number, day: number) => nextBusinessDay(dayOf(year + 1, 1, day))
const filed = (facts: Facts, form: FormHandle, period: Span) =>
	facts.Filing.some((row) => row.form === form && sameSpan(row.period, period))
const unique = <A>(values: readonly A[], key: (value: A) => string) => [
	...new Map(values.map((value) => [key(value), value])).values()
]

/** Quarters with wages, and quarters intersecting employment up to asOf. */
const quartersOf = (wages: readonly Fact<typeof Wage>[]) =>
	unique(
		wages.map((wage) => quarterOf(wage.paidOn.start)),
		(span) => String(span.start)
	)
const employedQuarters = (facts: Facts, asOf: bigint) =>
	unique(
		facts.Employment.flatMap((employment) => {
			const quarters: Span[] = []
			for (
				let quarter = quarterOf(employment.span.start);
				quarter.start <= asOf && quarter.start < employment.span.end;
				quarter = quarterOf(quarter.end)
			)
				quarters.push(quarter)
			return quarters
		}),
		(span) => String(span.start)
	).sort((a, b) => (a.start < b.start ? -1 : 1))

export type Credit = { readonly account: Account; readonly period: Span; readonly credit: bigint }

export const obligations = (facts: Facts, asOf: bigint) => {
	const open: Obligation[] = []
	const credits: Credit[] = []
	const owe = (account: Account, period: Span, tax: bigint, obligation: Omit<Obligation, "amount">) => {
		const paid = paidToward(facts, account, period)
		if (tax > paid) open.push({ ...obligation, amount: tax - paid })
		if (paid > tax) credits.push({ account, period, credit: paid - tax })
	}

	for (const check of paychecks(facts)) {
		const paidOn = check.wage.paidOn.start
		if (check.sentNet < check.owedNet)
			open.push({
				what: "Send net pay",
				next: "transfer.record",
				paidOn,
				opensOn: paidOn,
				dueOn: paidOn,
				amount: check.owedNet - check.sentNet
			})
		if (check.sentRoth < check.wage.roth)
			open.push({
				what: "Send Roth to Carry",
				next: "transfer.record",
				paidOn,
				opensOn: paidOn,
				dueOn: paidOn,
				amount: check.wage.roth - check.sentRoth
			})
	}

	for (const quarter of quartersOf(facts.Wage)) {
		// 941 deposits: the quarter's Deposit and Balance payments, first in first out.
		let left = paidToward(facts, "Federal941", quarter)
		for (const month of months(quarter)) {
			const owed = liability(facts.Wage.filter((wage) => covers(month, wage.paidOn.start)))
			const covered = min(owed, left)
			left -= covered
			if (owed > covered)
				open.push({
					what: "941 deposit",
					next: "tax.paid",
					period: month,
					amount: owed - covered,
					opensOn: month.end,
					dueOn: fifteenthAfter(month.end)
				})
		}
		if (left > 0n) credits.push({ account: "Federal941", period: quarter, credit: left })
		owe("TexasUI", quarter, sutaTax(periodOf(facts, quarter)), {
			what: "Texas UI tax",
			next: "tax.paid",
			period: quarter,
			opensOn: quarter.end,
			dueOn: followingMonthEnd(quarter.end)
		})
	}

	for (const year of unique(
		facts.Wage.map((wage) => Number(wage.year)),
		String
	)) {
		const span = yearSpan(year)
		owe("Federal940", span, futaTax(periodOf(facts, span)), {
			what: "FUTA tax",
			next: "tax.paid",
			period: span,
			opensOn: span.end,
			dueOn: januaryAfter(year, 31)
		})
	}

	const file = (form: FormHandle, period: Span, opensOn: bigint, dueOn: bigint) => {
		if (!filed(facts, form, period))
			open.push({ what: `File ${form}`, next: "filing.record", period, opensOn, dueOn })
	}
	for (const quarter of employedQuarters(facts, asOf))
		for (const form of ["F941", "C3"] as const)
			file(form, quarter, quarter.end, followingMonthEnd(quarter.end))
	for (const year of unique(
		facts.Wage.map((wage) => Number(wage.year)),
		String
	))
		for (const form of ["F940", "W2", "W3"] as const)
			file(form, yearSpan(year), yearSpan(year).end, januaryAfter(year, 31))
	const planYears = unique(
		[...facts.AfterTax, ...facts.PlanDistribution].map((row) => Number(row.year)),
		String
	)
	for (const year of planYears) {
		file("F1099R", yearSpan(year), yearSpan(year).end, januaryAfter(year, 31))
		file("F1096", yearSpan(year), yearSpan(year).end, nextBusinessDay(dayOf(year + 1, 2, 28)))
	}

	// A filed 941 (or its 941-X) that no longer matches the ledger needs a 941-X.
	for (const filing of facts.Filing.filter((row) => row.form === "F941")) {
		const corrected = facts.Correction.some((row) => row.filing === filing.id)
		const recorded = (corrected ? facts.CorrectedFigures : facts.FiledFigures).filter(
			(row) => row.filing === filing.id
		)
		const current = figures("F941", periodOf(facts, filing.period))
		const stale = recorded.some(
			(row) =>
				(correctable as readonly LineHandle[]).includes(row.line) &&
				row.value !== (current.get(row.line) ?? 0n)
		)
		if (stale)
			open.push({
				what: corrected ? "File a second 941-X (extend Correction's key first)" : "File a 941-X",
				next: "filing.amend",
				period: filing.period,
				opensOn: filing.period.end
			})
	}

	open.sort((a, b) => (a.opensOn < b.opensOn ? -1 : a.opensOn > b.opensOn ? 1 : 0))
	return { open, credits, blockers: open.filter((item) => item.opensOn <= asOf) }
}

/** Filed figures that no longer match the ledger, for forms other than the 941. */
export const mismatches = (facts: Facts) =>
	facts.Filing.filter((row) => row.form !== "F941").flatMap((filing) => {
		const current = figures(filing.form, periodOf(facts, filing.period))
		return facts.FiledFigures.filter(
			(row) => row.filing === filing.id && row.value !== (current.get(row.line) ?? 0n)
		).map((row) => ({
			form: filing.form,
			period: filing.period,
			line: row.line,
			filed: formatLine(row.line, row.value),
			now: formatLine(row.line, current.get(row.line) ?? 0n)
		}))
	})

/** Non-blocking lines for the year of asOf. */
export const notes = (facts: Facts, asOf: bigint) => {
	const year = yearOf(asOf)
	const wages = facts.Wage.filter((wage) => wage.year === BigInt(year))
	const gross = sum(wages.map(grossOf))
	const roth = sum(wages.map((wage) => wage.roth))
	const afterTax = sum(facts.AfterTax.filter((row) => row.year === BigInt(year)).map((row) => row.amount))
	const plan = facts.PayPlan.find((row) => row.year === BigInt(year))
	const election = facts.Election.find((row) => row.year === BigInt(year))
	const rules = facts.TaxYear.find((row) => row.year === BigInt(year))
	const sentIn = (mercury: string) =>
		facts.Transfer.some((row) => row.mercury === mercury && covers(yearSpan(year), row.sentOn))
	const next = year + 1
	return {
		salary: plan && { target: plan.salary, ytd: gross, remaining: plan.salary - gross },
		roth: election && { room: election.roth - roth },
		// 415(c): annual additions stay within the limit and the year's pay, the
		// salary target standing in for pay not yet earned.
		afterTax: election &&
			rules && {
				room: min(
					election.afterTax - afterTax,
					min(rules.additionsLimit, min(max(gross, plan?.salary ?? 0n), rules.compensationLimit)) -
						roth -
						afterTax
				)
			},
		distributions: {
			ytd:
				sum(facts.Distribution.filter((row) => sentIn(row.transfer)).map((row) => row.amount)) +
				sum(facts.AfterTax.filter((row) => sentIn(row.transfer)).map((row) => row.amount))
		},
		taxPayments: (["Federal941", "Federal940", "TexasUI"] as const).map((account) => ({
			account,
			paid: sum(
				facts.TaxPayment.filter(
					(row) => row.account === account && covers(yearSpan(year), row.initiatedOn)
				).map((row) => row.amount)
			)
		})),
		overpaid: paychecks(facts)
			.filter((check) => check.sentNet > check.owedNet)
			.map((check) => ({ paidOn: check.wage.paidOn.start, excess: check.sentNet - check.owedNet })),
		setup:
			asOf >= dayOf(year, 12, 1)
				? [
						...(facts.TaxYear.some((row) => row.year === BigInt(next)) ? [] : [`year.set ${next}`]),
						...(facts.PayPlan.some((row) => row.year === BigInt(next)) ? [] : [`plan.set ${next}`]),
						...(facts.Election.some((row) => row.year === BigInt(next)) ? [] : [`election.set ${next}`])
					]
				: [],
		mismatches: mismatches(facts)
	}
}

export const status = (facts: Facts, asOf: bigint) => {
	const { open, credits, blockers } = obligations(facts, asOf)
	return {
		asOf,
		blockers,
		upcoming: open.filter((item) => item.opensOn > asOf),
		credits,
		...notes(facts, asOf)
	}
}
