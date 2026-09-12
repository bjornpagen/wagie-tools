import assert from "node:assert/strict"
import { test } from "node:test"
import type { Fact } from "@bjornpagen/bumbledb"
import { v7 } from "uuid"
import { civilDayPoint, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { entityId, MAX_U64 } from "../src/core/values.ts"
import { type EntryPayment, type LiabilityEntry, projectDeposits } from "../src/deposits.ts"
import type * as S from "../src/schema.ts"

test("deposit checkpoints retain historical triggers, carry exactly $500, and close the year", () => {
	const mint = () => entityId(v7())
	const business = mint(),
		employee = mint(),
		account = mint(),
		policy = mint()
	const checkpoints: Fact<typeof S.DepositCheckpoint>[] = [1, 2, 3, 4].map((quarter) => {
		const span = periodSpan(2026, "Quarter", quarter)
		return {
			id: mint(),
			policy,
			business,
			account,
			calendar: mint(),
			periodKind: "Quarter",
			span,
			year: 2026n,
			kind: quarter === 4 ? "Terminal" : "Interim",
			opensOn: span.end,
			dueOn: span.end + 30n,
			evidence: "Synthetic"
		}
	})
	const triggers: Fact<typeof S.DepositTrigger>[] = [
		{ policy, kind: "Interim", actionable: { start: 50001n, end: MAX_U64 } },
		{ policy, kind: "Terminal", actionable: { start: 1n, end: MAX_U64 } }
	]
	const entry = (amount: bigint, date: string): LiabilityEntry => ({
		revision: mint(),
		wage: mint(),
		business,
		employee,
		paidOn: civilDayPoint(parseCalendarDate(date)),
		account,
		family: "Federal940",
		amount
	})
	const first = entry(50000n, "2026-03-01")
	const second = entry(1n, "2026-05-01")
	const tail = entry(300n, "2026-08-01")
	const open = projectDeposits([first, second, tail], checkpoints, triggers, [])
	assert.deepEqual(
		open.map((row) => [row.disposition, row.required, row.outstanding]),
		[
			["Carryover", 50000n, 50000n],
			["Deposit", 50001n, 50001n],
			["Carryover", 300n, 300n],
			["Deposit", 300n, 300n]
		]
	)
	const paid: EntryPayment[] = [first, second].map((row) => ({
		revision: row.revision,
		account,
		payment: mint(),
		sentOn: parseCalendarDate("2026-09-10")
	}))
	const after = projectDeposits([first, second, tail], checkpoints, triggers, paid)
	assert.deepEqual(
		after.map((row) => [row.disposition, row.required, row.outstanding]),
		[
			["Carryover", 50000n, 0n],
			["Deposit", 50001n, 0n],
			["Carryover", 300n, 300n],
			["Deposit", 300n, 300n]
		],
		"September payment clears Q2 without moving its original liability into carryover"
	)
	const early: EntryPayment[] = [
		{ revision: first.revision, account, payment: mint(), sentOn: parseCalendarDate("2026-05-15") }
	]
	const earlyResult = projectDeposits([first, second], checkpoints, triggers, early)
	assert.equal(earlyResult[1]?.disposition, "Carryover")
	assert.equal(earlyResult[1]?.required, 1n, "an evidenced early deposit discharges the carried full entry")
	assert.equal(earlyResult.at(-1)?.disposition, "Deposit")
	assert.equal(earlyResult.at(-1)?.required, 1n)
})
