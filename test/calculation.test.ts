import assert from "node:assert/strict"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { assessmentAmounts, calculatedAmounts, calculatedTaxableWages } from "../src/calculations.ts"
import { parseCalendarDate } from "../src/core/time.ts"
import { MAX_U64 } from "../src/core/values.ts"
import * as S from "../src/schema.ts"
import { workRegister } from "../src/work.ts"
import { candidate } from "./calculation-fixture.ts"
import { apply, withHistory } from "./native-history.ts"
import { setupPayroll as setup } from "./payroll-fixture.ts"

test("full Wagie Tools history proves captured band coverage and derives exact native component amounts", async () => {
	await withHistory((history) =>
		Effect.gen(function* () {
			const fixture = yield* setup(history)
			const baseline = yield* history.snapshot({ consistency: { kind: "latest" } })
			for (const corrupt of ["day", "scope", "year", "sharedBase", "approval"] as const) {
				const draft = yield* ChangeSet.builder(S.ledger)
				yield* candidate(draft, fixture, 100000n, 650000n, corrupt)
				const receipt = yield* apply(history, yield* draft.finish())
				assert.equal(receipt.outcome.kind, "invariant-rejected", corrupt)
				assert.deepEqual(
					(yield* history.snapshot({ consistency: { kind: "latest" } })).stateStamp,
					baseline.stateStamp
				)
			}
			const unsupported = yield* ChangeSet.builder(S.ledger)
			yield* candidate(unsupported, fixture, 1n, 20000000n)
			assert.equal(
				(yield* apply(history, yield* unsupported.finish())).outcome.kind,
				"invariant-rejected",
				"unsupported additional Medicare range"
			)
			const draft = yield* ChangeSet.builder(S.ledger)
			const set = yield* candidate(draft, fixture, 100000n, 650000n)
			assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			const rows = yield* (yield* snapshot.execute(assessmentAmounts, {})).collect()
			assert.equal(rows.length, 7)
			assert.deepEqual(Object.fromEntries(rows.map((row) => [row.component, row.amount])), {
				FIT: 0n,
				EmployeeSS: 6200n,
				EmployerSS: 6200n,
				EmployeeMedicare: 1450n,
				EmployerMedicare: 1450n,
				FUTA: 300n,
				SUTA: 2700n
			})
			assert.ok(rows.every((row) => row.set === set))
			assert.equal((yield* (yield* snapshot.execute(calculatedAmounts, {})).collect()).length, 6)
			const cases = [
				{ prior: 0n, gross: 250n, futa: 2n, suta: 7n, ft: 250n, st: 250n },
				{ prior: 600000n, gross: 100000n, futa: 600n, suta: 2700n, ft: 100000n, st: 100000n },
				{ prior: 699999n, gross: 1n, futa: 0n, suta: 0n, ft: 1n, st: 1n },
				{ prior: 700000n, gross: 100000n, futa: 0n, suta: 2700n, ft: 0n, st: 100000n },
				{ prior: 870000n, gross: 100000n, futa: 0n, suta: 810n, ft: 0n, st: 30000n },
				{ prior: 899999n, gross: 1n, futa: 0n, suta: 0n, ft: 0n, st: 1n },
				{ prior: 900000n, gross: 100000n, futa: 0n, suta: 0n, ft: 0n, st: 0n }
			]
			for (const expected of cases) {
				const next = yield* ChangeSet.builder(S.ledger)
				const id = yield* candidate(next, fixture, expected.gross, expected.prior)
				assert.equal((yield* apply(history, yield* next.finish())).outcome.kind, "committed")
				const view = yield* history.snapshot({ consistency: { kind: "latest" } })
				const amounts = (yield* (yield* view.execute(calculatedAmounts, {})).collect()).filter(
					(row) => row.set === id
				)
				const taxable = (yield* (yield* view.execute(calculatedTaxableWages, {})).collect()).filter(
					(row) => row.set === id
				)
				assert.equal(amounts.length, 6)
				assert.equal(taxable.length, 6, "exhausted bases retain explicit zero taxable wages")
				assert.equal(amounts.find((row) => row.component === "FUTA")?.amount, expected.futa)
				assert.equal(amounts.find((row) => row.component === "SUTA")?.amount, expected.suta)
				assert.equal(taxable.find((row) => row.component === "FUTA")?.amount, expected.ft)
				assert.equal(taxable.find((row) => row.component === "SUTA")?.amount, expected.st)
			}
		})
	)
})

test("zero state rate preserves taxable wages; native intermediate overflow refuses", async () => {
	for (const numerator of [0n, MAX_U64]) {
		await withHistory((history) =>
			Effect.gen(function* () {
				const fixture = yield* setup(history, numerator)
				const draft = yield* ChangeSet.builder(S.ledger)
				yield* candidate(draft, fixture, 100000n, 870000n)
				assert.equal((yield* apply(history, yield* draft.finish())).outcome.kind, "committed")
				const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
				const taxable = yield* (yield* snapshot.execute(calculatedTaxableWages, {})).collect()
				assert.equal(taxable.find((row) => row.component === "SUTA")?.amount, 30000n)
				const calculated = Effect.gen(function* () {
					return yield* (yield* snapshot.execute(calculatedAmounts, {})).collect()
				})
				if (numerator === 0n) {
					assert.equal((yield* calculated).find((row) => row.component === "SUTA")?.amount, 0n)
				} else {
					assert.equal((yield* Effect.result(calculated))._tag, "Failure")
					assert.equal(
						(yield* Effect.result(workRegister(snapshot, fixture.business, parseCalendarDate("2026-09-11"))))
							._tag,
						"Success",
						"unpriced unposted calculations cannot poison the work register"
					)
				}
			})
		)
	}
})
