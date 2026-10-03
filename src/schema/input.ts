import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect"
import { formatDollars, parseDollars } from "../core/boundary.ts"
import { formatDate, formatPeriod, parseDate, parsePeriod, type Span } from "../core/time.ts"
import { MAX_U64, Refusal } from "../core/values.ts"

/** Inputs are parsed once, here, into the values the ledger stores. Nothing
 * past this boundary re-checks a date, an amount or a tracking id. */

const textCodec = <A>(
	description: string,
	type: Schema.Codec<A>,
	decode: (text: string) => A,
	encode: (value: A) => string
) =>
	Schema.String.annotate({ description }).pipe(
		Schema.decodeTo(Schema.toType(type), {
			decode: SchemaGetter.transformOrFail((text: string) =>
				Effect.try({
					try: () => decode(text),
					catch: (cause) =>
						new SchemaIssue.InvalidValue({
							message: cause instanceof Refusal ? cause.message : String(cause)
						})
				})
			),
			encode: SchemaGetter.transform(encode)
		})
	)

const cents = (text: string) => {
	const value = parseDollars(text)
	if (value < 0n || value > MAX_U64)
		throw new Refusal({ code: "InvalidMoney", message: `Out of range: ${text}` })
	return value
}

/** Non-negative money: "1234.56" at the boundary, cents inside. */
export const Money = textCodec(
	'Dollars with two decimals, e.g. "1234.56"',
	Schema.BigInt,
	cents,
	formatDollars
)
export const PositiveMoney = Money.check(
	Schema.makeFilter((value: bigint) => value > 0n || "Must be more than 0.00")
)
/** A civil date "2026-10-02" as an epoch day. */
export const Day = textCodec("Civil date YYYY-MM-DD", Schema.BigInt, parseDate, formatDate)
const SpanType = Schema.Struct({ start: Schema.BigInt, end: Schema.BigInt })
/** "2026", "2026Q3" or "2026-10" as a half-open day interval. */
export const Period = textCodec(
	'A year "2026", quarter "2026Q3" or month "2026-10"',
	SpanType,
	parsePeriod,
	(span: Span) => formatPeriod(span)
)
export const Year = Schema.Int.check(Schema.isBetween({ minimum: 1970, maximum: 9998 }))
/** Basis points over 10,000: 620 is 6.2%. */
export const Rate = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })).pipe(
	Schema.decodeTo(Schema.BigInt, {
		decode: SchemaGetter.transform((value: number) => BigInt(value)),
		encode: SchemaGetter.transform((value: bigint) => Number(value))
	})
)
export const Text = Schema.String.check(Schema.isPattern(/\S/)).annotate({ description: "Non-blank text" })

/** Mercury's "Tracking ID", exactly as the mercury.csv column of that name: a
 * wire or send-money id, or a 15-digit ACH trace for an IRS/TWC debit. A
 * Mercury transaction UUID from a wire receipt is not one and fails here. */
export const MercuryTrackingId = Schema.String.check(Schema.isPattern(/^(\d{8}MMQFMP4S\d{6}|\d{15})$/))
	.annotate({ description: "Mercury Tracking ID: YYYYMMDDMMQFMP4S###### or a 15-digit ACH trace" })
	.pipe(Schema.brand("MercuryTrackingId"))
export type MercuryTrackingId = typeof MercuryTrackingId.Type

/** Decode exactly: unknown keys refuse, and every problem is reported at once. */
export const parseStrict = <S extends Schema.Codec<unknown, unknown>>(
	shape: S,
	input: unknown
): S["Type"] => {
	try {
		return Schema.decodeUnknownSync(shape as never, { onExcessProperty: "error", errors: "all" })(
			input
		) as S["Type"]
	} catch (error) {
		throw new Refusal({
			code: "InvalidInput",
			message: error instanceof Error ? error.message : String(error)
		})
	}
}
