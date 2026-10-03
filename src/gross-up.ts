import type { Fact } from "@bjornpagen/bumbledb"
import { Schema } from "effect"
import { type Band, type Check, nearest, netOf, price } from "./check.ts"
import { formatDollars } from "./core/boundary.ts"
import { max, min, Refusal, refuse } from "./core/values.ts"
import { Money, PositiveMoney } from "./schema/input.ts"
import type { PayPlan, TaxYear } from "./schema.ts"

/** How a paycheck is sized, parsed once at the boundary. */
export const CheckInput = Schema.Union([
	Schema.Struct({ by: Schema.Literal("gross"), gross: PositiveMoney, roth: Schema.optional(Money) }),
	Schema.Struct({ by: Schema.Literal("net"), net: Money, roth: Schema.optional(Money) }),
	Schema.Struct({ by: Schema.Literal("plan"), roth: Schema.optional(Money) })
])
export type CheckInput = typeof CheckInput.Type

/** The smallest gross whose paycheck nets exactly `net`. One more cent of
 * gross moves net by +1, 0 or −1 (when both FICA roundings tick), so every
 * target is reached: binary-search the boundary, then take the first exact
 * hit just below it. */
export const grossForNet = (
	bands: readonly Band[],
	ytd: bigint,
	fit: bigint,
	roth: bigint,
	net: bigint
): bigint => {
	const netAt = (gross: bigint) => netOf(price(bands, ytd, gross, fit, roth))
	let high = max(1n, net + fit + roth)
	while (netAt(high) < net) high *= 2n
	let low = 0n
	while (high - low > 1n) {
		const middle = (low + high) / 2n
		if (netAt(middle) >= net) high = middle
		else low = middle
	}
	for (let gross = max(1n, high - 200n); gross <= high + 200n; gross++) if (netAt(gross) === net) return gross
	return refuse("NetUnreachable", `No gross nets exactly ${formatDollars(net)}`)
}

/** The gross that keeps the year on its salary target, paying weekly: the
 * remaining salary spread over the days left, so the last check lands on it. */
export const planGross = (
	plan: Fact<typeof PayPlan>,
	year: Fact<typeof TaxYear>,
	ytd: bigint,
	paidOn: bigint
): bigint => {
	const remaining = plan.salary - ytd
	if (remaining <= 0n) return refuse("SalaryReached", `The ${plan.year} salary target is already paid`)
	return min(remaining, max(1n, nearest(remaining * 7n, year.span.end - paidOn)))
}

/** Refuses a paycheck whose withholding exceeds its gross, or whose Roth
 * doesn't fit in what is left. */
export const fitting = (check: Check): Check => {
	const room = netOf(check) + check.roth
	if (room < 0n)
		throw new Refusal({ code: "WithholdingExceedsGross", message: "FIT and FICA exceed the gross" })
	if (check.roth > room)
		throw new Refusal({ code: "RothTooLarge", message: `At most ${formatDollars(room)} of Roth fits` })
	return check
}

/** Size and price one paycheck. */
export const priceCheck = (
	year: Fact<typeof TaxYear>,
	bands: readonly Band[],
	plan: Fact<typeof PayPlan> | undefined,
	ytd: bigint,
	paidOn: bigint,
	input: CheckInput,
	fit: bigint
): Check => {
	const roth = input.roth ?? 0n
	const gross =
		input.by === "gross"
			? input.gross
			: input.by === "net"
				? grossForNet(bands, ytd, fit, roth, input.net)
				: planGross(
						plan ?? refuse("PayPlanMissing", `Set the ${year.year} pay plan: plan.set`),
						year,
						ytd,
						paidOn
					)
	return fitting(price(bands, ytd, gross, fit, roth))
}
