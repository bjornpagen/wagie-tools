import { grossOf, paychecks } from "./check.ts"
import { covers, quarterSpan, type Span, sameSpan, yearSpan } from "./core/time.ts"
import { sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import { figures, formatLine, periodOf } from "./forms.ts"
import type { FormHandle, LineHandle } from "./schema.ts"

/* Sums over stored facts, in the shapes the returns ask for. */

const lineValues = (values: ReadonlyMap<LineHandle, bigint>) =>
	Object.fromEntries([...values].map(([line, value]) => [line, formatLine(line, value)]))

/** A 941-X view: what the 941 said, what the correction says, and the ledger now. */
const correction = (facts: Facts, span: Span) => {
	const filing = facts.Filing.find((row) => row.form === "F941" && sameSpan(row.period, span))
	const amended = filing && facts.Correction.find((row) => row.filing === filing.id)
	if (!filing || !amended) return undefined
	const of = (rows: Facts["FiledFigures"]) =>
		new Map(rows.filter((row) => row.filing === filing.id).map((row) => [row.line, row.value] as const))
	const original = of(facts.FiledFigures)
	const corrected = of(facts.CorrectedFigures)
	return {
		mailedOn: amended.mailedOn,
		tracking: amended.tracking,
		lines: [...corrected].map(([line, value]) => ({
			line,
			original: original.has(line) ? formatLine(line, original.get(line) ?? 0n) : "not on file",
			corrected: formatLine(line, value),
			difference: original.has(line) ? formatLine(line, value - (original.get(line) ?? 0n)) : "unknown"
		}))
	}
}

export const report = (facts: Facts, year: number, quarter?: number) => {
	const span = quarter === undefined ? yearSpan(year) : quarterSpan(year, quarter)
	const period = periodOf(facts, span)
	const forms: readonly FormHandle[] =
		quarter === undefined ? ["F940", "W2", "W3", "F1099R", "F1096"] : ["F941", "C3"]
	const checks = paychecks(facts).filter((check) => covers(span, check.wage.paidOn.start))
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
	return {
		period: span,
		totals: {
			count: BigInt(checks.length),
			gross: sum(checks.map((check) => grossOf(check.wage))),
			fit: sum(checks.map((check) => check.wage.fit)),
			ss: sum(checks.map((check) => check.wage.ss)),
			medicare: sum(checks.map((check) => check.wage.medicare)),
			roth: sum(checks.map((check) => check.wage.roth)),
			owedNet: sum(checks.map((check) => check.owedNet)),
			sentNet: sum(checks.map((check) => check.sentNet))
		},
		forms: Object.fromEntries(forms.map((form) => [form, lineValues(figures(form, period))])),
		...(quarter === undefined ? {} : { correction: correction(facts, span) }),
		paychecks: checks.map((check) => ({
			paidOn: check.wage.paidOn.start,
			earnings: check.wage.earnings,
			fit: check.wage.fit,
			ss: check.wage.ss,
			medicare: check.wage.medicare,
			roth: check.wage.roth,
			net: check.net,
			owedNet: check.owedNet,
			sentNet: check.sentNet,
			sentRoth: check.sentRoth
		})),
		distributions: { amount: sum(distributions.map((row) => row.amount)), transfers: distributions },
		taxPayments: facts.TaxPayment.filter((row) => row.initiatedOn < span.end)
			.map((row) => {
				const mercury = debit(row.tracker)?.transfer
				return {
					tracker: row.tracker,
					account: row.account,
					kind: row.kind,
					period: row.period,
					amount: row.amount,
					initiatedOn: row.initiatedOn,
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
