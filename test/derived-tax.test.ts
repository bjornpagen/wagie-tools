import assert from "node:assert/strict"
import { test } from "node:test"
import { ChangeSet } from "@bjornpagen/bumbledb"
import { Effect } from "effect"
import { assessmentForSet, calculatedAmounts, calculatedTaxableWages } from "../src/calculations.ts"
import { MAX_U64, mintId } from "../src/core/values.ts"
import { relationRows, rows } from "../src/queries.ts"
import * as S from "../src/schema.ts"
import { candidate } from "./calculation-fixture.ts"
import { apply, withHistory } from "./native-history.ts"
import { setupPayroll } from "./payroll-fixture.ts"

const round = (weighted: bigint, divisor: bigint) =>
	weighted / divisor + ((weighted % divisor) * 2n >= divisor ? 1n : 0n)
const taxable = (gross: bigint, prior: bigint, cap: bigint) =>
	prior >= cap ? 0n : gross < cap - prior ? gross : cap - prior

test("derived payroll matches an independent integer oracle across wage-base boundaries and businesses", async () => {
	await withHistory((history) =>
		Effect.gen(function* () {
			const fixture = yield* setupPayroll(history)
			const other = yield* setupPayroll(history, 123n, 1)
			const changes = yield* ChangeSet.builder(S.ledger)
			const samples = []
			for (const prior of [0n, 699999n, 700000n, 899999n, 900000n, 18449999n, 18450000n])
				for (const gross of [1n, 249n, 250n, 251n, 9999n, 100000n])
					samples.push({ set: yield* candidate(changes, fixture, gross, prior), gross, prior })
			const isolated = yield* candidate(changes, other, 100000n, 0n)
			assert.equal((yield* apply(history, yield* changes.finish())).outcome.kind, "committed")
			const before = yield* history.snapshot({ consistency: { kind: "latest" } })
			const actual = yield* rows(before, calculatedAmounts, {})
			for (const sample of samples) {
				const ss = taxable(sample.gross, sample.prior, 18450000n)
				const expected = {
					EmployeeSS: round(ss * 620n, 10000n),
					EmployerSS: round(ss * 620n, 10000n),
					EmployeeMedicare: round(sample.gross * 145n, 10000n),
					EmployerMedicare: round(sample.gross * 145n, 10000n),
					FUTA: round(taxable(sample.gross, sample.prior, 700000n) * 60n, 10000n),
					SUTA: round(taxable(sample.gross, sample.prior, 900000n) * 270n, 10000n)
				}
				assert.deepEqual(
					Object.fromEntries(actual.filter((r) => r.set === sample.set).map((r) => [r.component, r.amount])),
					expected
				)
			}
			assert.equal(actual.find((r) => r.set === isolated && r.component === "SUTA")?.amount, 1230n)
			const poisonFixture = yield* setupPayroll(history, MAX_U64, 2)
			const poison = yield* ChangeSet.builder(S.ledger)
			yield* candidate(poison, poisonFixture, 2n, 0n)
			assert.equal((yield* apply(history, yield* poison.finish())).outcome.kind, "committed")
			const after = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.ok(samples[0])
			const scoped = assessmentForSet(samples[0].set)
			assert.equal((yield* rows(after, scoped.calculatedAmounts, {})).length, 6)
			assert.equal((yield* Effect.result(rows(after, calculatedAmounts, {})))._tag, "Failure")
			assert.deepEqual(
				yield* rows(before, calculatedAmounts, {}),
				actual,
				"an earlier snapshot retains its answers"
			)
		})
	)
})

test("equal band contributions survive, split bands equal merged bands, and earlier sum overflow remains a refusal", async () => {
	for (const numerator of [270n, MAX_U64 / 2n + 1n])
		await withHistory((history) =>
			Effect.gen(function* () {
				const fixture = yield* setupPayroll(history, numerator)
				const state = fixture.rules.get("SUTA")
				assert.ok(state)
				const changes = yield* ChangeSet.builder(S.ledger)
				const band = state.bands.find((r) => r.role === "WithinBase")
				assert.ok(band)
				yield* changes.delete(S.TaxBand, [band])
				yield* changes.insert(S.TaxBand, [
					{ ...band, span: { start: 0n, end: 450000n } },
					{ ...band, id: yield* mintId, span: { start: 450000n, end: 900000n } }
				])
				const amount = numerator === 270n ? 200000n : 2n
				const prior = 450000n - amount / 2n
				const set = yield* candidate(changes, fixture, amount, prior)
				assert.equal((yield* apply(history, yield* changes.finish())).outcome.kind, "committed")
				const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
				assert.equal(
					(yield* rows(snapshot, calculatedTaxableWages, {})).find(
						(r) => r.set === set && r.component === "SUTA"
					)?.amount,
					amount
				)
				if (numerator === 270n) {
					assert.equal(
						(yield* rows(snapshot, calculatedAmounts, {})).find(
							(r) => r.set === set && r.component === "SUTA"
						)?.amount,
						round(amount * numerator, 10000n)
					)
				} else
					assert.equal(
						(yield* Effect.result(rows(snapshot, calculatedAmounts, {})))._tag,
						"Failure",
						"two valid products must not overflow their aggregate"
					)
			})
		)
})

test("exact quotient admits doubling-only overflow while native band gaps, overlaps and zero divisors remain invalid", async () => {
	await withHistory((history) =>
		Effect.gen(function* () {
			const numerator = MAX_U64 - 1n
			const fixture = yield* setupPayroll(history, numerator)
			const changes = yield* ChangeSet.builder(S.ledger)
			const set = yield* candidate(changes, fixture, 1n, 0n)
			assert.equal((yield* apply(history, yield* changes.finish())).outcome.kind, "committed")
			const snapshot = yield* history.snapshot({ consistency: { kind: "latest" } })
			assert.equal(
				(yield* rows(snapshot, calculatedAmounts, {})).find((r) => r.set === set && r.component === "SUTA")
					?.amount,
				round(numerator, 10000n)
			)
			const rule = fixture.rules.get("SUTA")
			assert.ok(rule)
			const schedules = yield* relationRows(snapshot, S.RateSchedule)
			const schedule = schedules.find((r) => r.id === rule.schedule)
			assert.ok(schedule)
			const band = rule.bands.find((r) => r.role === "WithinBase")
			assert.ok(band)
			for (const corruption of ["gap", "overlap", "divisor"]) {
				const invalid = yield* ChangeSet.builder(S.ledger)
				if (corruption === "divisor") {
					yield* invalid.delete(S.RateSchedule, [schedule])
					yield* invalid.insert(S.RateSchedule, [{ ...schedule, denominator: 0n }])
				} else if (corruption === "gap") {
					yield* invalid.delete(S.TaxBand, [band])
					yield* invalid.insert(S.TaxBand, [{ ...band, span: { start: 1n, end: band.span.end } }])
				} else yield* invalid.insert(S.TaxBand, [{ ...band, id: yield* mintId }])
				assert.equal(
					(yield* apply(history, yield* invalid.finish())).outcome.kind,
					"invariant-rejected",
					corruption
				)
			}
		})
	)
})
