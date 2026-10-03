import { unitFor } from "../schema/units.ts"
import { formatDate, formatPeriod } from "./time.ts"
import { MAX_I64, Refusal } from "./values.ts"

/** Dollars always carry exactly two decimals at the boundary: "8000.00". */
const DOLLARS = /^(-?)(0|[1-9]\d*)\.(\d{2})$/

export const parseDollars = (text: string): bigint => {
	const match = DOLLARS.exec(text)
	if (!match)
		throw new Refusal({
			code: "InvalidMoney",
			message: `Use dollars with two decimals, e.g. "8000.00": ${text}`
		})
	const cents = BigInt(match[2] ?? "") * 100n + BigInt(match[3] ?? "")
	if (match[1] === "-" && cents === 0n)
		throw new Refusal({ code: "InvalidMoney", message: "Negative zero is not a money value" })
	return match[1] === "-" ? -cents : cents
}

export const formatDollars = (cents: bigint): string => {
	const magnitude = cents < 0n ? -cents : cents
	return `${cents < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`
}

/** A rate is a percent at the boundary ("6.2", "1.45") and parts per million
 * inside: a percent carries at most four decimals, so nothing is lost. */
const PERCENT = /^(0|[1-9]\d{0,2})(?:\.(\d{1,4}))?$/
export const PPM = 1_000_000n

export const parsePercent = (text: string): bigint => {
	const match = PERCENT.exec(text)
	const ppm = match && BigInt(match[1] ?? "") * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0"))
	if (ppm === null || ppm > PPM)
		throw new Refusal({
			code: "InvalidRate",
			message: `Use a percent of at most 100 with up to four decimals, e.g. "6.2": ${text}`
		})
	return ppm
}

export const formatPercent = (ppm: bigint): string => {
	const fraction = (ppm % 10_000n).toString().padStart(4, "0").replace(/0+$/, "")
	return fraction ? `${ppm / 10_000n}.${fraction}` : `${ppm / 10_000n}`
}

const isSpan = (value: unknown): value is { start: bigint; end: bigint } =>
	typeof value === "object" &&
	value !== null &&
	Object.keys(value).length === 2 &&
	typeof (value as { start?: unknown }).start === "bigint" &&
	typeof (value as { end?: unknown }).end === "bigint"

/** Encode a read model for JSON. Units come from field names; an integer
 * without a unit refuses rather than print an ambiguous number. */
export const encodeOutput = (value: unknown): unknown => {
	const walk = (item: unknown, name: string | undefined, path: string): unknown => {
		if (typeof item === "bigint") {
			switch (name === undefined ? undefined : unitFor(name)) {
				case "Money":
					return formatDollars(item)
				case "Day":
					return formatDate(item)
				case "Rate":
					return formatPercent(item)
				case "Count":
					return Number(item)
				default:
					throw new Refusal({
						code: "UnitUnclassified",
						message: `No unit for ${path}; add it to src/schema/units.ts`
					})
			}
		}
		if (isSpan(item) && name !== undefined) {
			if (unitFor(name) !== "Period")
				throw new Refusal({
					code: "UnitUnclassified",
					message: `No unit for ${path}; add it to src/schema/units.ts`
				})
			return item.end === MAX_I64 ? `${formatDate(item.start)}/` : formatPeriod(item)
		}
		if (Array.isArray(item)) return item.map((entry, index) => walk(entry, name, `${path}[${index}]`))
		if (typeof item === "object" && item !== null)
			return Object.fromEntries(
				Object.entries(item).map(([key, entry]) => [key, walk(entry, key, `${path}.${key}`)])
			)
		return item
	}
	return walk(value, undefined, "$")
}
