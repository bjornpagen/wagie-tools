import type { UnixEpochDay } from "./core/time.ts"

/** Every kind of work the register can derive, as data: what it is, what it
 * holds back, and whether it is an obligation or a reminder. The evaluator in
 * work.ts only decides which subjects each rule applies to and whether they
 * are complete; everything else about an item comes from this table.
 */
export const workRules = {
	"policy-refresh": { kind: "Policy", gates: "Payroll" },
	"retirement-annual": { kind: "Policy", gates: "RetirementFunding" },
	filing: { kind: "Filing", gates: "Payroll" },
	"filing-correction": { kind: "Filing", gates: "Payroll" },
	"filing-requirement": { kind: "Setup", gates: "Payroll" },
	"filing-subject": { kind: "Setup", gates: "Payroll" },
	"filing-scope": { kind: "Setup", gates: "Payroll" },
	"tax-account": { kind: "Setup", gates: "Payroll" },
	"annual-budget": { kind: "Setup", gates: "Payroll" },
	"budget-assignment": { kind: "Setup", gates: "Payroll" },
	"deposit-coverage": { kind: "Setup", gates: "Payroll" },
	deposit: { kind: "Payment", gates: "Payroll" },
	"correction-payment": { kind: "Payment", gates: "Payroll" },
	"payment-reconciliation": { kind: "Reconciliation", gates: "Payroll" },
	"tax-account-question": { kind: "Reconciliation", gates: "Payroll" },
	"negative-liability": { kind: "Reconciliation", gates: "Payroll" },
	"plan-setup-question": { kind: "Retirement", gates: "RetirementFunding" },
	"bookkeeping-question": { kind: "Retirement", gates: "RetirementFunding" },
	"retirement-over-capacity": { kind: "Retirement", gates: "RetirementFunding" },
	"receipt-discrepancy": { kind: "Retirement", gates: "RetirementFunding" },
	"roth-remittance": { kind: "Retirement", gates: "Payroll" },
	"retirement-filing-expectation": { kind: "Filing", gates: "Payroll" },
	"roth-plan-receipt": { kind: "Reminder", gates: "None" },
	"after-tax-plan-receipt": { kind: "Reminder", gates: "None" },
	"after-tax-conversion": { kind: "Reminder", gates: "None" },
	"after-tax-target": { kind: "Reminder", gates: "None" },
	"distribution-review": { kind: "Reminder", gates: "None" }
} as const

export type WorkRule = keyof typeof workRules

/** The next write that moves an item forward, as an op name from the op table
 * and the input fields the ledger already knows. The caller supplies the rest
 * (request id, evidence, and facts only the outside world has). */
export type NextIntent = { readonly op: string; readonly input: Readonly<Record<string, unknown>> }

export type WorkItem = {
	readonly id: string
	readonly rule: WorkRule
	readonly kind: (typeof workRules)[WorkRule]["kind"]
	readonly gates: (typeof workRules)[WorkRule]["gates"]
	readonly subject: string
	readonly label: string
	readonly opensOn: UnixEpochDay
	readonly dueOn?: UnixEpochDay
	readonly status: "Open" | "Complete" | "Carryover"
	readonly amount?: bigint
	readonly evidence?: string
	readonly next: NextIntent
}

export const workItem = (item: {
	rule: WorkRule
	subject: string
	label: string
	opensOn: UnixEpochDay
	dueOn?: UnixEpochDay | undefined
	complete: boolean
	carryover?: boolean
	amount?: bigint
	evidence?: string | undefined
	next: NextIntent
}): WorkItem => ({
	id: item.rule === "filing" ? item.subject : `${item.rule}/${item.subject}`,
	rule: item.rule,
	kind: workRules[item.rule].kind,
	gates: workRules[item.rule].gates,
	subject: item.subject,
	label: item.label,
	opensOn: item.opensOn,
	...(item.dueOn === undefined ? {} : { dueOn: item.dueOn }),
	status: item.complete ? "Complete" : item.carryover ? "Carryover" : "Open",
	...(item.amount === undefined ? {} : { amount: item.amount }),
	...(item.evidence === undefined ? {} : { evidence: item.evidence }),
	next: item.next
})
