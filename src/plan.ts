import type { Fact } from "@bjornpagen/bumbledb"
import { yearOf } from "./core/time.ts"
import { min, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import { PlanAccount, type PlanAccountHandle, type Rollover } from "./schema.ts"

/* The plan's books. Roth basis enters the plan only as Mercury wires: a
 * RothDeferral, or an AfterTax wire that Carry converts to the Roth account as
 * it settles. Every sweep empties its account, so each cent of Roth basis
 * leaves in the first Roth sweep on or after the day it was sent. */

/** Every wire that put Roth basis into the plan, with the day it was sent. */
const contributions = (facts: Facts) => {
	const sentOn = new Map(facts.Transfer.map((row) => [row.mercury, row.sentOn]))
	return [...facts.RothDeferral, ...facts.AfterTax].map((row) => ({
		sentOn: sentOn.get(row.transfer) ?? 0n,
		amount: row.amount
	}))
}

/** A sweep and the basis it reports (box 5): the wires since the previous
 * sweep of a Roth-basis account, at most its gross. A taxed account has none. */
export type Sweep = Fact<typeof Rollover> & { readonly taxable: bigint; readonly basis: bigint }

export const sweeps = (facts: Facts): Sweep[] => {
	const sent = contributions(facts)
	const last = new Map<PlanAccountHandle, bigint>()
	return [...facts.Rollover]
		.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.account.localeCompare(b.account)))
		.map((sweep) => {
			const since = last.get(sweep.account)
			last.set(sweep.account, sweep.on)
			if (PlanAccount.axioms[sweep.account].taxed) return { ...sweep, taxable: sweep.gross, basis: 0n }
			const carried = sum(
				sent
					.filter((row) => (since === undefined || row.sentOn > since) && row.sentOn <= sweep.on)
					.map((row) => row.amount)
			)
			return { ...sweep, taxable: 0n, basis: min(sweep.gross, carried) }
		})
}

/** Roth basis sent since the last Roth sweep: what the next sweep carries. */
export const awaitingSweep = (facts: Facts) => {
	const roth = facts.Rollover.filter((row) => row.account === "Roth").map((row) => row.on)
	const since = roth.length > 0 ? roth.reduce((a, b) => (a > b ? a : b)) : undefined
	return sum(
		contributions(facts)
			.filter((row) => since === undefined || row.sentOn > since)
			.map((row) => row.amount)
	)
}

/** The first year Roth basis entered the plan, which starts the designated
 * Roth account's 5-taxable-year period (1099-R box 11). */
export const firstRothYear = (facts: Facts): bigint | undefined =>
	contributions(facts)
		.map((row) => BigInt(yearOf(row.sentOn)))
		.reduce<bigint | undefined>(
			(first, year) => (first === undefined || year < first ? year : first),
			undefined
		)

/** A year's 1099-R, one form per account money left: an implied account's
 * conversions follow from its wires; every other account reports its sweeps. */
export const distributions = (facts: Facts, year: bigint) => {
	const swept = sweeps(facts).filter((sweep) => BigInt(yearOf(sweep.on)) === year)
	return PlanAccount.handles.map((account) => {
		if (PlanAccount.axioms[account].implied) {
			const gross = sum(facts.AfterTax.filter((row) => row.year === year).map((row) => row.amount))
			return { account, gross, taxable: 0n, basis: gross }
		}
		const own = swept.filter((sweep) => sweep.account === account)
		return {
			account,
			gross: sum(own.map((sweep) => sweep.gross)),
			taxable: sum(own.map((sweep) => sweep.taxable)),
			basis: sum(own.map((sweep) => sweep.basis))
		}
	})
}
