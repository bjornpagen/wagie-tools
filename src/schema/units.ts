/** Every integer that crosses the JSON boundary has exactly one unit, decided
 * by its field name. The same name never carries two units, and an integer
 * whose name is absent here refuses to cross the boundary. */
export const unitOf = {
	// Money: integer cents inside, "1234.56" at the boundary.
	amount: "Money",
	gross: "Money",
	net: "Money",
	owedNet: "Money",
	sentNet: "Money",
	sentRoth: "Money",
	fit: "Money",
	ss: "Money",
	medicare: "Money",
	roth: "Money",
	afterTax: "Money",
	salary: "Money",
	fitPerCheck: "Money",
	ssBase: "Money",
	futaBase: "Money",
	sutaBase: "Money",
	deferralLimit: "Money",
	additionsLimit: "Money",
	compensationLimit: "Money",
	wageCeiling: "Money",
	taxable: "Money",
	liability: "Money",
	paid: "Money",
	outstanding: "Money",
	credit: "Money",
	remaining: "Money",
	target: "Money",
	ytd: "Money",
	room: "Money",
	max: "Money",
	recovered: "Money",
	excess: "Money",
	// Money ranges on the year's wage axis.
	earnings: "MoneyRange",
	// Rates: basis points over 10,000.
	ssRate: "Rate",
	medicareRate: "Rate",
	futaRate: "Rate",
	sutaRate: "Rate",
	// Civil dates.
	asOf: "Day",
	on: "Day",
	sentOn: "Day",
	initiatedOn: "Day",
	signedOn: "Day",
	mailedOn: "Day",
	opensOn: "Day",
	dueOn: "Day",
	start: "Day",
	paidOn: "Day",
	employedFrom: "Day",
	// Half-open day intervals: "2026", "2026Q3", "2026-10".
	period: "Period",
	span: "Period",
	// Plain integers.
	year: "Count",
	quarter: "Count",
	count: "Count",
	facts: "Count"
} as const

export type Unit = (typeof unitOf)[keyof typeof unitOf]
export const unitFor = (name: string): Unit | undefined =>
	Object.hasOwn(unitOf, name) ? unitOf[name as keyof typeof unitOf] : undefined
