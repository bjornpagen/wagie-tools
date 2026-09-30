import {
	type AnyField,
	type AnyRelation,
	decodeBoundaryField,
	encodeBoundaryField,
	type Fact,
	fieldSchema,
	type Infer,
	interval,
	u64,
	uuid
} from "@bjornpagen/bumbledb"
import { Effect, Result, Schema, SchemaGetter, SchemaIssue, SchemaTransformation } from "effect"
import { Dollars, formatDollars } from "../core/boundary.ts"
import {
	CivilDaySpan,
	civilDayPoint,
	civilDaySpan,
	formatCalendarDate,
	parseCalendarDate,
	UnixEpochDay
} from "../core/time.ts"
import { DayText, EntityId, MAX_U64, Nonblank } from "../core/values.ts"
import { TaxBand } from "../schema.ts"
import { unitFor } from "./units.ts"

/** Command fields use BumbleDB's own value codec and descriptor-derived type.
 * Only the spelling at the boundary differs, and the field's unit decides it:
 * money is "1234.56", dates are "YYYY-MM-DD", spans are {start, endExclusive}.
 */
export function inputField<F extends AnyField>(field: F): Schema.Codec<Infer<F>, unknown> {
	const value = fieldSchema(field)
	const wire = field.kind === "str" ? Nonblank : field.kind === "uuid" ? EntityId : Schema.Unknown
	return wire.pipe(
		Schema.decodeTo(value, {
			decode: SchemaGetter.transformOrFail((input) => {
				const decoded = decodeBoundaryField(field, input)
				if (Result.isFailure(decoded))
					return Effect.fail(
						new SchemaIssue.InvalidValue({ message: `Invalid ${field.kind} database value` })
					)
				return Effect.succeed(decoded.success)
			}),
			encode: SchemaGetter.transformOrFail((input) => {
				const encoded = encodeBoundaryField(field, input)
				if (Result.isFailure(encoded))
					return Effect.fail(
						new SchemaIssue.InvalidValue({ message: `Invalid ${field.kind} database value` })
					)
				return Effect.succeed(encoded.success)
			})
		})
	)
}

export const Id = inputField(uuid)
export const commandFields = { request: Id, business: Id }
export const YearNumber = Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 9997 }))
export const Year = YearNumber.pipe(
	Schema.decodeTo(Schema.BigInt, SchemaTransformation.transform({ decode: BigInt, encode: Number }))
)
export const Day = DayText.pipe(
	Schema.decodeTo(Schema.toType(UnixEpochDay), {
		decode: SchemaGetter.transformOrFail((value) =>
			Effect.try({
				try: () => parseCalendarDate(value),
				catch: () => new SchemaIssue.InvalidValue({ message: "The Gregorian date does not exist" })
			})
		),
		encode: SchemaGetter.transform(formatCalendarDate)
	})
)
export const DayPoint = Day.pipe(
	Schema.decodeTo(
		Schema.toType(CivilDaySpan),
		SchemaTransformation.transform({
			decode: civilDayPoint,
			encode: (span) => span.start
		})
	)
)
export const DayBounds = Schema.Struct({ start: Day, endExclusive: Day })
export const DaySpan = DayBounds.pipe(
	Schema.decodeTo(
		Schema.toType(CivilDaySpan),
		SchemaTransformation.transform({
			decode: ({ start, endExclusive }) => civilDaySpan(start, endExclusive),
			encode: ({ start, end }) => ({ start, endExclusive: end })
		})
	)
)
/** Money on the wage axis: [start, end) in dollars; "Infinity" is the native u64 ray end. */
export const DollarBounds = Schema.Struct({
	start: Dollars,
	end: Schema.Union([
		Dollars,
		Schema.Literal("Infinity").pipe(
			Schema.decodeTo(
				Schema.BigInt,
				SchemaTransformation.transform({ decode: () => MAX_U64, encode: () => "Infinity" as const })
			)
		)
	])
})
export const DollarRange = DollarBounds.pipe(Schema.decodeTo(fieldSchema(interval(u64))))

/** A money field: dollars at the boundary, the native field's range checked after. */
export const money = <F extends AnyField>(field: F): Schema.Codec<Infer<F>, unknown> => {
	const accepts = Schema.is(fieldSchema(field))
	return Dollars.pipe(
		Schema.decodeTo(Schema.toType(fieldSchema(field)), {
			decode: SchemaGetter.transformOrFail((cents: bigint) =>
				accepts(cents)
					? Effect.succeed(cents as Infer<F>)
					: Effect.fail(
							new SchemaIssue.InvalidValue({ message: `Amount out of range: ${formatDollars(cents)}` })
						)
			),
			encode: SchemaGetter.transform((cents) => cents as bigint)
		})
	) as unknown as Schema.Codec<Infer<F>, unknown>
}

/** The boundary codec for one column, chosen by its unit. */
function columnCodec(name: string, field: AnyField): Schema.Codec<unknown, unknown> {
	const unit = unitFor(name)
	const isInterval = field.kind === "interval"
	switch (unit) {
		case "Money":
			return money(field) as Schema.Codec<unknown, unknown>
		case "MoneyRange":
			return DollarRange as Schema.Codec<unknown, unknown>
		case "Day":
			return Day as Schema.Codec<unknown, unknown>
		case "DayPoint":
			return (isInterval ? DayPoint : Day) as Schema.Codec<unknown, unknown>
		case "DayRange":
			return DaySpan as Schema.Codec<unknown, unknown>
		default:
			return name === "year" ? (Year as Schema.Codec<unknown, unknown>) : inputField(field)
	}
}

type Overrides<R extends AnyRelation, K extends keyof Fact<R>> = Partial<{
	readonly [P in K]: Schema.Codec<Fact<R>[P], unknown>
}>
type Fields<R extends AnyRelation, K extends keyof Fact<R>, O> = {
	readonly [P in K]: P extends keyof O
		? O[P]
		: P extends "evidence"
			? Schema.Codec<string, unknown>
			: Schema.Codec<Fact<R>[P], unknown>
}

/** Pick the command's writable columns. Each column's boundary spelling is
 * derived from its unit; an override may only narrow it (a literal source, say).
 * The decoded value must still pass the native codec.
 */
export function inputFields<
	R extends AnyRelation,
	const K extends readonly (keyof Fact<R> & string)[],
	const O extends Overrides<R, K[number]> = Record<never, never>
>(source: R, names: K, overrides?: O): Fields<R, K[number], O> {
	return Object.fromEntries(
		names.map((name) => {
			const field = source.fields[name]
			if (!field) throw new Error(`Unknown input column ${source.name}.${name}`)
			// Evidence is prose at the boundary; the command stores it as a Statement.
			if (name === "evidence" && !overrides?.[name]) return [name, Nonblank]
			const accepts = Schema.is(fieldSchema(field))
			const codec: Schema.Codec<unknown, unknown> = overrides?.[name] ?? columnCodec(name, field)
			return [
				name,
				codec.check(Schema.makeFilter((value) => accepts(value) || `Invalid ${source.name}.${name}`))
			]
		})
		// Object.fromEntries erases the key/value relationship established above.
	) as Fields<R, K[number], O>
}

export const TaxBandInput = Schema.Struct({
	wages: DollarRange,
	...inputFields(TaxBand, ["numerator", "role"])
})
