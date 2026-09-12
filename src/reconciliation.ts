import { signed } from "./core/values.ts"

/** Actual money is explained by full revision/account entries and separately
 * evidenced payment adjustments. Return/form adjustments are not an input.
 */
export function paymentEquation(
	observed: bigint,
	entries: readonly bigint[],
	adjustments: readonly bigint[]
) {
	const liability = entries.reduce((total, value) => signed(total + signed(value)), 0n)
	const adjustment = adjustments.reduce((total, value) => signed(total + signed(value)), 0n)
	const explained = signed(liability + adjustment)
	return {
		observed: signed(observed),
		liability,
		adjustment,
		explained,
		difference: signed(observed - explained)
	}
}
