import type { Fact, NativeRuntime, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { type Check, grossOf, netOf, paychecks } from "./check.ts"
import { formatDollars } from "./core/boundary.ts"
import {
	formatDate,
	formatPeriod,
	point,
	quarterOf,
	type Span,
	sameSpan,
	todayIn,
	yearOf,
	yearSpan
} from "./core/time.ts"
import { canonicalJson, MAX_I64, min, naturalId, refuse, sum } from "./core/values.ts"
import * as Db from "./db.ts"
import { correctable, figures, periodOf } from "./forms.ts"
import { CheckInput, priceCheck } from "./gross-up.ts"
import { type Obligation, obligations, status } from "./obligations.ts"
import { report } from "./reports.ts"
import {
	Day,
	MercuryTrackingId,
	Money,
	Period,
	PositiveMoney,
	parseStrict,
	Rate,
	Text,
	Year
} from "./schema/input.ts"
import * as S from "./schema.ts"

/* The op table. A write plans on one snapshot of the facts and the laws judge
 * the result; an identical re-run is no change. */

export const TIME_ZONE = "America/Chicago"
type Facts = Db.Facts
type Edit = Db.Edit

/** Natural ids: the same paycheck or filing always gets the same id. */
export const wageId = (paidOn: bigint) => naturalId("wage", paidOn)
export const filingId = (form: S.FormHandle, period: Span) =>
	naturalId("filing", form, period.start, period.end)

const rulesFor = (facts: Facts, year: number) =>
	facts.TaxYear.find((row) => row.year === BigInt(year)) ??
	refuse("TaxYearMissing", `Set ${year} first: year.set`)
const wageOn = (facts: Facts, paidOn: bigint) => facts.Wage.find((wage) => wage.paidOn.start === paidOn)
/** Where the year's next paycheck starts on the wage axis. */
const ytdOf = (facts: Facts, year: number) =>
	facts.Wage.filter((wage) => wage.year === BigInt(year)).reduce(
		(end, wage) => (wage.earnings.end > end ? wage.earnings.end : end),
		0n
	)
const same = (wage: Fact<typeof S.Wage>, check: Check) =>
	sameSpan(wage.earnings, check.earnings) &&
	wage.fit === check.fit &&
	wage.ss === check.ss &&
	wage.medicare === check.medicare &&
	wage.roth === check.roth
const present = (facts: Facts, edits: readonly Edit[]) =>
	edits.every(
		(edit) =>
			edit.op === "insert" &&
			facts[edit.relation].some((fact) => canonicalJson(fact) === canonicalJson(edit.fact))
	)
const describe = (item: Obligation) => {
	const when = item.paidOn !== undefined ? formatDate(item.paidOn) : item.period && formatPeriod(item.period)
	return `${item.what}${when ? ` ${when}` : ""}${item.amount === undefined ? "" : `: ${formatDollars(item.amount)}`}`
}

// ── payroll ────────────────────────────────────────────────────────────────

/** A posted paycheck: its amounts, what it recovered from earlier ones, and
 * the wires still to send for it. */
const paycheck = (facts: Facts, id: Uuid) => {
	const check =
		paychecks(facts).find((row) => row.wage.id === id) ?? refuse("WageMissing", "No such paycheck")
	const { wage } = check
	const paidOn = new Map(facts.Wage.map((row) => [row.id, row.paidOn.start]))
	const unsent = check.owedNet - check.sentNet
	const rothUnsent = wage.roth - check.sentRoth
	return {
		paidOn: wage.paidOn.start,
		gross: grossOf(wage),
		earnings: wage.earnings,
		fit: wage.fit,
		ss: wage.ss,
		medicare: wage.medicare,
		roth: wage.roth,
		net: check.net,
		owedNet: check.owedNet,
		sentNet: check.sentNet,
		sentRoth: check.sentRoth,
		recovered: facts.Recovery.filter((row) => row.recoveredBy === id).map((row) => ({
			paidOn: paidOn.get(row.wage) ?? refuse("WageMissing", "A recovery names no paycheck"),
			amount: row.amount
		})),
		wires: [
			...(unsent > 0n ? [{ kind: "NetPay", to: "the owner", amount: unsent }] : []),
			...(rothUnsent > 0n ? [{ kind: "RothDeferral", to: "Carry Roth QCRH000004", amount: rothUnsent }] : [])
		]
	}
}

/** Paychecks sent more net pay than they owe, oldest first. */
const overpaid = (facts: Facts) =>
	paychecks(facts)
		.filter((check) => check.sentNet > check.owedNet)
		.sort((a, b) => (a.wage.paidOn.start < b.wage.paidOn.start ? -1 : 1))
		.map((check) => ({ wage: check.wage, excess: check.sentNet - check.owedNet }))

const PayrollInput = Schema.Struct({ paidOn: Day, input: CheckInput, fit: Schema.optional(Money) })

/** The paycheck for a day: sized, priced, recovering earlier overpayments
 * oldest first. A post refuses while anything due by `paidOn` is open; a quote
 * shows what would refuse it. `by: "net"` is net after recoveries: what lands. */
const payroll =
	(request: typeof PayrollInput.Type, quoting = false) =>
	(facts: Facts): Db.Plan<object> => {
		const { paidOn } = request
		const year = yearOf(paidOn)
		const rules = rulesFor(facts, year)
		const plan = facts.PayPlan.find((row) => row.year === BigInt(year))
		const fit =
			request.fit ?? plan?.fitPerCheck ?? refuse("FitMissing", `Give fit, or set the ${year} pay plan`)
		const { blockers } = obligations(facts, paidOn)
		const shown = (after: Facts, id: Uuid) => ({ ...paycheck(after, id), ...(quoting ? { blockers } : {}) })
		const price = (ytd: bigint, recovering: bigint) =>
			priceCheck(
				rules,
				plan,
				ytd,
				paidOn,
				request.input.by === "net"
					? { ...request.input, net: request.input.net + recovering }
					: request.input,
				fit
			)

		const existing = wageOn(facts, paidOn)
		if (existing) {
			const took = sum(
				facts.Recovery.filter((row) => row.recoveredBy === existing.id).map((row) => row.amount)
			)
			if (!same(existing, price(existing.earnings.start, took)))
				refuse("WageExists", `A different paycheck is posted on ${formatDate(paidOn)}; use payroll.correct`)
			return { edits: [], result: shown(facts, existing.id) }
		}
		if (facts.Wage.some((wage) => wage.year === BigInt(year) && wage.paidOn.start > paidOn))
			refuse("Backdated", "A later paycheck is posted this year; earnings stay in date order")
		if (blockers.length > 0 && !quoting) refuse("PayrollBlocked", blockers.map(describe).join("; "))

		const owed = overpaid(facts)
		const check = price(ytdOf(facts, year), sum(owed.map((row) => row.excess)))
		const wage = { id: wageId(paidOn), paidOn: point(paidOn), year: BigInt(year), ...check }
		let left = netOf(check)
		const taken = owed.flatMap(({ wage: earlier, excess }) => {
			const amount = min(excess, left)
			left -= amount
			return amount > 0n ? [{ wage: earlier.id, recoveredBy: wage.id, amount }] : []
		})
		const after = { ...facts, Wage: [...facts.Wage, wage], Recovery: [...facts.Recovery, ...taken] }
		return {
			edits: [...Db.insert("Wage", wage), ...Db.insert("Recovery", ...taken)],
			result: shown(after, wage.id)
		}
	}

const CorrectInput = Schema.Struct({
	paidOn: Day,
	gross: Schema.optional(PositiveMoney),
	fit: Schema.optional(Money),
	roth: Schema.optional(Money)
})
/** Reprice a posted paycheck over the same earnings start. Differences surface
 * as obligations: a wire to top up, an overpayment to recover, a 941-X. */
const correct =
	(request: typeof CorrectInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const wage =
			wageOn(facts, request.paidOn) ?? refuse("WageMissing", `No paycheck on ${formatDate(request.paidOn)}`)
		const gross = request.gross ?? grossOf(wage)
		if (
			gross !== grossOf(wage) &&
			facts.Wage.some((row) => row.year === wage.year && row.paidOn.start > request.paidOn)
		)
			refuse(
				"GrossNotLatest",
				"Gross can change only on the year's latest paycheck, so later earnings never shift"
			)
		const check = priceCheck(
			rulesFor(facts, Number(wage.year)),
			undefined,
			wage.earnings.start,
			request.paidOn,
			{ by: "gross", gross, roth: request.roth ?? wage.roth },
			request.fit ?? wage.fit
		)
		if (same(wage, check)) return { edits: [], result: paycheck(facts, wage.id) }
		const corrected = { ...wage, ...check }
		const after = { ...facts, Wage: facts.Wage.map((row) => (row.id === wage.id ? corrected : row)) }
		if (paychecks(after).some((row) => row.wage.id === wage.id && row.net < 0n))
			refuse("NetNegative", "The corrected paycheck can't cover what it already recovered from earlier ones")
		return {
			edits: [...Db.remove("Wage", wage), ...Db.insert("Wage", corrected)],
			result: paycheck(after, wage.id)
		}
	}

// ── money out ──────────────────────────────────────────────────────────────

const wire = { mercury: MercuryTrackingId, sentOn: Day, amount: PositiveMoney }
const TransferInput = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("NetPay"), paidOn: Day, ...wire }),
	Schema.Struct({ kind: Schema.Literal("RothDeferral"), paidOn: Day, ...wire }),
	Schema.Struct({ kind: Schema.Literal("AfterTax"), year: Year, ...wire }),
	Schema.Struct({ kind: Schema.Literal("Distribution"), ...wire })
])
/** A Mercury transfer and the arm saying what it paid. A paycheck's wires may
 * not exceed what it owes; an earlier record of the same transfer is judged
 * by the laws instead, so a re-run is no change. */
const transfer =
	(request: typeof TransferInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const { mercury, sentOn, amount, kind } = request
		const recorded = facts.Transfer.some((row) => row.mercury === mercury)
		const arm = (): Edit[] => {
			switch (request.kind) {
				case "NetPay":
				case "RothDeferral": {
					const wage =
						wageOn(facts, request.paidOn) ??
						refuse("WageMissing", `No paycheck on ${formatDate(request.paidOn)}`)
					const check =
						paychecks(facts).find((row) => row.wage.id === wage.id) ??
						refuse("WageMissing", "No such paycheck")
					const [sent, owed] =
						request.kind === "NetPay" ? [check.sentNet, check.owedNet] : [check.sentRoth, wage.roth]
					if (!recorded && sent + amount > owed)
						refuse(
							"Overpaid",
							`${formatDate(request.paidOn)} has ${formatDollars(owed - sent)} of ${kind} unsent`
						)
					return Db.insert(request.kind, { transfer: mercury, wage: wage.id, amount })
				}
				case "AfterTax":
					return Db.insert("AfterTax", { transfer: mercury, year: BigInt(request.year), amount })
				case "Distribution":
					return Db.insert("Distribution", { transfer: mercury, amount })
			}
		}
		return { edits: [...Db.insert("Transfer", { mercury, sentOn, kind }), ...arm()], result: request }
	}

const quarterly = (span: Span) => sameSpan(span, quarterOf(span.start))
const yearly = (span: Span) => sameSpan(span, yearSpan(yearOf(span.start)))
const requirePeriod = (span: Span, shape: "quarter" | "year") => {
	if (!(shape === "year" ? yearly(span) : quarterly(span)))
		refuse("InvalidPeriod", shape === "year" ? 'Use a year, e.g. "2026"' : 'Use a quarter, e.g. "2026Q3"')
}

const TaxPaidInput = Schema.Struct({
	tracker: Text,
	account: Schema.Literals(S.TaxAccount.handles),
	kind: Schema.Literals(S.PaymentKind.handles),
	period: Period,
	amount: PositiveMoney,
	initiatedOn: Day,
	mercury: MercuryTrackingId,
	sentOn: Day
})
/** An EFTPS or TWC payment, recorded once its Mercury debit has posted. */
const taxPaid = (request: typeof TaxPaidInput.Type) => (): Db.Plan<object> => {
	const { tracker, account, kind, period, amount, initiatedOn, mercury, sentOn } = request
	requirePeriod(period, account === "Federal940" ? "year" : "quarter")
	return {
		edits: [
			...Db.insert("TaxPayment", { tracker, account, kind, period, amount, initiatedOn, funding: "Mercury" }),
			...Db.insert("Transfer", { mercury, sentOn, kind: "Tax" }),
			...Db.insert("TaxDebit", { transfer: mercury, payment: tracker })
		],
		result: request
	}
}

// ── filings ────────────────────────────────────────────────────────────────

const quarterlyForms: readonly S.FormHandle[] = ["F941", "C3"]
const filed = { form: Schema.Literals(S.Form.handles), period: Period }
const FilingInput = Schema.Union([
	Schema.Struct({ ...filed, method: Schema.Literal("Electronic"), on: Day, confirmation: Text }),
	Schema.Struct({ ...filed, method: Schema.Literal("CertifiedMail"), mailedOn: Day, tracking: Text }),
	Schema.Struct({ ...filed, method: Schema.Literal("Furnished"), on: Day })
])
type FilingInput = typeof FilingInput.Type

/** A return as filed: how, and every line as the ledger computes it now.
 * What is filed must equal the ledger; fix the ledger first if it doesn't. */
const filingEdits = (facts: Facts, id: Uuid, request: FilingInput): Edit[] => {
	const { form, period, method } = request
	requirePeriod(period, quarterlyForms.includes(form) ? "quarter" : "year")
	const lines = [...figures(form, periodOf(facts, period))].map(([line, value]) => ({
		filing: id,
		line,
		value
	}))
	return [
		...Db.insert("Filing", { id, form, period, method }),
		...(request.method === "Electronic"
			? Db.insert("Electronic", { filing: id, on: request.on, confirmation: request.confirmation })
			: request.method === "CertifiedMail"
				? Db.insert("CertifiedMail", { filing: id, mailedOn: request.mailedOn, tracking: request.tracking })
				: Db.insert("Furnished", { filing: id, on: request.on })),
		...Db.insert("FiledFigures", ...lines)
	]
}
const fileReturn =
	(request: FilingInput) =>
	(facts: Facts): Db.Plan<object> => ({
		edits: filingEdits(facts, filingId(request.form, request.period), request),
		result: request
	})

/** A grandfathered filing gets its real method and its figures as the ledger
 * computes them, once those details turn up. */
const upgrade =
	(request: FilingInput) =>
	(facts: Facts): Db.Plan<object> => {
		const filing = facts.Filing.find(
			(row) => row.form === request.form && sameSpan(row.period, request.period)
		)
		const prior = filing && facts.Prior.find((row) => row.filing === filing.id)
		if (filing && !prior && present(facts, filingEdits(facts, filing.id, request)))
			return { edits: [], result: request }
		if (!filing || !prior)
			return refuse(
				"NotPrior",
				`${request.form} ${formatPeriod(request.period)} is not a grandfathered filing`
			)
		if (facts.Correction.some((row) => row.filing === filing.id))
			refuse("Corrected", "This 941 has a 941-X, so its original figures can't be reproduced")
		return {
			edits: [
				...Db.remove("Prior", prior),
				...Db.remove("Filing", filing),
				...filingEdits(facts, filing.id, request)
			],
			result: request
		}
	}

const AmendInput = Schema.Struct({ period: Period, mailedOn: Day, tracking: Text })
/** A 941-X mailed for a quarter: the corrected lines as the ledger computes
 * them now. The originals are the 941's own figures. */
const amend =
	(request: typeof AmendInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		requirePeriod(request.period, "quarter")
		const filing =
			facts.Filing.find((row) => row.form === "F941" && sameSpan(row.period, request.period)) ??
			refuse("F941Missing", `No 941 is recorded for ${formatPeriod(request.period)}`)
		const current = figures("F941", periodOf(facts, request.period))
		return {
			edits: [
				...Db.insert("Correction", {
					filing: filing.id,
					mailedOn: request.mailedOn,
					tracking: request.tracking
				}),
				...Db.insert(
					"CorrectedFigures",
					...correctable.map((line) => ({ filing: filing.id, line, value: current.get(line) ?? 0n }))
				)
			],
			result: request
		}
	}

const DistributionInput = Schema.Struct({
	year: Year,
	account: Schema.Literals(S.PlanAccount.handles),
	code: Schema.Literals(S.DistributionCode.handles),
	gross: PositiveMoney,
	taxable: Money
})
/** A Carry rollover (H) or conversion (G) that needs a 1099-R. */
const planDistribution = (request: typeof DistributionInput.Type) => (): Db.Plan<object> => {
	const move = S.PlanMove.handles.find((handle) => handle === `${request.account}_${request.code}`)
	if (move === undefined)
		return refuse(
			"ImpliedConversion",
			"After-tax conversions (AfterTax, G) are implied by AfterTax transfers"
		)
	return {
		edits: Db.insert("PlanDistribution", {
			year: BigInt(request.year),
			move,
			gross: request.gross,
			taxable: request.taxable
		}),
		result: request
	}
}

// ── setup ──────────────────────────────────────────────────────────────────

const SetupInput = Schema.Struct({
	business: Schema.Struct({ ein: Text, name: Text, twcAccount: Text }),
	employee: Schema.Struct({ ssn: Text, firstName: Text, lastName: Text, address: Text }),
	employedFrom: Day
})
const YearInput = Schema.Struct({
	year: Year,
	ssRate: Rate,
	ssBase: Money,
	medicareRate: Rate,
	futaRate: Rate,
	futaBase: Money,
	sutaRate: Rate,
	sutaBase: Money,
	deferralLimit: Money,
	additionsLimit: Money,
	compensationLimit: Money,
	wageCeiling: Money
})
const PlanInput = Schema.Struct({ year: Year, salary: PositiveMoney, fitPerCheck: Money })
const ElectionInput = Schema.Struct({ year: Year, roth: Money, afterTax: Money, signedOn: Day })

/** The one invariant bumbledb can't state over two columns: the Roth and
 * after-tax elections together stay within 415(c). */
const within415 = (
	election: { roth: bigint; afterTax: bigint } | undefined,
	rules: { additionsLimit: bigint } | undefined
) => {
	if (election && rules && election.roth + election.afterTax > rules.additionsLimit)
		refuse(
			"Over415c",
			`Roth plus after-tax elections exceed the ${formatDollars(rules.additionsLimit)} 415(c) limit`
		)
}
/** A year's row, replaced whole; the laws judge the new one. */
const replace = <N extends Db.Name>(
	name: N,
	old: Fact<Db.Stored[N]> | undefined,
	next: Fact<Db.Stored[N]>
): Edit[] =>
	old && canonicalJson(old) === canonicalJson(next)
		? []
		: [...(old ? Db.remove(name, old) : []), ...Db.insert(name, next)]

const setYear =
	(request: typeof YearInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const { year, ...rules } = request
		const row = { year: BigInt(year), span: yearSpan(year), ...rules }
		within415(
			facts.Election.find((election) => election.year === row.year),
			row
		)
		return {
			edits: replace(
				"TaxYear",
				facts.TaxYear.find((old) => old.year === row.year),
				row
			),
			result: request
		}
	}
const setPlan =
	(request: typeof PlanInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const row = { year: BigInt(request.year), salary: request.salary, fitPerCheck: request.fitPerCheck }
		return {
			edits: replace(
				"PayPlan",
				facts.PayPlan.find((old) => old.year === row.year),
				row
			),
			result: request
		}
	}
const setElection =
	(request: typeof ElectionInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const row = {
			year: BigInt(request.year),
			roth: request.roth,
			afterTax: request.afterTax,
			signedOn: request.signedOn
		}
		within415(
			row,
			facts.TaxYear.find((rules) => rules.year === row.year)
		)
		return {
			edits: replace(
				"Election",
				facts.Election.find((old) => old.year === row.year),
				row
			),
			result: request
		}
	}

// ── the table ──────────────────────────────────────────────────────────────

type Run = (input: never, ledger: string) => Effect.Effect<unknown, unknown, NativeRuntime>
export type Op = { readonly summary: string; readonly input: Schema.Top; readonly run: Run }
const op = <I extends Schema.Top>(
	summary: string,
	input: I,
	run: (input: I["Type"], ledger: string) => Effect.Effect<unknown, unknown, NativeRuntime>
): Op => ({ summary, input, run: run as Run })

const writing =
	<A>(plan: (input: A) => (facts: Facts) => Db.Plan<object>) =>
	(input: A, ledger: string) =>
		Effect.scoped(Effect.flatMap(Db.open(ledger), (db) => Db.write(db, plan(input))))
const reading =
	<A>(read: (input: A, facts: Facts) => unknown) =>
	(input: A, ledger: string) =>
		Effect.scoped(
			Effect.flatMap(Db.open(ledger), (db) => Effect.map(Db.readFacts(db), ({ facts }) => read(input, facts)))
		)

export const ops: { readonly [name: string]: Op } = {
	setup: op("Create the ledger: the business, its employee and the employment", SetupInput, (input, ledger) =>
		Db.build(ledger, {
			edits: [
				...Db.insert("Business", input.business),
				...Db.insert("Employee", input.employee),
				...Db.insert("Employment", { span: { start: input.employedFrom, end: MAX_I64 } })
			],
			result: input
		})
	),
	"year.set": op("Set a tax year's rates, wage bases and limits", YearInput, writing(setYear)),
	"plan.set": op("Set a year's salary target and FIT per paycheck", PlanInput, writing(setPlan)),
	"election.set": op("Record the year's signed Carry election", ElectionInput, writing(setElection)),
	"payroll.quote": op(
		"Price a paycheck without posting it; shows what would block it",
		PayrollInput,
		(input, ledger) =>
			Effect.scoped(Effect.flatMap(Db.open(ledger), (db) => Db.judge(db, payroll(input, true))))
	),
	"payroll.post": op("Post a paycheck; prints the wires to send", PayrollInput, writing(payroll)),
	"payroll.correct": op(
		"Reprice a posted paycheck's fit, roth or (latest only) gross",
		CorrectInput,
		writing(correct)
	),
	"transfer.record": op("Record a Mercury transfer by its Tracking ID", TransferInput, writing(transfer)),
	"tax.paid": op(
		"Record an EFTPS or TWC payment once its Mercury debit posted",
		TaxPaidInput,
		writing(taxPaid)
	),
	"filing.record": op("Record a filed return with every line as filed", FilingInput, writing(fileReturn)),
	"filing.amend": op("Record a 941-X mailed for a quarter", AmendInput, writing(amend)),
	"filing.upgrade": op(
		"Give a grandfathered filing its real method and figures",
		FilingInput,
		writing(upgrade)
	),
	"plan.distribution": op(
		"Record a Carry rollover or conversion for the 1099-R",
		DistributionInput,
		writing(planDistribution)
	),
	status: op(
		"What blocks payroll, what comes due next, and the year so far",
		Schema.Struct({ asOf: Schema.optional(Day) }),
		reading((input, facts) => status(facts, input.asOf ?? todayIn(TIME_ZONE)))
	),
	report: op(
		"A year's or quarter's forms, paychecks, distributions and tax payments",
		Schema.Struct({
			year: Year,
			quarter: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4 })))
		}),
		reading((input, facts) => report(facts, input.year, input.quarter))
	),
	export: op(
		"Write every fact as canonical JSON: the backup",
		Schema.Struct({ out: Schema.optional(Text) }),
		(input, ledger) =>
			Effect.scoped(
				Effect.gen(function* () {
					const { facts } = yield* Db.readFacts(yield* Db.open(ledger))
					const out = input.out ?? Db.backupOf(ledger)
					yield* Db.writeText(out, Db.exportFacts(facts))
					return { out, facts: BigInt(Object.values(facts).reduce((total, rows) => total + rows.length, 0)) }
				})
			)
	),
	import: op("Create the ledger from an export", Schema.Struct({ file: Text }), (input, ledger) =>
		Effect.flatMap(Db.readText(input.file), (text) => {
			const edits = Db.importEdits(text)
			return Db.build(ledger, { edits, result: { file: input.file, facts: BigInt(edits.length) } })
		})
	)
}

/** Parse the payload against the op's input, then run it. */
export const run = (name: string, payload: unknown, ledger = Db.ledgerPath) =>
	Effect.suspend(() => {
		const entry = (Object.hasOwn(ops, name) ? ops[name] : undefined) ?? refuse("UnknownOp", `No op "${name}"`)
		return entry.run(parseStrict(entry.input as never, payload) as never, ledger)
	})
