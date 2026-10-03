import type { Fact, NativeRuntime, Uuid } from "@bjornpagen/bumbledb"
import { Effect, Schema } from "effect"
import { assess, bandsFor, type Check, jurisdictionOf, netOf, paychecks, stateOn } from "./check.ts"
import { formatDollars } from "./core/boundary.ts"
import {
	covers,
	formatDate,
	formatPeriod,
	monthOf,
	point,
	quarterOf,
	type Span,
	sameSpan,
	todayIn,
	yearOf,
	yearSpan
} from "./core/time.ts"
import { canonicalJson, MAX_I64, MAX_U64, max, min, naturalId, refuse, sum } from "./core/values.ts"
import * as Db from "./db.ts"
import { correctionDue, figures, periodOf } from "./forms.ts"
import { CheckInput, fitting, priceCheck } from "./gross-up.ts"
import { afterTaxRoom, type Obligation, obligations, status } from "./obligations.ts"
import { sweeps } from "./plan.ts"
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

const limitsFor = (facts: Facts, year: bigint) =>
	facts.TaxYear.find((row) => row.year === year) ??
	refuse("PolicyMissing", `Set the ${year} federal policy first: policy.set`)
const wageOn = (facts: Facts, paidOn: bigint) => facts.Wage.find((wage) => wage.paidOn.start === paidOn)
/** The year's gross paid before a day: where a paycheck that day starts. */
const ytdBefore = (facts: Facts, year: bigint, paidOn: bigint) =>
	sum(facts.Wage.filter((wage) => wage.year === year && wage.paidOn.start < paidOn).map((wage) => wage.gross))
const describe = (item: Obligation) => {
	const when = item.paidOn !== undefined ? formatDate(item.paidOn) : item.period && formatPeriod(item.period)
	return `${item.what}${when ? ` ${when}` : ""}${item.amount === undefined ? "" : `: ${formatDollars(item.amount)}`}`
}
type Every = (typeof S.Periodicity.handles)[number]
const shapes: { readonly [P in Every]: { readonly of: (day: bigint) => Span; readonly example: string } } = {
	Month: { of: monthOf, example: '"2026-10"' },
	Quarter: { of: quarterOf, example: '"2026Q3"' },
	Year: { of: (day) => yearSpan(yearOf(day)), example: '"2026"' }
}
const requirePeriod = (span: Span, periodicity: Every) => {
	if (!sameSpan(span, shapes[periodicity].of(span.start)))
		refuse("InvalidPeriod", `Use a ${periodicity.toLowerCase()}, e.g. ${shapes[periodicity].example}`)
}
/** A row replaced whole; an identical one is no change. */
const replace = <N extends Db.Name>(
	name: N,
	old: Fact<Db.Stored[N]> | undefined,
	next: Fact<Db.Stored[N]>
): Edit[] =>
	old && canonicalJson(old) === canonicalJson(next)
		? []
		: [...(old ? Db.remove(name, old) : []), ...Db.insert(name, next)]

// ── payroll ────────────────────────────────────────────────────────────────

const withholding = (wage: Uuid, check: Check) =>
	[...check.withheld].map(([tax, amount]) => ({ wage, tax, amount }))
const same = (facts: Facts, wage: Fact<typeof S.Wage>, check: Check) =>
	wage.gross === check.gross &&
	wage.roth === check.roth &&
	[...check.withheld].every(([tax, amount]) =>
		facts.Withholding.some((row) => row.wage === wage.id && row.tax === tax && row.amount === amount)
	)
const wiredTo = (facts: Facts, account: S.PlanAccountHandle) => {
	const held = facts.Custody.find((row) => row.account === account)
	return held ? `${held.custodian} ${account} ${held.number}` : `the plan's ${account} account`
}

/** A posted paycheck: its amounts, what it recovered from earlier ones, and
 * the wires still to send for it. */
const paycheck = (facts: Facts, id: Uuid) => {
	const check =
		paychecks(facts).find((row) => row.wage.id === id) ?? refuse("WageMissing", "No such paycheck")
	const paidOn = new Map(facts.Wage.map((row) => [row.id, row.paidOn.start]))
	const unsent = check.owedNet - check.sentNet
	const rothUnsent = check.roth - check.sentRoth
	return {
		paidOn: check.wage.paidOn.start,
		gross: check.gross,
		ytd: check.ytd,
		fit: check.withheld.get("FIT") ?? 0n,
		ss: check.withheld.get("SocialSecurity") ?? 0n,
		medicare: check.withheld.get("Medicare") ?? 0n,
		roth: check.roth,
		net: check.net,
		owedNet: check.owedNet,
		sentNet: check.sentNet,
		sentRoth: check.sentRoth,
		recovered: facts.Recovery.filter((row) => row.recoveredBy === id)
			.map((row) => ({
				paidOn: paidOn.get(row.wage) ?? refuse("WageMissing", "A recovery names no paycheck"),
				amount: row.amount
			}))
			.sort((a, b) => (a.paidOn < b.paidOn ? -1 : 1)),
		wires: [
			...(unsent > 0n ? [{ kind: "NetPay", to: "the owner", amount: unsent }] : []),
			...(rothUnsent > 0n ? [{ kind: "RothDeferral", to: wiredTo(facts, "Roth"), amount: rothUnsent }] : [])
		]
	}
}

/** Roth comes out of pay only under a signed election: none from a paycheck
 * paid before the year's election was signed. */
const requireSigned = (facts: Facts, year: bigint, paidOn: bigint) => {
	const election = facts.Election.find((row) => row.year === year)
	if (election && paidOn < election.signedOn)
		refuse(
			"ElectionUnsigned",
			`The ${year} election was signed ${formatDate(election.signedOn)}; no Roth comes out of pay before it`
		)
}

/** Paychecks sent more net pay than they owe, oldest first. */
const overpaid = (facts: Facts) =>
	paychecks(facts)
		.filter((check) => check.sentNet > check.owedNet)
		.map((check) => ({ wage: check.wage, excess: check.sentNet - check.owedNet }))

const PayrollInput = Schema.Struct({ paidOn: Day, input: CheckInput, fit: Schema.optional(Money) })

/** The paycheck for a day: sized, priced, recovering earlier overpayments
 * oldest first. A post refuses while anything due by `paidOn` is open; a quote
 * shows what would refuse it. `by: "net"` is net after recoveries: what lands. */
const payroll =
	(request: typeof PayrollInput.Type, quoting = false) =>
	(facts: Facts): Db.Plan<object> => {
		const { paidOn } = request
		const year = BigInt(yearOf(paidOn))
		const limits = limitsFor(facts, year)
		const plan = facts.PayPlan.find((row) => row.year === year)
		const fit =
			request.fit ?? plan?.fitPerCheck ?? refuse("FitMissing", `Give fit, or set the ${year} pay plan`)
		const bands = bandsFor(facts, year, stateOn(facts, paidOn))
		const { blockers } = obligations(facts, paidOn)
		const shown = (after: Facts, id: Uuid) => ({ ...paycheck(after, id), ...(quoting ? { blockers } : {}) })
		const priced = (recovering: bigint) =>
			priceCheck(
				limits,
				bands,
				plan,
				ytdBefore(facts, year, paidOn),
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
			if (!same(facts, existing, priced(took)))
				refuse("WageExists", `A different paycheck is posted on ${formatDate(paidOn)}; use payroll.correct`)
			return { edits: [], result: shown(facts, existing.id) }
		}
		if (facts.Wage.some((wage) => wage.year === year && wage.paidOn.start > paidOn))
			refuse("Backdated", "A later paycheck is posted this year; paychecks stay in date order")
		const filed = facts.Filing.find(
			(row) => S.Form.axioms[row.form].trigger !== "PlanActivity" && covers(row.period, paidOn)
		)
		if (filed)
			refuse("PeriodFiled", `${filed.form} ${formatPeriod(filed.period)} is filed; no paycheck can join it`)
		if ((request.input.roth ?? 0n) > 0n) requireSigned(facts, year, paidOn)
		if (blockers.length > 0 && !quoting) refuse("PayrollBlocked", blockers.map(describe).join("; "))

		const owed = overpaid(facts)
		const check = priced(sum(owed.map((row) => row.excess)))
		const id = wageId(paidOn)
		const wage = { id, paidOn: point(paidOn), year, gross: check.gross, roth: check.roth }
		let left = netOf(check)
		const taken = owed.flatMap(({ wage: earlier, excess }) => {
			const amount = min(excess, left)
			left -= amount
			return amount > 0n ? [{ wage: earlier.id, recoveredBy: id, amount }] : []
		})
		const rows = withholding(id, check)
		const after = {
			...facts,
			Wage: [...facts.Wage, wage],
			Withholding: [...facts.Withholding, ...rows],
			Recovery: [...facts.Recovery, ...taken]
		}
		return {
			edits: [
				...Db.insert("Wage", wage),
				...Db.insert("Withholding", ...rows),
				...Db.insert("Recovery", ...taken)
			],
			result: shown(after, id)
		}
	}

const CorrectInput = Schema.Struct({
	paidOn: Day,
	gross: Schema.optional(PositiveMoney),
	fit: Schema.optional(Money),
	roth: Schema.optional(Money)
})
/** Reprice a posted paycheck. FICA moves only with gross, which only the
 * year's latest paycheck may change, so later paychecks never shift.
 * Differences surface as obligations: a wire to top up, an overpayment to
 * recover, a 941-X. */
const correct =
	(request: typeof CorrectInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const wage =
			wageOn(facts, request.paidOn) ?? refuse("WageMissing", `No paycheck on ${formatDate(request.paidOn)}`)
		const current =
			paychecks(facts).find((row) => row.wage.id === wage.id) ?? refuse("WageMissing", "No such paycheck")
		const gross = request.gross ?? wage.gross
		if (
			gross !== wage.gross &&
			facts.Wage.some((row) => row.year === wage.year && row.paidOn.start > request.paidOn)
		)
			refuse("GrossNotLatest", "Gross can change only on the year's latest paycheck")
		const fit = request.fit ?? current.withheld.get("FIT") ?? 0n
		const roth = request.roth ?? wage.roth
		if (roth > wage.roth) requireSigned(facts, wage.year, request.paidOn)
		const check =
			gross === wage.gross
				? fitting({ gross, roth, withheld: new Map([...current.withheld, ["FIT", fit]]) })
				: priceCheck(
						limitsFor(facts, wage.year),
						current.bands,
						undefined,
						current.ytd,
						request.paidOn,
						{ by: "gross", gross, roth },
						fit
					)
		if (same(facts, wage, check)) return { edits: [], result: paycheck(facts, wage.id) }
		const corrected = { ...wage, gross, roth }
		const old = facts.Withholding.filter((row) => row.wage === wage.id)
		const rows = withholding(wage.id, check)
		const after = {
			...facts,
			Wage: facts.Wage.map((row) => (row.id === wage.id ? corrected : row)),
			Withholding: [...facts.Withholding.filter((row) => row.wage !== wage.id), ...rows]
		}
		if (paychecks(after).some((row) => row.wage.id === wage.id && row.net < 0n))
			refuse("NetNegative", "The corrected paycheck can't cover what it already recovered from earlier ones")
		return {
			edits: [
				...replace("Wage", wage, corrected),
				...rows.flatMap((row) =>
					replace(
						"Withholding",
						old.find((each) => each.tax === row.tax),
						row
					)
				)
			],
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
						request.kind === "NetPay" ? [check.sentNet, check.owedNet] : [check.sentRoth, check.roth]
					if (!recorded && sent + amount > owed)
						refuse(
							"Overpaid",
							`${formatDate(request.paidOn)} has ${formatDollars(owed - sent)} of ${kind} unsent`
						)
					return Db.insert(request.kind, { transfer: mercury, wage: wage.id, amount })
				}
				case "AfterTax": {
					const year = BigInt(request.year)
					const room = afterTaxRoom(facts, year)
					if (!recorded && room !== undefined && amount > room)
						refuse(
							"Over415c",
							`At most ${formatDollars(max(0n, room))} more after-tax fits ${year}: the election and 415(c), the salary target standing in for pay to come`
						)
					return Db.insert("AfterTax", { transfer: mercury, year, amount })
				}
				case "Distribution":
					return Db.insert("Distribution", { transfer: mercury, amount })
			}
		}
		return { edits: [...Db.insert("Transfer", { mercury, sentOn, kind }), ...arm()], result: request }
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
	requirePeriod(period, S.TaxAccount.axioms[account].period)
	return {
		edits: [
			...Db.insert("TaxPayment", {
				tracker,
				account,
				kind,
				period,
				amount,
				initiatedOn: point(initiatedOn),
				funding: "Mercury"
			}),
			...Db.insert("Transfer", { mercury, sentOn, kind: "Tax" }),
			...Db.insert("TaxDebit", { transfer: mercury, payment: tracker })
		],
		result: request
	}
}

// ── the plan's books ───────────────────────────────────────────────────────

const RolloverInput = Schema.Struct({
	account: Schema.Literals(S.PlanAccount.handles),
	on: Day,
	gross: PositiveMoney
})
/** A whole-account sweep into the owner's Roth IRA. What it carries, and what
 * the 1099-R reports for it, follow from the wires since the last sweep. */
const rollover =
	(request: typeof RolloverInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		if (S.PlanAccount.axioms[request.account].implied)
			refuse(
				"ImpliedConversion",
				`Carry converts the ${request.account} account as deposits settle; its 1099-R follows from its transfers`
			)
		const row = { account: request.account, on: request.on, gross: request.gross }
		const others = facts.Rollover.filter((old) => old.account !== row.account || old.on !== row.on)
		const swept = sweeps({ ...facts, Rollover: [...others, row] }).find(
			(sweep) => sweep.account === row.account && sweep.on === row.on
		)
		return { edits: Db.insert("Rollover", row), result: { ...request, ...swept } }
	}

// ── filings ────────────────────────────────────────────────────────────────

const filed = { form: Schema.Literals(S.Form.handles), period: Period }
const FilingInput = Schema.Union([
	Schema.Struct({ ...filed, method: Schema.Literal("Electronic"), on: Day, confirmation: Text }),
	Schema.Struct({ ...filed, method: Schema.Literal("CertifiedMail"), mailedOn: Day, tracking: Text }),
	Schema.Struct({ ...filed, method: Schema.Literal("Furnished"), on: Day })
])
type FilingInput = typeof FilingInput.Type

/** The day a return was filed, by its method; an attested one has none. */
const filedOn = (facts: Facts, filing: Uuid) =>
	facts.Electronic.find((row) => row.filing === filing)?.on ??
	facts.CertifiedMail.find((row) => row.filing === filing)?.mailedOn ??
	facts.Furnished.find((row) => row.filing === filing)?.on
/** A USPS tracking number names one mailing: a return or a correction. */
const mailedUnder = (facts: Facts, tracking: string) =>
	facts.CertifiedMail.some((row) => row.tracking === tracking) ||
	facts.Correction.some((row) => row.tracking === tracking)
/** Whether a return is recorded exactly as this request records it. */
const recordedAs = (facts: Facts, filing: Fact<typeof S.Filing>, request: FilingInput) => {
	if (filing.method !== request.method) return false
	switch (request.method) {
		case "Electronic":
			return facts.Electronic.some(
				(row) =>
					row.filing === filing.id && row.on === request.on && row.confirmation === request.confirmation
			)
		case "CertifiedMail":
			return facts.CertifiedMail.some(
				(row) =>
					row.filing === filing.id && row.mailedOn === request.mailedOn && row.tracking === request.tracking
			)
		case "Furnished":
			return facts.Furnished.some((row) => row.filing === filing.id && row.on === request.on)
	}
}

/** A return as filed: how, and every line as the ledger computes it now.
 * What is filed must equal the ledger; fix the ledger first if it doesn't.
 * A return is filed once its period is over: filed early, it would freeze a
 * period's liability before its paychecks were all paid. Recording it again
 * is no change, whatever has happened since. */
const fileReturn =
	(request: FilingInput) =>
	(facts: Facts): Db.Plan<object> => {
		const { form, period, method } = request
		requirePeriod(period, S.Form.axioms[form].period)
		const recorded = facts.Filing.find((row) => row.form === form && sameSpan(row.period, period))
		if (recorded && recordedAs(facts, recorded, request)) return { edits: [], result: request }
		if (recorded) refuse("Filed", `${form} ${formatPeriod(period)} is already recorded`)
		if ((request.method === "CertifiedMail" ? request.mailedOn : request.on) < period.end)
			refuse("PeriodOpen", `${form} ${formatPeriod(period)} can be filed once the period is over`)
		if (request.method === "CertifiedMail" && mailedUnder(facts, request.tracking))
			refuse("TrackingUsed", `Tracking ${request.tracking} already names another mailing`)
		const id = filingId(form, period)
		const lines = [...figures(form, periodOf(facts, period))].map(([line, value]) => ({
			filing: id,
			line,
			value
		}))
		return {
			edits: [
				...Db.insert("Filing", { id, form, period, method }),
				...(request.method === "Electronic"
					? Db.insert("Electronic", { filing: id, on: request.on, confirmation: request.confirmation })
					: request.method === "CertifiedMail"
						? Db.insert("CertifiedMail", {
								filing: id,
								mailedOn: request.mailedOn,
								tracking: request.tracking
							})
						: Db.insert("Furnished", { filing: id, on: request.on })),
				...Db.insert("FiledFigures", ...lines)
			],
			result: request
		}
	}

/** The returns a correction can be filed for: those with correctable lines. */
const correctableForms = S.Form.handles.filter((form) =>
	S.correctable.some((line) => S.Line.axioms[line].form === form)
)
const CorrectionInput = Schema.Struct({
	form: Schema.Literals(correctableForms),
	period: Period,
	mailedOn: Day,
	tracking: Text
})
/** A correction mailed for a filed return: a 941-X, or corrected 1099-Rs with
 * their own 1096. It restates each correctable line the ledger now computes
 * differently; every other line stands as filed. */
const correctReturn =
	(request: typeof CorrectionInput.Type) =>
	(facts: Facts): Db.Plan<object> => {
		const { form, period, mailedOn, tracking } = request
		requirePeriod(period, S.Form.axioms[form].period)
		const filing =
			facts.Filing.find((row) => row.form === form && sameSpan(row.period, period)) ??
			refuse("FilingMissing", `No ${form} is recorded for ${formatPeriod(period)}`)
		const mailed = facts.Correction.find((row) => row.filing === filing.id)
		if (mailed?.mailedOn === mailedOn && mailed.tracking === tracking) return { edits: [], result: request }
		if (mailed) refuse("Corrected", `${form} ${formatPeriod(period)} already has a correction`)
		const after = max(period.end, filedOn(facts, filing.id) ?? period.end)
		if (mailedOn < after)
			refuse("BeforeFiling", `${form} ${formatPeriod(period)} can be corrected from ${formatDate(after)} on`)
		if (mailedUnder(facts, tracking))
			refuse("TrackingUsed", `Tracking ${tracking} already names another mailing`)
		const due = correctionDue(facts, filing)
		if (due.size === 0)
			refuse("NothingToCorrect", `${form} ${formatPeriod(period)} as filed matches what it reports`)
		return {
			edits: [
				...Db.insert("Correction", { filing: filing.id, mailedOn, tracking }),
				...Db.insert(
					"CorrectedFigures",
					...[...due].map(([line, value]) => ({ filing: filing.id, line, value }))
				)
			],
			result: request
		}
	}

// ── setup and policy ───────────────────────────────────────────────────────

const states = S.Jurisdiction.handles.filter((handle) => S.Jurisdiction.axioms[handle].state)
const PartyInput = Schema.Struct({ name: Text, tin: Text, address: Text })
const SetupInput = Schema.Struct({
	employer: PartyInput,
	employee: PartyInput,
	plan: PartyInput,
	registrations: Schema.Array(Schema.Struct({ state: Schema.Literals(states), number: Text })),
	employment: Schema.Struct({ from: Day, state: Schema.Literals(states) }),
	custody: Schema.Struct({
		Pretax: Schema.Struct({ custodian: Text, number: Text }),
		AfterTax: Schema.Struct({ custodian: Text, number: Text }),
		Roth: Schema.Struct({ custodian: Text, number: Text })
	})
})

const banded = (jurisdiction: S.JurisdictionHandle) =>
	S.Tax.handles.filter((tax) => S.Tax.axioms[tax].banded && jurisdictionOf(tax) === jurisdiction)
const BandInput = Schema.Struct({ rate: Rate, base: Schema.optional(PositiveMoney) })
const Limits = Schema.Struct({
	deferralLimit: Money,
	additionsLimit: Money,
	compensationLimit: Money,
	wageCeiling: Money
})
const rates = (jurisdiction: S.JurisdictionHandle) =>
	Schema.Struct(Object.fromEntries(banded(jurisdiction).map((tax) => [tax, BandInput])))
/** One jurisdiction's policy for a year: the federal limits, and a rate and
 * optional wage base for each banded tax the jurisdiction levies. */
const PolicyInput = Schema.Union([
	Schema.Struct({
		jurisdiction: Schema.Literal("Federal"),
		year: Year,
		limits: Limits,
		rates: rates("Federal")
	}),
	...states.map((state) =>
		Schema.Struct({ jurisdiction: Schema.Literal(state), year: Year, rates: rates(state) })
	)
])
type PolicyInput = {
	readonly jurisdiction: S.JurisdictionHandle
	readonly year: number
	readonly limits?: typeof Limits.Type
	readonly rates: { readonly [tax: string]: typeof BandInput.Type | undefined }
}

/** The one invariant bumbledb can't state over two columns: the Roth and
 * after-tax elections together stay within 415(c). */
const within415 = (
	election: { roth: bigint; afterTax: bigint } | undefined,
	limits: { additionsLimit: bigint } | undefined
) => {
	if (election && limits && election.roth + election.afterTax > limits.additionsLimit)
		refuse(
			"Over415c",
			`Roth plus after-tax elections exceed the ${formatDollars(limits.additionsLimit)} 415(c) limit`
		)
}

/** A withheld tax's band never changes in a way that would withhold a posted
 * paycheck differently. An employer's own rate, such as a Texas UI rate
 * assigned late, may change; its returns follow. */
const keepsWithholding = (
	facts: Facts,
	old: Fact<typeof S.TaxBand> | undefined,
	band: Fact<typeof S.TaxBand>
) => {
	if (old === undefined || !S.Tax.axioms[band.tax].employee) return
	const state = jurisdictionOf(band.tax)
	const withheld = (under: Fact<typeof S.TaxBand>, ytd: bigint, gross: bigint) =>
		assess([under], ytd, gross).get(band.tax) ?? 0n
	const moved = paychecks(facts).find(
		(check) =>
			check.wage.year === band.year &&
			(state === "Federal" || check.state === state) &&
			withheld(band, check.ytd, check.gross) !== withheld(old, check.ytd, check.gross)
	)
	if (moved)
		refuse(
			"PolicyInUse",
			`The ${formatDate(moved.wage.paidOn.start)} paycheck withheld ${band.tax} under the ${band.year} band in force; it can't change now`
		)
}

/** Replace one jurisdiction's policy for a year whole; the laws judge it. */
const setPolicy =
	(request: PolicyInput) =>
	(facts: Facts): Db.Plan<object> => {
		const year = BigInt(request.year)
		const limits = request.limits && { year, span: yearSpan(request.year), ...request.limits }
		if (limits)
			within415(
				facts.Election.find((election) => election.year === year),
				limits
			)
		return {
			edits: [
				...(limits
					? replace(
							"TaxYear",
							facts.TaxYear.find((old) => old.year === year),
							limits
						)
					: []),
				...banded(request.jurisdiction).flatMap((tax) => {
					const band = request.rates[tax] ?? refuse("RateMissing", `Give the ${tax} rate`)
					const old = facts.TaxBand.find((row) => row.year === year && row.tax === tax)
					const next = { year, tax, wages: { start: 0n, end: band.base ?? MAX_U64 }, rate: band.rate }
					keepsWithholding(facts, old, next)
					return replace("TaxBand", old, next)
				})
			],
			result: request
		}
	}

const PlanInput = Schema.Struct({ year: Year, salary: PositiveMoney, fitPerCheck: Money })
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

const ElectionInput = Schema.Struct({ year: Year, roth: Money, afterTax: Money, signedOn: Day })
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
			facts.TaxYear.find((limits) => limits.year === row.year)
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
	setup: op(
		"Create the ledger: the employer, its employee, the plan, where the owner works, and the plan's accounts",
		SetupInput,
		(input, ledger) =>
			Db.build(ledger, {
				edits: [
					...Db.insert("Party", { role: "Employer", ...input.employer }),
					...Db.insert("Party", { role: "Employee", ...input.employee }),
					...Db.insert("Party", { role: "Plan", ...input.plan }),
					...Db.insert("Registration", ...input.registrations),
					...Db.insert("Employment", {
						span: { start: input.employment.from, end: MAX_I64 },
						state: input.employment.state
					}),
					...Db.insert(
						"Custody",
						...S.PlanAccount.handles.map((account) => ({ account, ...input.custody[account] }))
					)
				],
				result: input
			})
	),
	"policy.set": op(
		"Set one jurisdiction's policy for a year: federal limits, and each tax's rate and wage base",
		PolicyInput,
		writing((input: PolicyInput) => setPolicy(input))
	),
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
	"plan.rollover": op(
		"Record a whole-account sweep of a plan account into the Roth IRA",
		RolloverInput,
		writing(rollover)
	),
	"filing.record": op("Record a filed return with every line as filed", FilingInput, writing(fileReturn)),
	"filing.correct": op(
		"Record a mailed correction: a 941-X, or corrected 1099-Rs with their 1096",
		CorrectionInput,
		writing(correctReturn)
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
