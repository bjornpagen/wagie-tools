import { DbError, NativeRuntime } from "@bjornpagen/bumbledb"
import { type Cause, Effect, Exit } from "effect"
import { encodeOutput } from "./core/boundary.ts"
import { canonicalJson, Refusal, refuse } from "./core/values.ts"
import { ledgerPath } from "./db.ts"
import { ops, run } from "./ops.ts"

/**
 * node src/cli.ts <op> ['<json>']
 *
 * One op, one JSON object in, one JSON object out. Money is dollars with two
 * decimals ("8000.00"), days are "2026-10-02", periods are "2026", "2026Q3"
 * or "2026-10". A refusal prints {code, message} on stderr and exits 1. With
 * no op, prints the op table.
 */

const parseJson = (text: string): object => {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch (error) {
		return refuse("InvalidJson", error instanceof Error ? error.message : String(error))
	}
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return refuse("InvalidJson", "Give one JSON object")
	return value
}

/** One op, run against a ledger and rendered for JSON. */
export const cli = (args: readonly string[], ledger = ledgerPath) =>
	Effect.suspend(() => {
		const [name, json, ...rest] = args
		if (name === undefined)
			return Effect.succeed(Object.entries(ops).map(([op, { summary }]) => ({ op, summary })))
		if (rest.length > 0) return refuse("Usage", "node src/cli.ts <op> '<json>'")
		return Effect.map(run(name, json === undefined ? {} : parseJson(json), ledger), encodeOutput)
	})

/** One readable failure per cause: a refusal's code and message, or an
 * unexpected error's name, message and stack. */
export const describeCause = (cause: Cause.Cause<unknown>) =>
	cause.reasons.map((reason) => {
		const error: unknown =
			reason._tag === "Fail" ? reason.error : reason._tag === "Die" ? reason.defect : reason
		if (error instanceof Refusal) return { code: error.code, message: error.message }
		if (error instanceof DbError)
			return { code: "DbError", message: `${error.operation}: ${canonicalJson(error.reason)}` }
		if (error instanceof Error)
			return { code: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 8) }
		return { code: reason._tag, message: String(error) }
	})

if (import.meta.main) {
	const exit = await Effect.runPromiseExit(
		cli(process.argv.slice(2)).pipe(Effect.provide(NativeRuntime.layer()))
	)
	if (Exit.isSuccess(exit)) process.stdout.write(`${JSON.stringify(exit.value, null, 2)}\n`)
	else {
		const failures = describeCause(exit.cause)
		process.stderr.write(`${JSON.stringify(failures.length === 1 ? failures[0] : failures, null, 2)}\n`)
		process.exitCode = 1
	}
}
