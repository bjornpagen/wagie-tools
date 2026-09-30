import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { unitFor } from "../schema/units.ts"
import { epochDay, formatCalendarDate } from "./time.ts"
import { MAX_U64, Refusal } from "./values.ts"

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
	const sign = cents < 0n ? "-" : ""
	const magnitude = cents < 0n ? -cents : cents
	return `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}`
}

/** String dollars decoding to integer cents. Range and sign are checked by the
 * native field codec that consumes the result. */
export const Dollars = Schema.String.check(Schema.isPattern(DOLLARS))
	.annotate({ description: 'Dollars with exactly two decimals, e.g. "8000.00"' })
	.pipe(
		Schema.decodeTo(Schema.BigInt, {
			decode: SchemaGetter.transformOrFail((text: string) =>
				Effect.try({
					try: () => parseDollars(text),
					catch: () =>
						new SchemaIssue.InvalidValue({ message: `Use dollars with two decimals, e.g. "8000.00"` })
				})
			),
			encode: SchemaGetter.transform(formatDollars)
		})
	)

const formatMoneyEnd = (cents: bigint) => (cents === MAX_U64 ? "Infinity" : formatDollars(cents))
const day = (value: bigint) => formatCalendarDate(epochDay(value))

const isInterval = (value: unknown): value is { start: bigint; end: bigint } =>
	typeof value === "object" &&
	value !== null &&
	Object.keys(value).length === 2 &&
	typeof (value as { start?: unknown }).start === "bigint" &&
	typeof (value as { end?: unknown }).end === "bigint"

/** Encode one read model for JSON. Units come from field names; evidence
 * statement ids resolve to their text. An unclassified integer refuses. */
export const encodeOutput = (value: unknown, statements: ReadonlyMap<string, string>): unknown => {
	const walk = (item: unknown, name: string | undefined, path: string): unknown => {
		if (typeof item === "bigint") {
			const unit = name === undefined ? undefined : unitFor(name)
			switch (unit) {
				case "Money":
					return formatDollars(item)
				case "Day":
				case "DayPoint":
					return day(item)
				case "Count":
					if (item > BigInt(Number.MAX_SAFE_INTEGER) || item < BigInt(Number.MIN_SAFE_INTEGER))
						throw new Refusal({ code: "CountRange", message: `Count ${path} exceeds a JSON integer` })
					return Number(item)
				default:
					throw new Refusal({
						code: "UnitUnclassified",
						message: `No boundary unit for integer field ${path}; add it to src/schema/units.ts`
					})
			}
		}
		if (isInterval(item) && name !== undefined) {
			const unit = unitFor(name)
			if (unit === "MoneyRange") return { start: formatDollars(item.start), end: formatMoneyEnd(item.end) }
			if (unit === "DayPoint" && item.end - item.start === 1n) return day(item.start)
			if (unit === "DayPoint" || unit === "DayRange")
				return { start: day(item.start), endExclusive: day(item.end) }
			throw new Refusal({
				code: "UnitUnclassified",
				message: `No boundary unit for interval field ${path}; add it to src/schema/units.ts`
			})
		}
		if (Array.isArray(item)) return item.map((entry, index) => walk(entry, name, `${path}[${index}]`))
		if (item instanceof Uint8Array) return Buffer.from(item).toString("base64")
		if (typeof item === "object" && item !== null)
			return Object.fromEntries(
				Object.entries(item).map(([key, entry]) => [
					key,
					key === "evidence" && typeof entry === "string" && statements.has(entry)
						? statements.get(entry)
						: walk(entry, key, `${path}.${key}`)
				])
			)
		return item
	}
	return walk(value, undefined, "$")
}
