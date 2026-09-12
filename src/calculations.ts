import { Compute, query, type Uuid, v } from "@bjornpagen/bumbledb"
import {
	AssessmentRevision,
	AssessmentSet,
	BandRole,
	CalculatedAssessment,
	CalculationBasis,
	Component,
	Deduction,
	ledger,
	ObservedAssessment,
	RateSchedule,
	TaxableWages,
	TaxBand,
	Wage
} from "./schema.ts"

const allSets = query(ledger).rule((r) => {
	const { id: set } = v(AssessmentSet)
	return r.match(AssessmentSet, { id: set }).find({ set })
})
const postedSets = query(ledger).rule((r) => {
	const { id: set } = v(AssessmentSet)
	return r.match(AssessmentSet, { id: set }).match(AssessmentRevision, { set }).find({ set })
})

/** Scope the input relation BEFORE arithmetic. A nonrecursive interior is a
 * complete relation expression: filtering its final output cannot protect it
 * from overflow in unrelated inputs. The same native formula is instantiated
 * for all sets, posted sets, or one inspected calculation, with no error fallback.
 */
function assessmentProjection(selection: typeof allSets) {
	// Join by the captured schedule before deriving nonempty intersections.
	// Basis + band identify each contribution, even when two amounts are equal.
	const intersections = query(ledger).rule((r) => {
		const { id: basis, set, schedule, earning } = v(CalculationBasis)
		const { id: band, span, numerator, role } = v(TaxBand)
		return r
			.match(CalculationBasis, { id: basis, set, schedule, earning })
			.match(selection, { set })
			.match(TaxBand, { id: band, schedule, span, numerator, role })
			.find({ basis, band, numerator, role, span: r.intersection(earning, span) })
	})
	const measured = query(ledger).rule((r) => {
		const { span, ...identity } = v(intersections)
		return r.match(intersections, { ...identity, span }).find({ ...identity, cents: Compute.measure(span) })
	})
	const weightedSlices = query(ledger).rule((r) => {
		const row = v(measured)
		const { basis, band, cents, numerator } = row
		return r.match(measured, row).find({ basis, band, weighted: Compute.multiply(cents, numerator) })
	})

	const weightedBases = query(ledger).rule((r) => {
		const row = v(weightedSlices)
		return r.match(weightedSlices, row).find({ basis: row.basis, weighted: r.sum(row.weighted) })
	})

	/** One native arithmetic interpretation for every configured marginal schedule.
	 * All operands are exact unsigned integers. Round once per component/wage,
	 * nearest cent with ties upward. Native overflow or division failure refuses.
	 */
	const calculatedAmounts = query(ledger).rule((r) => {
		const { set, component, basis } = v(CalculatedAssessment)
		const { schedule } = v(CalculationBasis)
		const { weighted } = v(weightedBases)
		const { denominator } = v(RateSchedule)
		return r
			.match(CalculatedAssessment, { set, component, basis })
			.match(CalculationBasis, { id: basis, schedule })
			.match(weightedBases, { basis, weighted })
			.match(RateSchedule, { id: schedule, denominator })
			.find({
				set,
				component,
				amount: Compute.mulDiv(weighted, Compute.u64(1n), denominator, "nearestTiesAwayFromZero")
			})
	})

	/** Observations and calculated assessments have one read interface. */
	const assessmentAmounts = query(ledger)
		.rule((r) => {
			const row = v(calculatedAmounts)
			return r.match(calculatedAmounts, row).find(row)
		})
		.rule((r) => {
			const { set, component, amount } = v(ObservedAssessment)
			return r
				.match(ObservedAssessment, { set, component, amount })
				.match(selection, { set })
				.find({ set, component, amount })
		})

	const taxableSlices = query(ledger).rule((r) => {
		const row = v(measured)
		const { basis, band, role, cents } = row
		const { taxable } = v(BandRole)
		return r
			.match(measured, row)
			.match(BandRole, { id: role, taxable })
			.find({ basis, band, amount: Compute.multiply(cents, taxable) })
	})

	/** Taxable wage reporting depends on the band's role, independently of its rate.
	 * Excess slices contribute explicit zero, preserving exhausted-base assessments.
	 */
	const calculatedTaxableWages = query(ledger).rule((r) => {
		const { set, component, basis } = v(CalculatedAssessment)
		const { band, amount } = v(taxableSlices)
		return r
			.match(CalculatedAssessment, { set, component, basis })
			.match(taxableSlices, { band, basis, amount })
			.find({ set, component, amount: r.sum(amount) })
	})

	/** Unknown observed taxable wages remain absent. Reporting keeps component
	 * identity, so paired employee/employer bases are never summed as two wages.
	 */
	const taxableAmounts = query(ledger)
		.rule((r) => {
			const row = v(calculatedTaxableWages)
			return r.match(calculatedTaxableWages, row).find(row)
		})
		.rule((r) => {
			const { set, program, amount } = v(TaxableWages),
				{ id: component } = v(Component)
			return r
				.match(TaxableWages, { set, program, amount })
				.match(selection, { set })
				.match(AssessmentSet, { id: set, origin: "Observed" })
				.match(Component, { id: component, program })
				.find({ set, component, amount })
		})

	return { assessmentAmounts, calculatedAmounts, calculatedTaxableWages, taxableAmounts }
}
export const { assessmentAmounts, calculatedAmounts, calculatedTaxableWages, taxableAmounts } =
	assessmentProjection(allSets)
export const postedAssessment = assessmentProjection(postedSets)
export const assessmentForSet = (id: Uuid) =>
	assessmentProjection(
		query(ledger).rule((r) => {
			const { id: set } = v(AssessmentSet)
			return r.match(AssessmentSet, { id: set }).where(r.eq(set, id)).find({ set })
		})
	)

const deductionTotals = query(ledger).rule((r) => {
	const { wage, kind, amount } = v(Deduction)
	return r.match(Deduction, { wage, kind, amount }).find({ wage, amount: r.sum(amount) })
})

const deductedCash = query(ledger).rule((r) => {
	const { id: wage, gross } = v(Wage)
	const { amount } = v(deductionTotals)
	return r
		.match(Wage, { id: wage, gross })
		.match(deductionTotals, { wage, amount })
		.find({ wage, amount: Compute.subtract(gross, amount) })
})

export const netCash = query(ledger)
	.rule((r) => {
		const row = v(deductedCash)
		return r.match(deductedCash, row).find(row)
	})
	.rule((r) => {
		const { id: wage, gross: amount } = v(Wage)
		return r.match(Wage, { id: wage, gross: amount }).where(r.not(Deduction, { wage })).find({ wage, amount })
	})
