import type { Uuid } from "@bjornpagen/bumbledb"
import { dueOn } from "./calendar.ts"
import { jurisdictionOf, type Paycheck, paychecks } from "./check.ts"
import {
	covers,
	dayOf,
	monthOf,
	months,
	quarterOf,
	quarterSpan,
	type Span,
	sameSpan,
	yearOf,
	yearSpan
} from "./core/time.ts"
import { max, min, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import {
	column4,
	correctionDue,
	correctionName,
	correctionsOf,
	figures,
	formatLine,
	latest,
	mailed,
	paidToward,
	paymentLine,
	periodOf
} from "./forms.ts"
import { awaitingSweep, conversions } from "./plan.ts"
import {
	type AccountHandle,
	Form,
	type FormHandle,
	type JurisdictionHandle,
	Line,
	type LineHandle,
	type Periodicity,
	Tax,
	TaxAccount
} from "./schema.ts"

/* Control flow as data: what is owed, when it opens, when it is due, and the
 * op that clears it, read off the rosters. Payroll is blocked while anything
 * here is open. */

export type Obligation = {
	readonly what: string
	readonly next: string
	readonly opensOn: bigint
	readonly dueOn?: bigint
	readonly amount?: bigint
	readonly period?: Span
	readonly paidOn?: bigint
}
export type Credit = { readonly account: AccountHandle; readonly period: Span; readonly credit: bigint }

type Every = (typeof Periodicity.handles)[number]
const spanOf = (periodicity: Every, day: bigint): Span =>
	periodicity === "Month" ? monthOf(day) : periodicity === "Quarter" ? quarterOf(day) : yearSpan(yearOf(day))
const distinct = (spans: readonly Span[]) =>
	[...new Map(spans.map((span) => [`${span.start}/${span.end}`, span])).values()].sort((a, b) =>
		a.start < b.start ? -1 : 1
	)
/** Periods of a kind that intersect a span, opening no later than `through`. */
const periodsIn = (periodicity: Every, span: Span, through: bigint) => {
	const spans: Span[] = []
	for (let period = spanOf(periodicity, span.start); period.start < span.end && period.start <= through; ) {
		spans.push(period)
		period = spanOf(periodicity, period.end)
	}
	return spans
}

/** A paycheck counts toward a jurisdiction's taxes and returns when the work
 * was there: every paycheck is federal, a state's are those earned in it. */
const earnedIn = (check: Paycheck, jurisdiction: JurisdictionHandle) =>
	jurisdiction === "Federal" || check.state === jurisdiction
const employedIn = (facts: Facts, jurisdiction: JurisdictionHandle) =>
	facts.Employment.filter((row) => jurisdiction === "Federal" || row.state === jurisdiction)

const filingOf = (facts: Facts, form: FormHandle, period: Span) =>
	facts.Filing.find((row) => row.form === form && sameSpan(row.period, period))
const filedValue = (facts: Facts, filing: Uuid, line: LineHandle) =>
	facts.FiledFigures.find((row) => row.filing === filing && row.line === line)?.value ?? 0n
/** Returns whose line states what a tax account owes. */
const owing = (form: FormHandle) =>
	TaxAccount.handles.some((account) => Line.axioms[TaxAccount.axioms[account].liability].form === form)
const article = (name: string) => (/^[aeiou]/i.test(name) ? "an" : "a")
const corrected = (facts: Facts, form: FormHandle, period: Span) => {
	const filing = filingOf(facts, form, period)
	return filing !== undefined && facts.Correction.some((row) => row.filing === filing.id)
}

/** The lines that state an account's liability by accrual period: its
 * return's liability line, or, accruing monthly, the 941's line 16. */
const monthLines: readonly LineHandle[] = ["F941_16_1", "F941_16_2", "F941_16_3"]
const paying: { readonly [A in AccountHandle]: string } = {
	Federal941: "941 deposit",
	Federal940: "FUTA tax",
	TexasUI: "Texas UI tax"
}

type Accrual = {
	readonly what: string
	readonly period: Span
	readonly amount: bigint
	readonly opensOn: bigint
	readonly dueOn: bigint
}

/** What a period owes an account: once its return is filed, the return as
 * filed, then what each correction adds, due when it goes out (a 941-X its
 * column 4, an amended return the change in its liability line); until then,
 * as the ledger computes it. */
const accruals = (facts: Facts, account: AccountHandle, period: Span): Accrual[] => {
	const rules = TaxAccount.axioms[account]
	const form = Line.axioms[rules.liability].form
	const filing = filingOf(facts, form, period)
	const current = filing ? undefined : figures(form, periodOf(facts, period))
	const value = (line: LineHandle) =>
		filing ? filedValue(facts, filing.id, line) : (current?.get(line) ?? 0n)
	const due = (span: Span) => ({
		what: paying[account],
		opensOn: span.end,
		dueOn: dueOn(span.end, rules.dueDay, rules.dueOffset)
	})
	const accrued =
		rules.accrues === rules.period
			? [{ period, amount: value(rules.liability), ...due(period) }]
			: months(period).map((month, index) => ({
					period: month,
					amount: value(monthLines[index] ?? rules.liability),
					...due(month)
				}))
	const balances = filing
		? correctionsOf(facts, filing.id).map((correction) => ({
				what: `${correctionName[form]} balance`,
				period,
				amount:
					form === "F941"
						? column4(facts, filing, mailed(facts, filing.id, correction.mailedOn)).owed
						: (latest(facts, filing.id, correction.mailedOn + 1n).get(rules.liability) ?? 0n) -
							(latest(facts, filing.id, correction.mailedOn).get(rules.liability) ?? 0n),
				opensOn: correction.mailedOn,
				dueOn: correction.mailedOn
			}))
		: []
	return [...accrued, ...balances]
}

/** The periods an account has anything in: wages earned in its
 * jurisdiction, a return filed, or a payment made. */
const accountPeriods = (facts: Facts, checks: readonly Paycheck[], account: AccountHandle) => {
	const rules = TaxAccount.axioms[account]
	const form = Line.axioms[rules.liability].form
	return distinct([
		...checks
			.filter((check) => earnedIn(check, rules.jurisdiction))
			.map((check) => spanOf(rules.period, check.wage.paidOn.start)),
		...facts.Filing.filter((row) => row.form === form).map((row) => row.period),
		...facts.TaxPayment.filter((row) => row.account === account).map((row) => row.period)
	])
}

/** The periods a return is due for, by its trigger. */
const returnPeriods = (facts: Facts, checks: readonly Paycheck[], form: FormHandle, asOf: bigint) => {
	const rules = Form.axioms[form]
	switch (rules.trigger) {
		case "Employment":
			return distinct(
				employedIn(facts, rules.jurisdiction).flatMap((row) => periodsIn(rules.period, row.span, asOf))
			)
		case "Wages":
			return distinct(
				checks
					.filter((check) => earnedIn(check, rules.jurisdiction))
					.map((check) => spanOf(rules.period, check.wage.paidOn.start))
			)
		case "PlanActivity":
			return distinct([
				...conversions(facts).map((row) => spanOf(rules.period, row.on)),
				...facts.Rollover.map((row) => spanOf(rules.period, row.on))
			])
	}
}

/** Each year the owner is employed needs its federal policy, an election and
 * each employing state's policy: blocking from January 1, shown from
 * December 1. */
const policy = (facts: Facts, asOf: bigint): Obligation[] => {
	const through = asOf >= dayOf(yearOf(asOf), 12, 1) ? yearOf(asOf) + 1 : yearOf(asOf)
	const years = new Map<number, Set<JurisdictionHandle>>()
	for (const row of facts.Employment)
		for (const span of periodsIn("Year", row.span, yearSpan(through).start)) {
			const states = years.get(yearOf(span.start)) ?? new Set()
			years.set(yearOf(span.start), states.add(row.state))
		}
	return [...years].flatMap(([year, states]) => {
		const span = yearSpan(year)
		const item = (what: string, next: string): Obligation => ({
			what,
			next,
			period: span,
			opensOn: span.start,
			dueOn: span.start
		})
		const priced = (jurisdiction: JurisdictionHandle) =>
			Tax.handles
				.filter((tax) => Tax.axioms[tax].banded && jurisdictionOf(tax) === jurisdiction)
				.every((tax) => facts.TaxBand.some((band) => band.year === BigInt(year) && band.tax === tax))
		return [
			...(facts.TaxYear.some((row) => row.year === BigInt(year))
				? []
				: [item("Set the federal policy", "policy.set")]),
			...(facts.Election.some((row) => row.year === BigInt(year))
				? []
				: [item("Record the signed election", "election.set")]),
			...[...states]
				.filter((state) => !priced(state))
				.map((state) => item(`Set the ${state} policy`, "policy.set"))
		]
	})
}

/** The 941 tax a lookback period reported: line 12 of each quarter, as filed
 * once filed. */
const reported941 = (facts: Facts, quarter: Span) => {
	const filing = filingOf(facts, "F941", quarter)
	return filing
		? filedValue(facts, filing.id, "F941_12")
		: (figures("F941", periodOf(facts, quarter)).get("F941_12") ?? 0n)
}
/** Over $50,000 of 941 tax in a year's lookback period (July 1 two years
 * before through June 30 of the year before) makes the business a semiweekly
 * depositor that year, which the ledger does not schedule: payroll stops from
 * January 1, and the year before shows it coming. */
export const LOOKBACK_LIMIT = 5_000_000n
const depositSchedule = (facts: Facts, asOf: bigint): Obligation[] => {
	const years = [yearOf(asOf), yearOf(asOf) + 1]
	return years.flatMap((year) => {
		const lookback = [
			quarterSpan(year - 2, 3),
			quarterSpan(year - 2, 4),
			quarterSpan(year - 1, 1),
			quarterSpan(year - 1, 2)
		]
		const reported = sum(lookback.map((quarter) => reported941(facts, quarter)))
		return reported > LOOKBACK_LIMIT
			? [
					{
						what: "Semiweekly depositor: the ledger schedules only monthly deposits",
						next: "none",
						period: yearSpan(year),
						opensOn: yearSpan(year).start,
						amount: reported
					}
				]
			: []
	})
}

export const obligations = (facts: Facts, asOf: bigint) => {
	const checks = paychecks(facts)
	const open: Obligation[] = [...policy(facts, asOf), ...depositSchedule(facts, asOf)]
	const credits: Credit[] = []

	for (const check of checks) {
		const paidOn = check.wage.paidOn.start
		const wire = (what: string, amount: bigint) =>
			open.push({ what, next: "transfer.record", paidOn, opensOn: paidOn, dueOn: paidOn, amount })
		if (check.sentNet < check.owedNet) wire("Send net pay", check.owedNet - check.sentNet)
		if (check.sentRoth < check.roth) wire("Send Roth to Carry", check.roth - check.sentRoth)
	}

	// Tax: Deposit and Balance payments clear a period's accruals in the order
	// they arose; what is left over is a credit.
	for (const account of TaxAccount.handles)
		for (const period of accountPeriods(facts, checks, account)) {
			let left = paidToward(facts, account, period)
			const owed = accruals(facts, account, period).sort((a, b) =>
				a.opensOn < b.opensOn ? -1 : a.opensOn > b.opensOn ? 1 : a.dueOn < b.dueOn ? -1 : 1
			)
			for (const accrual of owed) if (accrual.amount < 0n) left -= accrual.amount
			for (const accrual of owed.filter((row) => row.amount > 0n)) {
				const covered = min(accrual.amount, left)
				left -= covered
				if (accrual.amount > covered)
					open.push({
						what: accrual.what,
						next: "tax.paid",
						period: accrual.period,
						amount: accrual.amount - covered,
						opensOn: accrual.opensOn,
						dueOn: accrual.dueOn
					})
			}
			if (left > 0n) credits.push({ account, period, credit: left })
		}

	for (const form of Form.handles) {
		const rules = Form.axioms[form]
		for (const period of returnPeriods(facts, checks, form, asOf))
			if (!filingOf(facts, form, period))
				open.push({
					what: `File ${form}`,
					next: "filing.record",
					period,
					opensOn: period.end,
					dueOn: dueOn(period.end, rules.dueDay, rules.dueOffset)
				})
	}

	// A filed return that states a liability and no longer matches what it
	// reports needs a correction: it owes, so it blocks.
	for (const filing of facts.Filing.filter((row) => owing(row.form))) {
		if (correctionDue(facts, filing).size > 0)
			open.push({
				what: `File ${article(correctionName[filing.form])} ${correctionName[filing.form]}`,
				next: "filing.correct",
				period: filing.period,
				opensOn: filing.period.end
			})
	}

	open.sort((a, b) => (a.opensOn < b.opensOn ? -1 : a.opensOn > b.opensOn ? 1 : 0))
	return { open, credits, blockers: open.filter((item) => item.opensOn <= asOf) }
}

/** Filed figures, as corrected, that no longer match the ledger, for returns
 * that state no liability (those block instead), leaving out lines that
 * payments move after filing. A correctable line names the op that files its
 * correction. Corrected 1099-Rs go with a 1096 of their own, so the original
 * 1096 then stands as filed. */
export const mismatches = (facts: Facts) =>
	facts.Filing.filter(
		(row) => !owing(row.form) && !(row.form === "F1096" && corrected(facts, "F1099R", row.period))
	).flatMap((filing) => {
		const current = figures(filing.form, periodOf(facts, filing.period))
		return [...latest(facts, filing.id)]
			.filter(([line, value]) => !paymentLine(line) && value !== (current.get(line) ?? 0n))
			.map(([line, value]) => ({
				form: filing.form,
				period: filing.period,
				line,
				filed: formatLine(line, value),
				now: formatLine(line, current.get(line) ?? 0n),
				...(Line.axioms[line].correctable ? { next: "filing.correct" } : {})
			}))
	})

/** What more the year's after-tax contributions may take: the election left,
 * and 415(c), annual additions within the limit and the year's pay, the
 * salary target standing in for pay not yet earned. */
export const afterTaxRoom = (facts: Facts, year: bigint) => {
	const checks = paychecks(facts).filter((check) => check.wage.year === year)
	const gross = sum(checks.map((check) => check.gross))
	const roth = sum(checks.map((check) => check.roth))
	const afterTax = sum(facts.AfterTax.filter((row) => row.year === year).map((row) => row.amount))
	const plan = facts.PayPlan.find((row) => row.year === year)
	const election = facts.Election.find((row) => row.year === year)
	const limits = facts.TaxYear.find((row) => row.year === year)
	return election && limits
		? min(
				election.afterTax - afterTax,
				min(limits.additionsLimit, min(max(gross, plan?.salary ?? 0n), limits.compensationLimit)) -
					roth -
					afterTax
			)
		: undefined
}

/** Non-blocking lines for the year of asOf. */
export const notes = (facts: Facts, asOf: bigint) => {
	const year = yearOf(asOf)
	const checks = paychecks(facts).filter((check) => check.wage.year === BigInt(year))
	const gross = sum(checks.map((check) => check.gross))
	const roth = sum(checks.map((check) => check.roth))
	const plan = facts.PayPlan.find((row) => row.year === BigInt(year))
	const election = facts.Election.find((row) => row.year === BigInt(year))
	const room = afterTaxRoom(facts, BigInt(year))
	const sentIn = (mercury: string) =>
		facts.Transfer.some((row) => row.mercury === mercury && covers(yearSpan(year), row.sentOn))
	const planYears = asOf >= dayOf(year, 12, 1) ? [year, year + 1] : [year]
	return {
		salary: plan && { target: plan.salary, ytd: gross, remaining: plan.salary - gross },
		roth: election && { room: election.roth - roth },
		afterTax: room === undefined ? undefined : { room },
		rothBasis: { awaiting: awaitingSweep(facts) },
		distributions: {
			ytd:
				sum(facts.Distribution.filter((row) => sentIn(row.transfer)).map((row) => row.amount)) +
				sum(facts.AfterTax.filter((row) => sentIn(row.transfer)).map((row) => row.amount))
		},
		taxPayments: TaxAccount.handles.map((account) => ({
			account,
			paid: sum(
				facts.TaxPayment.filter(
					(row) => row.account === account && covers(yearSpan(year), row.initiatedOn.start)
				).map((row) => row.amount)
			)
		})),
		overpaid: paychecks(facts)
			.filter((check) => check.sentNet > check.owedNet)
			.map((check) => ({ paidOn: check.wage.paidOn.start, excess: check.sentNet - check.owedNet })),
		setup: planYears
			.filter((planYear) => !facts.PayPlan.some((row) => row.year === BigInt(planYear)))
			.map((planYear) => `plan.set ${planYear}`),
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
