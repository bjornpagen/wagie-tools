import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { after } from "node:test"
import { NativeRuntime } from "@bjornpagen/bumbledb"
import { Effect, Exit, ManagedRuntime } from "effect"
import { cli, describeCause } from "../src/cli.ts"
import * as Db from "../src/db.ts"

/* Synthetic fixtures only: a scratch ledger per scenario, driven through the
 * same rendering the command line uses. */

export const runtime = ManagedRuntime.make(NativeRuntime.layer())
const scratch = mkdtempSync(path.join(tmpdir(), "wagie-test-"))
after(async () => {
	await runtime.dispose()
	rmSync(scratch, { recursive: true, force: true })
})
let ledgers = 0
export const scratchPath = (name: string) => path.join(scratch, name)
export const freshLedger = () => scratchPath(`ledger-${++ledgers}`)

export type Output = { readonly [field: string]: unknown }
/** One op as `node src/cli.ts <op> '<json>'` runs it. A refusal rejects with
 * an Error whose `code` is the refusal's. */
export const op = async (ledger: string, name: string, payload: object = {}): Promise<Output> => {
	const exit = await runtime.runPromiseExit(cli([name, JSON.stringify(payload)], ledger))
	if (Exit.isSuccess(exit)) return exit.value as Output
	const [failure] = describeCause(exit.cause)
	throw Object.assign(new Error(`${failure?.code}: ${failure?.message}`), { code: failure?.code })
}

/** Judge raw edits against a ledger without committing: "admitted", or the
 * violations the laws report. */
export const judge = (ledger: string, edits: readonly Db.Edit[]) =>
	runtime
		.runPromise(
			Effect.scoped(Effect.flatMap(Db.open(ledger), (db) => Db.judge(db, () => ({ edits, result: {} }))))
		)
		.then((outcome) => outcome.laws)
export const read = (ledger: string) =>
	runtime
		.runPromise(Effect.scoped(Effect.flatMap(Db.open(ledger), (db) => Db.readFacts(db))))
		.then(({ facts }) => facts)
/** Commit raw edits, as only import can: history, attested filings. */
export const commit = (ledger: string, edits: readonly Db.Edit[]) =>
	runtime.runPromise(
		Effect.scoped(Effect.flatMap(Db.open(ledger), (db) => Db.write(db, () => ({ edits, result: {} }))))
	)

let trackingIds = 0
/** A fresh Mercury Tracking ID for a send-money transfer, or an ACH trace. */
export const sendMoney = () => `20260101MMQFMP4S${String(++trackingIds).padStart(6, "0")}`
export const achTrace = () => String(61036010000000 + ++trackingIds).padStart(15, "0")

const party = (name: string, tin: string) => ({ name, tin, address: "1 Main St, Austin TX 78701" })
export const setup = (from = "2026-01-02") => ({
	employer: party("Example Farm LLC", "00-0000001"),
	employee: party("Pat Owner", "000-00-0001"),
	plan: party("Example Farm LLC Solo 401k", "00-0000002"),
	registrations: [{ state: "TX", number: "00-000000-0" }],
	employment: { from, state: "TX" },
	custody: {
		Pretax: { custodian: "Carry", number: "QX0001" },
		AfterTax: { custodian: "Carry", number: "QX0002" },
		Roth: { custodian: "Carry", number: "QX0003" }
	}
})
/** A year's federal policy at the 2026 rates and limits. */
export const federal = (year: number) => ({
	jurisdiction: "Federal",
	year,
	limits: {
		deferralLimit: "24500.00",
		additionsLimit: "72000.00",
		compensationLimit: "360000.00",
		wageCeiling: "200000.00"
	},
	rates: {
		SocialSecurity: { rate: "6.2", base: "184500.00" },
		Medicare: { rate: "1.45" },
		FederalUnemployment: { rate: "0.6", base: "7000.00" }
	}
})
export const texas = (year: number) => ({
	jurisdiction: "TX",
	year,
	rates: { TexasUnemployment: { rate: "2.7", base: "9000.00" } }
})

/** A business employing its owner in Texas (from 2026-01-02 unless told
 * otherwise), with 2026 policy, a $120,000 salary target and a signed
 * election. */
export const ledger2026 = async (from = "2026-01-02") => {
	const ledger = freshLedger()
	await op(ledger, "setup", setup(from))
	await op(ledger, "policy.set", federal(2026))
	await op(ledger, "policy.set", texas(2026))
	await op(ledger, "plan.set", { year: 2026, salary: "120000.00", fitPerCheck: "0.01" })
	await op(ledger, "election.set", {
		year: 2026,
		roth: "24500.00",
		afterTax: "47500.00",
		signedOn: "2026-01-02"
	})
	return ledger
}

/** Post a paycheck and send both of its wires. */
export const paid = async (ledger: string, paidOn: string, input: object) => {
	const check = await op(ledger, "payroll.post", { paidOn, input })
	for (const wire of check.wires as { kind: string; amount: string }[])
		await op(ledger, "transfer.record", {
			kind: wire.kind,
			paidOn,
			mercury: sendMoney(),
			sentOn: paidOn,
			amount: wire.amount
		})
	return check
}

/** Deposit a 941 quarter's payment through EFTPS. */
export const deposit = (ledger: string, period: string, amount: string, on: string, account = "Federal941") =>
	op(ledger, "tax.paid", {
		tracker: achTrace(),
		account,
		kind: "Deposit",
		period,
		amount,
		initiatedOn: on,
		mercury: achTrace(),
		sentOn: on
	})

export const whats = (items: unknown) => (items as { what: string }[]).map((item) => item.what)
