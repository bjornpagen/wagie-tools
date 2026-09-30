import type { Uuid } from "@bjornpagen/bumbledb"
import { Effect, Option } from "effect"
import { Refusal } from "./core/values.ts"
import { relationRows } from "./queries.ts"
import { settlePaycheck } from "./recoveries.ts"
import type { Snapshot } from "./runtime.ts"
import * as S from "./schema.ts"

type Claim = Parameters<typeof settlePaycheck>[3][number]

/** Round weighted/denominator to the nearest integer, ties away from zero —
 * the rounding mode `calculatedAmounts` passes to the native `mulDiv`. */
const nearest = (weighted: bigint, denominator: bigint) => (2n * weighted + denominator) / (2n * denominator)

/** A search probe only. RothOnly uses it to choose a gross; the calculation it
 * then stores is priced by the native engine (calculations.ts), and posting
 * refuses unless that native paycheck is exactly zero cash. It reads the same
 * stored bands and applies the same slice/weight/round-once rule. */
const probe = (
	schedules: readonly {
		denominator: bigint
		bands: readonly { start: bigint; end: bigint; numerator: bigint }[]
	}[],
	earning: { start: bigint; end: bigint }
) =>
	schedules.reduce((total, schedule) => {
		const weighted = schedule.bands.reduce((sum, band) => {
			const start = band.start > earning.start ? band.start : earning.start
			const end = band.end < earning.end ? band.end : earning.end
			return end > start ? sum + (end - start) * band.numerator : sum
		}, 0n)
		return total + nearest(weighted, schedule.denominator)
	}, 0n)

/** Smallest gross whose paycheck leaves exactly zero cash after current
 * employee tax, the supplied FIT, automatic recovery of prior employee FICA,
 * and the requested Roth. Nothing is written. */
export const solveRothOnlyGross = (options: {
	snapshot: Snapshot
	employeeSchedules: readonly Uuid[]
	prior: bigint
	fit: bigint
	roth: bigint
	claims: readonly Claim[]
}) =>
	Effect.gen(function* () {
		if (options.roth <= 0n)
			return yield* Effect.fail(
				new Refusal({ code: "RothRequired", message: "Supply a positive Roth amount" })
			)
		const allSchedules = yield* relationRows(options.snapshot, S.RateSchedule)
		const allBands = yield* relationRows(options.snapshot, S.TaxBand)
		const schedules = options.employeeSchedules.map((id) => {
			const schedule = allSchedules.find((row) => row.id === id)
			if (!schedule) throw new Refusal({ code: "RateCoverageMissing", message: `Missing schedule ${id}` })
			return {
				denominator: schedule.denominator,
				bands: allBands
					.filter((row) => row.schedule === id)
					.map((row) => ({ start: row.wages.start, end: row.wages.end, numerator: row.numerator }))
			}
		})
		const cash = (gross: bigint): Option.Option<bigint> => {
			const withheld = probe(schedules, { start: options.prior, end: options.prior + gross }) + options.fit
			if (withheld > gross) return Option.none()
			try {
				return Option.some(settlePaycheck(gross, withheld, options.roth, options.claims).cash)
			} catch {
				return Option.none()
			}
		}
		const nonnegative = (gross: bigint) => {
			const value = cash(gross)
			return Option.isSome(value) && value.value >= 0n
		}
		let high = options.roth + options.fit
		while (!nonnegative(high)) high *= 2n
		let low = 0n
		while (high - low > 1n) {
			const middle = (low + high) / 2n
			if (nonnegative(middle)) high = middle
			else low = middle
		}
		// Per-component rounding can move cash one cent against the trend, so
		// settle on the smallest exact zero near the monotone boundary.
		for (let gross = high > 200n ? high - 200n : 1n; gross <= high + 200n; gross++) {
			const value = cash(gross)
			if (Option.isSome(value) && value.value === 0n) return gross
		}
		return yield* Effect.fail(
			new Refusal({
				code: "RothOnlyUnsolvable",
				message: "No gross near the boundary leaves exactly zero cash; calculate a NewWage explicitly"
			})
		)
	})
