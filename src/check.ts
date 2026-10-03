import type { Fact } from "@bjornpagen/bumbledb"
import { PPM } from "./core/boundary.ts"
import { covers, type Span } from "./core/time.ts"
import { max, min, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import {
	type JurisdictionHandle,
	Tax,
	TaxAccount,
	type TaxBand,
	type TaxHandle,
	type Wage
} from "./schema.ts"

/* A paycheck's money. Gross is stored; a paycheck's place on the year's wage
 * axis, [ytd, ytd + gross), follows from the gross paid on earlier days. Each
 * banded tax applies to the slice of that range inside its band, at its rate. */

export type Band = Fact<typeof TaxBand>

/** weighted / denominator to the nearest integer, ties away from zero. */
export const nearest = (weighted: bigint, denominator: bigint): bigint => {
	const magnitude =
		(2n * (weighted < 0n ? -weighted : weighted) + (denominator < 0n ? -denominator : denominator)) /
		(2n * (denominator < 0n ? -denominator : denominator))
	return weighted < 0n !== denominator < 0n ? -magnitude : magnitude
}

export const jurisdictionOf = (tax: TaxHandle): JurisdictionHandle =>
	TaxAccount.axioms[Tax.axioms[tax].account].jurisdiction
/** Taxes withheld by assessment: banded and borne by the employee. FIT is
 * supplied with each paycheck instead. */
export const assessed = Tax.handles.filter((tax) => Tax.axioms[tax].employee && Tax.axioms[tax].banded)

/** The bands a paycheck pays under: its year's federal bands and its state's. */
export const bandsFor = (facts: Facts, year: bigint, state: JurisdictionHandle | undefined) =>
	facts.TaxBand.filter(
		(band) =>
			band.year === year && (jurisdictionOf(band.tax) === "Federal" || jurisdictionOf(band.tax) === state)
	)
/** Where the owner works on a day, if employed. */
export const stateOn = (facts: Facts, day: bigint) =>
	facts.Employment.find((employment) => covers(employment.span, day))?.state

/** |[ytd, ytd + gross) ∩ wages|: the part of a paycheck inside a band. */
export const subjectTo = (wages: Span, ytd: bigint, gross: bigint) =>
	max(0n, min(wages.end, ytd + gross) - max(wages.start, ytd))

/** What each assessed tax takes from a paycheck: its slice at its rate,
 * rounded once. */
export const assess = (bands: readonly Band[], ytd: bigint, gross: bigint): Map<TaxHandle, bigint> =>
	new Map(
		bands
			.filter((band) => assessed.includes(band.tax))
			.map((band) => [band.tax, nearest(subjectTo(band.wages, ytd, gross) * band.rate, PPM)])
	)

/** A paycheck as priced: gross, Roth and every employee tax withheld. */
export type Check = {
	readonly gross: bigint
	readonly roth: bigint
	readonly withheld: ReadonlyMap<TaxHandle, bigint>
}
export const price = (
	bands: readonly Band[],
	ytd: bigint,
	gross: bigint,
	fit: bigint,
	roth: bigint
): Check => ({
	gross,
	roth,
	withheld: new Map([["FIT", fit], ...assess(bands, ytd, gross)])
})
/** Net pay before recovering any earlier overpayment. */
export const netOf = (check: Check) => check.gross - check.roth - sum(check.withheld.values())

/** A posted paycheck and its derived money. It is settled when sentNet =
 * owedNet and sentRoth = roth. */
export type Paycheck = Check & {
	readonly wage: Fact<typeof Wage>
	/** The year's gross paid on earlier days. */
	readonly ytd: bigint
	/** Where the owner worked when paid. */
	readonly state: JurisdictionHandle | undefined
	readonly bands: readonly Band[]
	/** netOf minus what this paycheck recovered from earlier ones. */
	readonly net: bigint
	/** net plus what later paychecks recovered from this one. */
	readonly owedNet: bigint
	readonly sentNet: bigint
	readonly sentRoth: bigint
}

/** Every posted paycheck, in pay-date order. */
export const paychecks = (facts: Facts): Paycheck[] => {
	const total = (rows: readonly { readonly amount: bigint }[]) => sum(rows.map((row) => row.amount))
	const earned = new Map<bigint, bigint>()
	return [...facts.Wage]
		.sort((a, b) => (a.paidOn.start < b.paidOn.start ? -1 : 1))
		.map((wage) => {
			const ytd = earned.get(wage.year) ?? 0n
			earned.set(wage.year, ytd + wage.gross)
			const check: Check = {
				gross: wage.gross,
				roth: wage.roth,
				withheld: new Map(
					facts.Withholding.filter((row) => row.wage === wage.id).map((row) => [row.tax, row.amount])
				)
			}
			const net = netOf(check) - total(facts.Recovery.filter((row) => row.recoveredBy === wage.id))
			const state = stateOn(facts, wage.paidOn.start)
			return {
				...check,
				wage,
				ytd,
				state,
				bands: bandsFor(facts, wage.year, state),
				net,
				owedNet: net + total(facts.Recovery.filter((row) => row.wage === wage.id)),
				sentNet: total(facts.NetPay.filter((row) => row.wage === wage.id)),
				sentRoth: total(facts.RothDeferral.filter((row) => row.wage === wage.id))
			}
		})
}
