import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import {
	admitContribution,
	distributionPosition,
	recordBookkeeping,
	retirementPosition
} from "../src/bookkeeping.ts"
import { epochDay, parseCalendarDate, periodSpan } from "../src/core/time.ts"
import { mintId } from "../src/core/values.ts"
import { expectRetirementFiling } from "../src/filing-coverage.ts"
import { prepareFiling } from "../src/filings.ts"
import { relationRows } from "../src/queries.ts"
import { Ledger, latest } from "../src/runtime.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { refusalCode, resultId } from "./assertions.ts"
import { apply, atTime, withHistory } from "./native-history.ts"
import { setupPayroll } from "./payroll-fixture.ts"

const evidence = "Synthetic bookkeeping evidence"
const date = "2026-09-11"
const receiptId = (receipt: Parameters<typeof resultId>[0]) => resultId(receipt, "id")

test("one Mercury payment funds a distribution and an after-tax contribution once; automatic conversion only records supplied events", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse(`${date}T17:00:00Z`),
			Effect.gen(function* () {
				const { business, employee, release } = yield* setupPayroll(history)
				const record = (operation: unknown) =>
					Effect.gen(function* () {
						return yield* recordBookkeeping({ request: yield* mintId, business, evidence, operation })
					})
				const plan = receiptId(
					yield* record({ kind: "Plan", employee, name: "Synthetic Plan", ein: "00-0000040" })
				)
				const fromAccount = receiptId(
					yield* record({
						kind: "Account",
						plan,
						accountKind: "AfterTax",
						provider: "Synthetic",
						reference: "after-tax"
					})
				)
				const toAccount = receiptId(
					yield* record({
						kind: "Account",
						plan,
						accountKind: "Roth",
						provider: "Synthetic",
						reference: "roth"
					})
				)
				yield* record({
					kind: "Annual",
					plan,
					year: 2026,
					deferralLimit: "2400000",
					additionsLimit: "7000000",
					compensationCap: "35000000",
					outsideDeferrals: "0",
					outsideAdditions: "0",
					otherPlans: false,
					outsideAssets: false
				})
				const bank = {
					kind: "BankMovement",
					direction: "Outflow",
					paidOn: date,
					amount: "500000",
					reference: "synthetic-mercury-1"
				}
				const movement = receiptId(yield* record(bank))
				assert.equal(receiptId(yield* record(bank)), movement)
				const distribution = receiptId(yield* record({ kind: "Distribution", movement, amount: "500000" }))
				const contribution = receiptId(
					yield* record({
						kind: "Contribution",
						plan,
						year: 2026,
						source: "EmployeeAfterTax",
						amount: "500000"
					})
				)
				yield* record({ kind: "FundContribution", contribution, movement, distribution, amount: "500000" })
				const before = yield* latest
				assert.equal((yield* relationRows(before, S.Wage)).length, 0)
				assert.equal(
					(yield* relationRows(before, S.CashAllocation)).reduce((n, r) => n + r.amount, 0n),
					500000n
				)
				assert.equal((yield* distributionPosition(before, business, 2026)).distributed, 500000n)
				assert.equal((yield* retirementPosition(before, plan, 2026)).afterTax, 500000n)
				assert.equal(
					refusalCode(yield* Effect.result(record({ kind: "Distribution", movement, amount: "1" }))),
					"invariant-rejected"
				)
				const received = receiptId(
					yield* record({
						kind: "ProviderReceipt",
						plan,
						provider: "Synthetic",
						reference: "automatic-1",
						account: toAccount,
						receivedOn: date,
						year: 2026,
						source: "EmployeeAfterTax",
						amount: "500000",
						allocations: [{ id: contribution, amount: "500000" }],
						conversion: { fromAccount, toAccount, convertedOn: date, amount: "500003", principal: "500000" }
					})
				)
				const snapshot = yield* latest
				assert.equal((yield* relationRows(snapshot, S.PlanReceipt)).length, 1)
				assert.equal((yield* relationRows(snapshot, S.RothConversion)).length, 1)
				assert.equal(
					(yield* relationRows(snapshot, S.SuppliedConversionTax)).length,
					0,
					"conversion does not infer basis or taxable earnings"
				)
				assert.equal(
					(yield* retirementPosition(snapshot, plan, 2026)).afterTax,
					500000n,
					"stages never consume contribution capacity again"
				)
				const work = (yield* workRegister(snapshot, business, parseCalendarDate(date))).work
				assert.equal(work.find((r) => r.id === `conversion/${received}`)?.completion, "Complete")
				assert.equal(work.find((r) => r.id === `conversion/${received}`)?.blocks, "None")
				const bindingDraft = yield* ChangeSet.builder(S.ledger)
				yield* bindingDraft.insert(S.PolicyBinding, [{ business, release, evidence }])
				assert.equal((yield* apply(history, yield* bindingDraft.finish())).outcome.kind, "committed")
				const filing = resultId(
					yield* expectRetirementFiling({
						request: yield* mintId,
						business,
						plan,
						form: "F1099RIRS",
						year: 2026,
						opensOn: "2027-01-01",
						dueOn: "2027-03-01",
						evidence
					}),
					"filing"
				)
				yield* prepareFiling({ request: yield* mintId, business, filing, evidence, documents: [] })
				assert.equal(
					(yield* workRegister(yield* latest, business, parseCalendarDate(date))).work.find(
						(r) => r.id === filing
					)?.action,
					"filings submit"
				)
				const conversion = (yield* relationRows(yield* latest, S.RothConversion))[0]
				assert.ok(conversion)
				yield* record({ kind: "SuppliedTax", conversion: conversion.id, field: "Taxable", amount: "3" })
				assert.equal(
					(yield* workRegister(yield* latest, business, parseCalendarDate(date))).work.find(
						(r) => r.id === filing
					)?.action,
					"filings prepare"
				)
				yield* record({ kind: "DistributionReview", year: 2026 })
				assert.equal((yield* distributionPosition(yield* latest, business, 2026)).reviewed, true)
				const refund = receiptId(
					yield* record({ ...bank, direction: "Inflow", reference: "synthetic-return-1", amount: "100" })
				)
				yield* record({ kind: "DistributionReturn", distribution, movement: refund, amount: "100" })
				const revised = yield* distributionPosition(yield* latest, business, 2026)
				assert.equal(revised.distributed, 500000n)
				assert.equal(revised.returned, 100n)
				assert.equal(revised.reviewed, false)
			}).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
	)
})

test("native cash constraints require Mercury identities, reject duplicates and prevent distribution over-allocation", async () => {
	await withHistory((history) =>
		Effect.gen(function* () {
			const { business } = yield* setupPayroll(history),
				movement = yield* mintId
			const cash = {
				id: movement,
				business,
				direction: "Outflow" as const,
				paidOn: parseCalendarDate(date),
				amount: 100n,
				evidence,
				recordedAt: 0n
			}
			const missing = yield* ChangeSet.builder(S.ledger)
			yield* missing.insert(S.BankMovement, [cash])
			assert.equal((yield* apply(history, yield* missing.finish())).outcome.kind, "invariant-rejected")
			const valid = yield* ChangeSet.builder(S.ledger)
			yield* valid.insert(S.BankMovement, [cash])
			yield* valid.insert(S.MercuryTransaction, [{ movement, reference: "synthetic-required" }])
			assert.equal((yield* apply(history, yield* valid.finish())).outcome.kind, "committed")
			const duplicate = yield* ChangeSet.builder(S.ledger),
				second = yield* mintId
			yield* duplicate.insert(S.BankMovement, [{ ...cash, id: second }])
			yield* duplicate.insert(S.MercuryTransaction, [{ movement: second, reference: "synthetic-required" }])
			assert.equal((yield* apply(history, yield* duplicate.finish())).outcome.kind, "invariant-rejected")
			const empty = yield* ChangeSet.builder(S.ledger),
				third = yield* mintId
			yield* empty.insert(S.BankMovement, [{ ...cash, id: third }])
			yield* empty.insert(S.MercuryTransaction, [{ movement: third, reference: "" }])
			assert.equal((yield* apply(history, yield* empty.finish())).outcome.kind, "invariant-rejected")
		})
	)
})

test("annual inputs never roll forward; observed excess and wrong-source receipts survive without authorizing more funding", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse(`${date}T17:00:00Z`),
			Effect.gen(function* () {
				const { business, employee } = yield* setupPayroll(history)
				const record = (operation: unknown) =>
					Effect.gen(function* () {
						return yield* recordBookkeeping({ request: yield* mintId, business, evidence, operation })
					})
				const plan = receiptId(
					yield* record({ kind: "Plan", employee, name: "Synthetic Plan", ein: "00-0000041" })
				)
				const account = receiptId(
					yield* record({
						kind: "Account",
						plan,
						accountKind: "Roth",
						provider: "Synthetic",
						reference: "wrong-source"
					})
				)
				const contribution = receiptId(
					yield* record({
						kind: "Contribution",
						plan,
						year: 2026,
						source: "EmployeeAfterTax",
						amount: "1000"
					})
				)
				yield* record({
					kind: "Annual",
					plan,
					year: 2026,
					deferralLimit: "2400000",
					additionsLimit: "7000000",
					compensationCap: "35000000",
					outsideDeferrals: "0",
					outsideAdditions: "0",
					otherPlans: false,
					outsideAssets: false
				})
				const position = yield* retirementPosition(yield* latest, plan, 2026)
				assert.equal(
					position.statutory?.additionsRemaining,
					-1000n,
					"actual excess is visible, not clamped to zero"
				)
				assert.equal((yield* retirementPosition(yield* latest, plan, 2027)).annual, undefined)
				assert.equal(
					refusalCode(
						yield* Effect.result(
							admitContribution(
								yield* latest,
								plan,
								"EmployeeAfterTax",
								1n,
								epochDay(periodSpan(2027, "Year").start)
							)
						)
					),
					"BookkeepingScope"
				)
				yield* record({
					kind: "ProviderReceipt",
					plan,
					provider: "Synthetic",
					reference: "wrong-source-receipt",
					account,
					year: 2026,
					source: "EmployeeRothDeferral",
					amount: "1000",
					allocations: [{ id: contribution, amount: "1000" }]
				})
				const snapshot = yield* latest
				assert.equal((yield* relationRows(snapshot, S.PlanReceipt)).length, 1)
				assert.ok(
					(yield* workRegister(snapshot, business, parseCalendarDate(date))).work.some(
						(r) => r.id.startsWith("receipt/") && r.completion === "Open"
					)
				)
			})
		).pipe(
			Effect.provideService(Ledger, { history, binding, recoveryDirectory: path.join(directory, "requests") })
		)
	)
})

test("partial receipts survive year end, late allocation reconciles them, and supplied report coverage preserves unknown event dates", async () => {
	await withHistory((history, binding, directory) =>
		atTime(
			Date.parse(`${date}T17:00:00Z`),
			Effect.gen(function* () {
				const { business, employee } = yield* setupPayroll(history)
				const record = (operation: unknown) =>
					Effect.gen(function* () {
						return yield* recordBookkeeping({ request: yield* mintId, business, evidence, operation })
					})
				const plan = receiptId(
					yield* record({ kind: "Plan", employee, name: "Synthetic Historical Plan", ein: "00-0000050" })
				)
				const account = receiptId(
					yield* record({
						kind: "Account",
						plan,
						accountKind: "AfterTax",
						provider: "Synthetic",
						reference: "partial"
					})
				)
				const contribution = receiptId(
					yield* record({
						kind: "Contribution",
						plan,
						year: 2026,
						source: "EmployeeAfterTax",
						amount: "1000"
					})
				)
				const first = receiptId(
					yield* record({
						kind: "ProviderReceipt",
						plan,
						provider: "Synthetic",
						reference: "partial-first",
						account,
						year: 2026,
						source: "EmployeeAfterTax",
						amount: "400",
						allocations: [{ id: contribution, amount: "400" }]
					})
				)
				const second = receiptId(
					yield* record({
						kind: "ProviderReceipt",
						plan,
						provider: "Synthetic",
						reference: "partial-second",
						account,
						year: 2026,
						source: "EmployeeAfterTax",
						amount: "600",
						allocations: []
					})
				)
				const future = parseCalendarDate("2027-01-02")
				let register = yield* workRegister(yield* latest, business, future)
				assert.equal(register.work.find((r) => r.id === `after-tax-receipt/${contribution}`)?.amount, 600n)
				assert.equal(register.work.find((r) => r.id === `conversion/${first}`)?.completion, "Open")
				assert.equal(
					refusalCode(
						yield* Effect.result(
							admitContribution(yield* latest, plan, "EmployeeAfterTax", 1n, parseCalendarDate(date))
						)
					),
					"ReceiptReconciliation"
				)
				yield* record({
					kind: "AllocateReceipt",
					receipt: second,
					allocations: [{ id: contribution, amount: "600" }]
				})
				assert.equal((yield* relationRows(yield* latest, S.PlanReceiptDate)).length, 0)
				register = yield* workRegister(yield* latest, business, future)
				assert.equal(
					register.work.find((r) => r.id === `after-tax-receipt/${contribution}`)?.completion,
					"Complete"
				)
				assert.equal(register.work.find((r) => r.id === `conversion/${second}`)?.completion, "Open")
				assert.equal(
					refusalCode(
						yield* Effect.result(
							record({
								kind: "AllocateReceipt",
								receipt: second,
								allocations: [{ id: contribution, amount: "601" }]
							})
						)
					),
					"invariant-rejected"
				)
				const artifact = yield* mintId,
					draft = yield* ChangeSet.builder(S.ledger)
				yield* draft.insert(S.Artifact, [
					{ id: artifact, sha256: "0".repeat(64), mediaType: "application/pdf" }
				])
				assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
				const supplied = receiptId(
					yield* record({
						kind: "SuppliedReport",
						plan,
						year: 2026,
						artifact,
						supplied: "Synthetic externally supplied conversion report"
					})
				)
				yield* record({ kind: "ConfirmReportedConversion", receipt: first, report: supplied })
				register = yield* workRegister(yield* latest, business, future)
				assert.equal(register.work.find((r) => r.id === `conversion/${first}`)?.completion, "Complete")
				assert.equal(register.work.find((r) => r.id === `conversion/${second}`)?.completion, "Open")
				assert.equal((yield* relationRows(yield* latest, S.RothConversion)).length, 0)
				const to = receiptId(
					yield* record({
						kind: "Account",
						plan,
						accountKind: "Roth",
						provider: "Synthetic",
						reference: "converted"
					})
				)
				assert.equal(
					refusalCode(
						yield* Effect.result(
							record({
								kind: "Conversion",
								plan,
								provider: "Synthetic",
								reference: "duplicate-covered",
								fromAccount: account,
								toAccount: to,
								convertedOn: date,
								amount: "400",
								receipts: [{ id: first, amount: "400" }]
							})
						)
					),
					"invariant-rejected"
				)
			}).pipe(
				Effect.provideService(Ledger, {
					history,
					binding,
					recoveryDirectory: path.join(directory, "requests")
				})
			)
		)
	)
})
