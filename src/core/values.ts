import { createHash } from "node:crypto"
import type { Uuid } from "@bjornpagen/bumbledb"
import { Data } from "effect"

export const MAX_U64 = (1n << 64n) - 1n
export const MAX_I64 = (1n << 63n) - 1n

export class Refusal extends Data.TaggedError("Refusal")<{
	readonly code: string
	readonly message: string
}> {}

export const refuse = (code: string, message: string): never => {
	throw new Refusal({ code, message })
}

/** A UUIDv8 carrying the SHA-256 of a natural key, so the same thing always
 * gets the same id and an identical re-run is no change. */
export const naturalId = (...parts: readonly (string | bigint)[]): Uuid => {
	const hex = createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex")
	const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16)
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Uuid
}

export const sum = (values: Iterable<bigint>): bigint => {
	let total = 0n
	for (const value of values) total += value
	return total
}
export const max = (a: bigint, b: bigint) => (a > b ? a : b)
export const min = (a: bigint, b: bigint) => (a < b ? a : b)

/** JSON with bigints as decimal strings and object keys sorted, so equal facts
 * print identically however they were assembled. */
export const canonicalJson = (value: unknown, indent?: number): string =>
	JSON.stringify(
		value,
		(_, item: unknown) =>
			typeof item === "bigint"
				? item.toString()
				: item !== null && typeof item === "object" && !Array.isArray(item)
					? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
					: item,
		indent
	)
