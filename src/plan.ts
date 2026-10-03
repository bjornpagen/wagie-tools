import type { Fact } from "@bjornpagen/bumbledb"
import { yearOf } from "./core/time.ts"
import { min, sum } from "./core/values.ts"
import type { Facts } from "./db.ts"
import { PlanAccount, type PlanAccountHandle, type Rollover } from "./schema.ts"

/* The plan's books. Roth basis enters the plan only as Mercury wires: a
 * RothDeferral, or an AfterTax wire that Carry converts to the Roth account as
 * it settles. Every sweep empties its account, so each cent of Roth basis
 * leaves in the first Roth sweep on or after the day it was sent. */

/** Every wire that put Roth basis into the plan, with the day it was sent and
 * the tax year it was contributed for: a Roth deferral, for its paycheck's
 * year, or an after-tax wire, which Carry converts as it settles, for the
 * year it was sent. */
const contributions = (facts: Facts) => {
	const sentOn = new Map(facts.Transfer.map((row) => [row.mercury, row.sentOn]))
	const paidIn = new Map(facts.Wage.map((row) => [row.id, row.year]))
	const deferred = facts.RothDeferral.map((row) => {
		const on = sentOn.get(row.transfer) ?? 0n
		return {
			sentOn: on,
			amount: row.amount,
			converted: false,
			year: paidIn.get(row.wage) ?? BigInt(yearOf(on))
		}
	})
	const converted = facts.AfterTax.map((row) => {
		const on = sentOn.get(row.transfer) ?? 0n
		return { sentOn: on, amount: row.amount, converted: true, year: BigInt(yearOf(on)) }
	})
	return [...deferred, ...converted]
}

/** Each after-tax wire as the in-plan Roth rollover Carry makes of it when
 * it settles: dated the day it was sent, whatever plan year it counts toward. */
export const conversions = (facts: Facts) =>
	contributions(facts)
		.filter((row) => row.converted)
		.map((row) => ({ on: row.sentOn, amount: row.amount }))

/** A sweep and the basis it reports (box 5): the wires since the previous
 * sweep of a Roth-basis account, at most its gross. Of that basis, what came
 * from conversions in the sweep's year or the four before it is allocable to
 * an in-plan Roth rollover within 5 years (box 10). A taxed account has
 * neither. */
export type Sweep = Fact<typeof Rollover> & {
	readonly taxable: bigint
	readonly basis: bigint
	readonly converted: bigint
}

export const sweeps = (facts: Facts): Sweep[] => {
	const sent = contributions(facts)
	const last = new Map<PlanAccountHandle, bigint>()
	return [...facts.Rollover]
		.sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.account.localeCompare(b.account)))
		.map((sweep) => {
			const since = last.get(sweep.account)
			last.set(sweep.account, sweep.on)
			if (PlanAccount.axioms[sweep.account].taxed)
				return { ...sweep, taxable: sweep.gross, basis: 0n, converted: 0n }
			const carried = sent.filter(
				(row) => (since === undefined || row.sentOn > since) && row.sentOn <= sweep.on
			)
			const basis = min(sweep.gross, sum(carried.map((row) => row.amount)))
			const recent = carried.filter((row) => row.converted && row.year + 4n >= BigInt(yearOf(sweep.on)))
			return { ...sweep, taxable: 0n, basis, converted: min(basis, sum(recent.map((row) => row.amount))) }
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

/** The first tax year Roth basis was contributed for, which starts the
 * designated Roth account's 5-taxable-year period (1099-R box 11): a December
 * paycheck's Roth wired in January counts for December's year. */
export const firstRothYear = (facts: Facts): bigint | undefined =>
	contributions(facts)
		.map((row) => row.year)
		.reduce<bigint | undefined>(
			(first, year) => (first === undefined || year < first ? year : first),
			undefined
		)

/** A year's 1099-R, one form per account money left: an implied account
 * reports the year's conversions; every other account reports its sweeps. */
export const distributions = (facts: Facts, year: bigint) => {
	const swept = sweeps(facts).filter((sweep) => BigInt(yearOf(sweep.on)) === year)
	return PlanAccount.handles.map((account) => {
		if (PlanAccount.axioms[account].implied) {
			const gross = sum(
				conversions(facts)
					.filter((row) => BigInt(yearOf(row.on)) === year)
					.map((row) => row.amount)
			)
			return { account, gross, taxable: 0n, basis: gross, converted: 0n }
		}
		const own = swept.filter((sweep) => sweep.account === account)
		return {
			account,
			gross: sum(own.map((sweep) => sweep.gross)),
			taxable: sum(own.map((sweep) => sweep.taxable)),
			basis: sum(own.map((sweep) => sweep.basis)),
			converted: sum(own.map((sweep) => sweep.converted))
		}
	})
}
