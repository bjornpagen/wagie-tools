import { paychecks } from "./check.ts"
import { formatDollars } from "./core/boundary.ts"
import { covers, quarterSpan, type Span, sameSpan, yearOf, yearSpan } from "./core/time.ts"
import { MAX_U64, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import { correction, figures, formatLine, periodOf } from "./forms.ts"
import { sweeps } from "./plan.ts"
import { Form, type FormHandle, Jurisdiction, type LineHandle, type Role } from "./schema.ts"

/* A period's returns as the ledger computes them, headed by who they name,
 * with the sums and rows behind them. */

/** Who each form names, the filer first. */
const named: { readonly [F in FormHandle]: readonly (typeof Role.handles)[number][] } = {
	F941: ["Employer"],
	F940: ["Employer"],
	W2: ["Employer", "Employee"],
	W3: ["Employer"],
	C3: ["Employer"],
	F1099R: ["Plan", "Employee"],
	F1096: ["Plan"]
}

const lineValues = (values: ReadonlyMap<LineHandle, bigint>) =>
	Object.fromEntries([...values].map(([line, value]) => [line, formatLine(line, value)]))

/** A 941-X: each correctable line as filed and as corrected, and the tax each
 * difference carries; line 27 is their sum. */
const corrected = (facts: Facts, span: Span) => {
	const filing = facts.Filing.find((row) => row.form === "F941" && sameSpan(row.period, span))
	const mailed = filing && facts.Correction.find((row) => row.filing === filing.id)
	if (!filing || !mailed) return undefined
	const { rows, owed } = correction(facts, filing.id)
	return {
		mailedOn: mailed.mailedOn,
		tracking: mailed.tracking,
		lines: rows.map((row) => ({
			line: row.line,
			original: formatLine(row.line, row.original),
			corrected: formatLine(row.line, row.corrected),
			difference: formatLine(row.line, row.difference),
			tax: formatDollars(row.tax)
		})),
		line27: formatDollars(owed)
	}
}

export const report = (facts: Facts, year: number, quarter?: number) => {
	const span = quarter === undefined ? yearSpan(year) : quarterSpan(year, quarter)
	const period = periodOf(facts, span)
	const forms = Form.handles.filter(
		(form) => (Form.axioms[form].period === "Quarter") === (quarter !== undefined)
	)
	const party = (role: (typeof Role.handles)[number]) => facts.Party.find((row) => row.role === role)
	const transfer = (mercury: string) => facts.Transfer.find((row) => row.mercury === mercury)
	const sentIn = (mercury: string) => {
		const found = transfer(mercury)
		return found !== undefined && covers(span, found.sentOn)
	}
	const distributions = [
		...facts.Distribution.filter((row) => sentIn(row.transfer)).map((row) => ({
			kind: "Distribution",
			...row
		})),
		...facts.AfterTax.filter((row) => sentIn(row.transfer)).map((row) => ({ kind: "AfterTax", ...row }))
	]
		.map(({ transfer: mercury, kind, amount }) => ({
			mercury,
			sentOn: transfer(mercury)?.sentOn ?? 0n,
			kind,
			amount
		}))
		.sort((a, b) => (a.sentOn < b.sentOn ? -1 : a.sentOn > b.sentOn ? 1 : a.mercury.localeCompare(b.mercury)))
	const debit = (tracker: string) => facts.TaxDebit.find((row) => row.payment === tracker)
	const limits = facts.TaxYear.find((row) => row.year === BigInt(year))
	return {
		period: span,
		policy: {
			...(limits && {
				deferralLimit: limits.deferralLimit,
				additionsLimit: limits.additionsLimit,
				compensationLimit: limits.compensationLimit,
				wageCeiling: limits.wageCeiling
			}),
			bands: facts.TaxBand.filter((band) => band.year === BigInt(year)).map((band) => ({
				tax: band.tax,
				rate: band.rate,
				...(band.wages.end === MAX_U64 ? {} : { base: band.wages.end })
			}))
		},
		totals: {
			count: BigInt(period.checks.length),
			gross: sum(period.checks.map((check) => check.gross)),
			fit: sum(period.checks.map((check) => check.withheld.get("FIT") ?? 0n)),
			ss: sum(period.checks.map((check) => check.withheld.get("SocialSecurity") ?? 0n)),
			medicare: sum(period.checks.map((check) => check.withheld.get("Medicare") ?? 0n)),
			roth: sum(period.checks.map((check) => check.roth)),
			owedNet: sum(period.checks.map((check) => check.owedNet)),
			sentNet: sum(period.checks.map((check) => check.sentNet))
		},
		forms: Object.fromEntries(
			forms.map((form) => {
				const state = Form.axioms[form].jurisdiction
				const account = Jurisdiction.axioms[state].state
					? facts.Registration.find((row) => row.state === state)?.number
					: undefined
				return [
					form,
					{
						names: named[form].flatMap((role) => {
							const found = party(role)
							return found ? [{ role, name: found.name, tin: found.tin, address: found.address }] : []
						}),
						...(account === undefined ? {} : { account }),
						lines: lineValues(figures(form, period))
					}
				]
			})
		),
		...(quarter === undefined
			? {
					sweeps: sweeps(facts)
						.filter((sweep) => yearOf(sweep.on) === year)
						.map(({ account, on, gross, taxable, basis }) => ({ account, on, gross, taxable, basis }))
				}
			: { correction: corrected(facts, span) }),
		paychecks: paychecks(facts)
			.filter((check) => covers(span, check.wage.paidOn.start))
			.map((check) => ({
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
				sentRoth: check.sentRoth
			})),
		distributions: { amount: sum(distributions.map((row) => row.amount)), transfers: distributions },
		taxPayments: facts.TaxPayment.filter((row) => row.initiatedOn.start < span.end)
			.map((row) => {
				const mercury = debit(row.tracker)?.transfer
				return {
					tracker: row.tracker,
					account: row.account,
					kind: row.kind,
					period: row.period,
					amount: row.amount,
					initiatedOn: row.initiatedOn.start,
					mercury: mercury ?? "outside Mercury",
					...(mercury === undefined ? {} : { sentOn: transfer(mercury)?.sentOn ?? 0n })
				}
			})
			.sort((a, b) =>
				a.initiatedOn < b.initiatedOn
					? -1
					: a.initiatedOn > b.initiatedOn
						? 1
						: a.tracker.localeCompare(b.tracker)
			)
	}
}
