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

/** Command fields use BumbleDB's own value codec and descriptor-derived type.
 * Only the spelling at the human boundary differs: dates, years and file paths.
 * Native ranges, UUIDs, closed rosters and interval widths have one interpreter.
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

type Overrides<R extends AnyRelation, K extends keyof Fact<R>> = Partial<{
	readonly [P in K]: Schema.Codec<Fact<R>[P], unknown>
}>
type Fields<R extends AnyRelation, K extends keyof Fact<R>, O> = {
	readonly [P in K]: P extends keyof O ? O[P] : Schema.Codec<Fact<R>[P], unknown>
}

/** Pick the command's writable columns, with typed I/O conversions where needed.
 * Overrides must decode to the declared native field and still pass its codec.
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
			const override = overrides?.[name]
			const accepts = Schema.is(fieldSchema(field))
			return [
				name,
				override
					? override.check(Schema.makeFilter((value) => accepts(value) || `Invalid ${source.name}.${name}`))
					: inputField(field)
			]
		})
		// Object.fromEntries erases the key/value relationship established above.
	) as Fields<R, K[number], O>
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

/** Money coordinates use integer cents; Infinity is the native u64 ray endpoint. */
export const CentBounds = Schema.Struct({
	start: inputField(u64),
	end: Schema.Union([
		inputField(u64),
		Schema.Literal("Infinity").pipe(
			Schema.decodeTo(
				Schema.BigInt,
				SchemaTransformation.transform({ decode: () => MAX_U64, encode: () => "Infinity" as const })
			)
		)
	])
})
export const CentRange = CentBounds.pipe(Schema.decodeTo(fieldSchema(interval(u64))))

export const TaxBandInput = Schema.Struct({
	...CentBounds.fields,
	...inputFields(TaxBand, ["numerator", "role"])
})
