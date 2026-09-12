import type { Uuid } from "@bjornpagen/bumbledb"
import { Data, Effect, Schema } from "effect"
import { v7 } from "uuid"

export const MAX_U64 = (1n << 64n) - 1n
export const MAX_I64 = (1n << 63n) - 1n
export const MIN_I64 = -(1n << 63n)
const v7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const EntityId = Schema.String.check(Schema.isPattern(v7Pattern))
export const Nonblank = Schema.String.check(Schema.isPattern(/\S/))
export const DayText = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))

export function entityId(value: string): Uuid {
	const checked = Schema.decodeUnknownSync(EntityId)(value)
	// The refinement establishes the native UUID text shape as well as v7 and variant.
	return checked as Uuid
}
export const mintId = Effect.sync(() => entityId(v7()))

export class Refusal extends Data.TaggedError("Refusal")<{
	readonly code: string
	readonly message: string
}> {}

export function unsigned(value: bigint): bigint {
	if (value < 0n || value > MAX_U64)
		throw new Refusal({ code: "AmountRange", message: "Unsigned cents overflow" })
	return value
}
export function signed(value: bigint): bigint {
	if (value < MIN_I64 || value > MAX_I64)
		throw new Refusal({ code: "AmountRange", message: "Signed cents overflow" })
	return value
}
export const json = (value: unknown) =>
	JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2)
