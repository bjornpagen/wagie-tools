import type { Fact } from "@bjornpagen/bumbledb"
import type { Span } from "./core/time.ts"
import { max, min, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import type { TaxYear, Wage } from "./schema.ts"

export type Rules = Fact<typeof TaxYear>
export type Check = {
	readonly earnings: Span
	readonly fit: bigint
	readonly ss: bigint
	readonly medicare: bigint
	readonly roth: bigint
}

/** weighted / denominator to the nearest integer, ties away from zero. */
export const nearest = (weighted: bigint, denominator: bigint) =>
	(2n * weighted + denominator) / (2n * denominator)

/** |earnings ∩ [0, base)|: the part of a paycheck under a wage base. */
export const under = (earnings: Span, base: bigint) => max(0n, min(earnings.end, base) - earnings.start)
export const grossOf = (check: { readonly earnings: Span }) => check.earnings.end - check.earnings.start

/** One paycheck on the year's wage axis, [ytd, ytd + gross). Crossing a wage
 * base is not a case: the slice under it is just shorter. The employer's FICA
 * match equals `ss` and `medicare`. */
export const computeCheck = (rules: Rules, ytd: bigint, gross: bigint, fit: bigint, roth: bigint): Check => {
	const earnings = { start: ytd, end: ytd + gross }
	return {
		earnings,
		fit,
		ss: nearest(under(earnings, rules.ssBase) * rules.ssRate, 10_000n),
		medicare: nearest(gross * rules.medicareRate, 10_000n),
		roth
	}
}

/** Net pay before recovering any earlier overpayment. */
export const netOf = (check: Check) => grossOf(check) - check.fit - check.ss - check.medicare - check.roth

/** A posted paycheck's derived money. A paycheck is settled when
 * sentNet = owedNet and sentRoth = roth. */
export type Paycheck = {
	readonly wage: Fact<typeof Wage>
	/** netOf minus what this paycheck recovered from earlier ones. */
	readonly net: bigint
	/** net plus what later paychecks recovered from this one. */
	readonly owedNet: bigint
	readonly sentNet: bigint
	readonly sentRoth: bigint
}

export const paychecks = (facts: Facts): Paycheck[] => {
	const total = (rows: readonly { readonly amount: bigint }[]) => sum(rows.map((row) => row.amount))
	return facts.Wage.map((wage) => {
		const net = netOf(wage) - total(facts.Recovery.filter((row) => row.recoveredBy === wage.id))
		return {
			wage,
			net,
			owedNet: net + total(facts.Recovery.filter((row) => row.wage === wage.id)),
			sentNet: total(facts.NetPay.filter((row) => row.wage === wage.id)),
			sentRoth: total(facts.RothDeferral.filter((row) => row.wage === wage.id))
		}
	})
}
