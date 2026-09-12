import assert from "node:assert/strict"
import type { TerminalReceipt } from "@bjornpagen/bumbledb-log"
import { Result } from "effect"
import { entityId, Refusal } from "../src/core/values.ts"

export function resultId(receipt: TerminalReceipt, field: string) {
	assert.ok(receipt.outcome.kind === "committed" || receipt.outcome.kind === "no-change")
	const value = receipt.outcome.result[field]
	assert.ok(typeof value === "string", `Missing command identity: ${field}`)
	return entityId(value)
}

export function refusalCode(result: Result.Result<unknown, unknown>) {
	assert.ok(Result.isFailure(result))
	assert.ok(result.failure instanceof Refusal)
	return result.failure.code
}

export function assertRefusal(result: Result.Result<unknown, unknown>, code: string) {
	assert.equal(refusalCode(result), code)
}
