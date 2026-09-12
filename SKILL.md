---
name: wagie-tools
description: Operate Wagie Tools payroll, owner distributions, retirement contribution and conversion bookkeeping, tax payments, filing completions, annual policy, and verified backups.
---

# Wagie Tools

Use the noninteractive CLI from this repository: `pnpm cli COMMAND`.
It records payroll and evidence in a local BumbleDB history. Sending money,
submitting returns, and mailing documents are separate external actions; perform
those only within the user's authorization. An absent ledger record does not
prove that an external action never happened.

## Find the current state

Read `private/binding.json` and use its existing store. A missing binding or
schema mismatch needs investigation; never initialize over it. Commands accept
`--binding PATH` when intentionally using another store. For build prerequisites,
read [local runtime](docs/local-runtime.md).

Use `pnpm cli db audit` to discover business IDs when unknown. Then select the
relevant business and read only what the task needs:

| User's task | Read commands after `pnpm cli` |
|---|---|
| Run payroll or explain what prevents it | `status --business BUSINESS_ID` |
| Show upcoming or outstanding tax work | `deadlines --business BUSINESS_ID` |
| Find employees, tax accounts, budgets, or elections | `business inspect --business BUSINESS_ID` |
| Inspect filed forms, versions, and submission evidence | `filings inspect --business BUSINESS_ID` |
| Review annual or quarterly figures | `report year --business BUSINESS_ID --year YEAR`; `report quarter --business BUSINESS_ID --year YEAR --quarter QUARTER` |
| Inspect policy coverage or unresolved reviews | `policy inspect --business BUSINESS_ID`; `review list --business BUSINESS_ID` |

Replace uppercase placeholders with discovered IDs and actual inputs. Payroll,
status, deadlines, and reports share one work register. `blockers` prevents
posting; `readiness` explains uncertainties in reported figures. Follow each
item's `action` and evidence requirement. Upcoming work is not automatically due.
Read commands do not create requirements or mark anything complete.

`--as-of YYYY-MM-DD` on status, deadlines, filings inspection, and reports changes
the historical view. Payroll posting always checks the real employer date.

## Submit an intent once

Domain writes use `pnpm cli GROUP ACTION --input private/intent.json` or
`--input -` for JSON on stdin. Inputs are strict: unknown keys are rejected.
Read the relevant input declaration below before constructing an unfamiliar
payload; the source is authoritative for required fields and closed values.

Each distinct intent needs a UUIDv7 `request`. Generate one with the installed
package, for example:

```sh
node --input-type=module -e 'import { v7 } from "uuid"; console.log(v7())'
```

Copy existing entity IDs from readback. Keep the same request and exact payload
on retry. Money is a decimal string of integer cents; zero means an evidenced
zero, not a missing value. Dates enter as `YYYY-MM-DD`; interval ends are exclusive.
Native civil dates are Unix epoch days (1970-01-01 = 0), while recording timestamps
are Unix milliseconds. Use [units](docs/units.md) to interpret numeric output.

Successful receipts contain `outcome.result`; payroll commands wrap the receipt under `receipt` and add figure readback. Save the
returned IDs, inspect the affected records, and re-read status after completing
work. A nonzero exit can accompany a saved `ReconciliationRequired` observation.

If interrupted, resolve the original request first:

```sh
pnpm cli command resolve --request REQUEST_ID
```

A committed/no-change receipt settles the intent. An uncertain or rejected
outcome requires reading its reason before taking another action. Never treat
uncertainty as permission to send money again. For a stale calculation, resolve
its posting request before creating a fresh calculation.

`RequestHistoryChanged` identifies a retained request from a different history.
Inspect its original history or backup for the outcome. The current ledger cannot
resolve or replay a command addressed to the closed incarnation.

## Run payroll

1. Inspect the employee, current budget/election, and `status`. Address actual
   blockers through their domain commands. A clear register is necessary;
   calculation also requires applicable annual approvals and payroll policy.
2. Establish the pay date, work interval, gross amount, requested Roth deduction,
   and evidenced federal income-tax withholding. If deriving gross from an
   existing annual budget, use `compensation suggest --business BUSINESS_ID
   --employee EMPLOYEE_ID --paid-on YYYY-MM-DD --work-start YYYY-MM-DD
   --work-end-exclusive YYYY-MM-DD`. A budget is a target, not a contractual rate.
3. Use `payroll calculate` with this template, replacing every placeholder:

```json
{
  "request": "REQUEST_ID", "business": "BUSINESS_ID", "employee": "EMPLOYEE_ID",
  "purpose": {
    "kind": "NewWage", "paidOn": "YYYY-MM-DD",
    "grossCents": "GROSS_CENTS", "rothCents": "ROTH_CENTS",
    "work": {"start": "YYYY-MM-DD", "endExclusive": "YYYY-MM-DD"}
  },
  "fit": {"cents": "FIT_CENTS", "evidence": "WITHHOLDING_SOURCE"},
  "evidence": "PAYROLL_INSTRUCTION_SOURCE"
}
```

4. Inspect `payroll inspect --business BUSINESS_ID --calculation CALCULATION_ID`.
   Its `paycheck` gives automatic FICA recovery, Roth, and cash. Outstanding
   regular employee FICA is collected from pay after current withholding and
   before Roth. A requested Roth amount that does not fit is refused. Do not
   supply manual recoveries to a new calculation.
5. After the actual payment, `payroll post` takes
   `{request,business,calculation,settlement}`. Use
   `settlement:{kind:"Bank",reference,paidOn,amount}` with the native Mercury
   transaction ID, actual bank date, and integer cents. The positive amount must
   match calculated cash, or the Roth remittance when cash is zero. When both
   cash and Roth are zero, use `settlement:{kind:"NoTransfer"}`; no bank identity
   or penny transfer is needed. Read the posted wage and remaining work.

Native rules calculate FICA/FUTA/state unemployment amounts from stored policy.
Do not add a second tax calculator or insert an assumed rate to clear a refusal.
New Roth deductions require applicable election timing and employee allowance.
`recovery record` attributes money actually deducted; it cannot manufacture a
recovery or change cash. See [payroll inputs](src/payroll.ts) and
[recovery inputs](src/recoveries.ts) for evidenced tax revisions and recoveries.

## Record a tax payment

Read the audit/register for the account, liability entries, existing payments,
and references before recording money already sent.

- `payment record`: `{request,business,account,sentOn,amount,evidence,references,artifacts}`.
  A reference is `{issuer,scope,value,sourceText}`; an artifact is its UUID.
  Preserve acknowledgement strings and source text. Optional
  `settlement:{settlesOn,evidence}` records settlement separately from send date.
- `payment reconcile`: `{request,business,payments,resolveIssues}`. Each payment
  attribution is `{payment,period:{start,end},evidence,entries:[{revision}],adjustments}`.
  Supply its complete allocation, including every payment affected by a move.
  Entries plus separately evidenced signed adjustments must equal actual money.
  Use empty arrays only when no such evidence/items exist.

Negative entries need `negativeApplicationEvidence`; nonzero adjustments need
`{amount,period:{start,end},evidence}`. Filing adjustments do not substitute for
payment adjustments. Use `payment dispose` only for an evidenced disposition of
an unallocated negative entry. See [payment inputs](src/payments.ts).

Finish by checking the payment equation and work register. Recording a payment
does not submit its return.

## Prepare or record a submitted form

Inspect the filing and its current version first. Retrieve the exact supporting
files; `artifact record` hashes local bytes using
`{request,business,file,mediaType,evidence}`. For an existing artifact,
`artifact verify` checks retrieved bytes and `artifact locate` records a new
location. Archive documents in the configured private location, discoverable
from existing records; verify uploaded bytes before recording that location.

`filings prepare` takes `{request,business,filing,evidence,documents}` with each
document `{slot,role,artifact,part,file}`. It freezes the reported basis and
verifies the bytes. [Form policy](src/schema/vocabulary.ts) defines required slots;
use the exact filed version and manifest when recording a completed submission.
Preparation does not generate a tax-form PDF or prove submission.

After actual submission, `filings submit` takes
`{request,business,version,method,manifest:[{slot,file}]}`. Choose its evidenced method:

| Method | Payload and evidence |
|---|---|
| Digital | `{kind:"Digital",submittedOn,evidence,reference?:{value,sourceText}}` |
| Certified mail | First `mailing record` with `{request,business,carrier:"USPS",number,mailedOn,receipt,evidence,artifacts}`; `receipt` is the receipt artifact UUID. Then `{kind:"CertifiedMail",mailing}` uses the returned mailing UUID. |
| Grandfathered | `{kind:"Grandfathered",evidence}` only for already imported historical eligibility; never grant this eligibility to new work. |

Certified mail requires the actual tracking number. One packet may serve several
forms; each form still needs its own submission and document manifest. Mailing
or digital submission is not proof of agency acceptance. Verify completion with
`filings inspect` and status. A zero-tax correction can still require filing.

Use `filings reject` for a rejection, `filings amend` for a correction of a
submitted return, and `filings deadline` for an evidenced deadline change.
Tax reassessment uses `payroll revise-tax`, preserving the wage, actual deductions,
and payments while linking required amendments. Read [filing inputs](src/filings.ts)
and [payroll inputs](src/payroll.ts) for these less common operations.

## Update retirement records or compensation

For a new signed election, verify/archive the document and inspect the employee's
current election document. `election document` records
`{request,business,employee,year,signedOn,artifact,evidence,amounts}`; supply
`supersedes` with the current document UUID when replacing it. `amounts` contains
all four contribution kinds declared in [ElectionDocumentInput](src/policy/annual.ts).
Use actual document amounts, including explicit zeros.

This preserves signed-document history. It does not create a deduction or transfer.
Use `election record` with `{request,business,document,effectiveOn}` to activate
it. `document` is the signed document UUID; `effectiveOn` is the actual prospective
start date. The command derives signature date, year, Roth target, and annual
allowance from the document, retirement annual review, and active policy.
It closes an earlier authorization when replacing it. All historical Roth
continues to count against the shared annual allowance. A replacement cannot
backdate past signing or displace deductions already using the prior election.

Read `report year` for plan/account/contribution IDs, current capacity, receipt
progress, supplied reports, and Mercury bank traces. The active sources are
`EmployeeRothDeferral` and `EmployeeAfterTax`. This is bookkeeping: no employer
profit-sharing feature and no 1099-R calculation or generation.

All bookkeeping writes use `pnpm cli bookkeeping --input private/intent.json`
with `{request,business,evidence,operation}`. Read the closed `Operation` schema
in [bookkeeping inputs](src/bookkeeping.ts) for exact fields.

| Task | Operations and meaning |
|---|---|
| Record ordinary owner cash | `BankMovement` records the actual native Mercury `reference`, direction, date and cents. `Distribution` allocates its cents to the sole owner. Both IDs are retained. |
| Return part of a distribution | Record an inflow, then `DistributionReturn` linking the original distribution. This invalidates the annual review. |
| Plan new after-tax funding | `AuthorizeAfterTax` checks current signed election, annual limits, compensation, receipt reconciliation and setup. It reserves capacity; it sends no money. `CancelAuthorization` releases an entirely unspent reservation. |
| Record actual after-tax funding | Reuse the authorization, or record an already completed `Contribution` as observed. Record the bank movement and distribution, then `FundContribution` linking all three. The distribution allocation is reused, so cash is counted once. |
| Record withheld Roth funding | Payroll already creates the contribution and deduction link. `FundContribution` links the Mercury remittance to that contribution. Never create another wage or deduction. |
| Confirm provider receipt | `ProviderReceipt` records the actual account, source, contribution year, provider operation reference, amount and allocations. Supply `receivedOn` only when the actual date is known; otherwise the recording-day observation stays separate. `AllocateReceipt` can link previously unallocated amounts later. |
| Record an automatic or later conversion | Include `conversion` in the confirmed provider receipt, or use `Conversion` later. The supported active route is after-tax to plan Roth. Allocate principal from receipts; store actual converted amount separately. Receipt alone never proves conversion. |
| Store supplied records | `SuppliedTax` stores externally supplied basis/taxable amounts; absence is unknown. `SuppliedReport` links supplied form data to an artifact. `ConfirmReportedConversion` links a whole historical receipt covered by that report when individual conversion dates are absent. It cannot duplicate dated conversion allocations. |
| Annual handoff | `DistributionReview` freezes the exact annual distribution/return/funding set. Later changes invalidate it. `Balance` records a dated provider balance. |

All movements require unique nonblank Mercury IDs. Reuse existing IDs on retries.
The bank outflow, distribution, contribution, receipt, and conversion are different
facts about the flow of money. A conversion is neither another contribution nor
another company cash payment. Actual observations can retain excess or conflicting
provider facts; they do not authorize more contributions.

Withheld Roth remains a payroll blocker until funding and matching plan receipt
are complete. Unused voluntary after-tax targets and conversion follow-ups are
advisories. Setup and receipt discrepancies block new retirement funding. Use
`ResolveSetup` or `ResolveIssue` only when evidence addresses the recorded issue.
Outstanding conversion follow-ups survive the year boundary.

Externally prepared retirement forms use the same filing register as payroll
forms. `filings expect-retirement` takes
`{request,business,plan,form,year,opensOn,dueOn,evidence}` with `F1099RIRS` or
`F1099RRecipient`; supply reviewed deadlines for the chosen delivery method.
Prepare and submit their exact external artifacts through the ordinary filing
commands. A recorded conversion also prompts missing filing expectations at
year end. The app freezes bookkeeping evidence and tracks completion.

`compensation budget` records an evidenced employee/year target;
`compensation assign` assigns an existing commitment to it. Employee/profile
changes and review resolutions use [profile inputs](src/profiles.ts). Resolve a
review only from evidence addressing that review's actual issue.

## Refresh a reporting year

Inspect policy before changing it. `policy install` must provide reviewed calendar
coverage before `policy annual` can reference that release and year. The annual
record stores public rules and source artifacts; `policy evidence` records
employer-specific applicability. A release may support reporting while payroll
evidence is incomplete. Once its executable payroll coverage is complete,
`policy refresh` approves each annual jurisdiction for the release and
`policy activate` selects it. Federal and state approvals both expire at year end.
Retirement also needs a fresh `Annual` record for each year: limits, compensation
cap, outside activity and asset attestations. Values never carry forward.
Missing evidence stays missing; historical payments are not proof of an assigned rate.

Once reviewed calendar coverage is available, `filings ensure` with
`{request,business,throughYear}` materializes applicable forms idempotently.
Initial enrollment also needs `enrollment:{startsOn,evidence}`. New employee W-2
applicability is added atomically when wages post. Read [annual policy](src/policy/annual.ts),
[release inputs](src/policy/install.ts), and [filing coverage](src/filing-coverage.ts)
only as needed. Re-read policy and status to confirm coverage and remaining work.

## Back up or maintain the ledger

Use `db backup --operation OPERATION_ID --output ARCHIVE_PATH`, then
`db verify-backup --archive ARCHIVE_PATH`. Operation IDs are UUIDv7; retry the same
operation with the same paths. Verification restores independently and compares
all facts. The archive includes private provenance and command recovery;
referenced documents must remain available in their configured document storage.

Publish to the existing CURRENT backup by file identity, using the destination
and retention policy from private records. Download it, byte-compare, and run
`db verify-backup` on that download before retiring a prior working copy.
Retain historical originals when the user requires them.

Recovery uses `db restore --operation OPERATION_ID --archive ARCHIVE_PATH
--directory NEW_DIRECTORY --binding-output NEW_FILE`. Inspect the restored audit
before deliberately adopting its binding. Prior-incarnation request envelopes
remain evidence and cannot be replayed against the restored history.

The canonical initial baseline is `migrations/0000-initial/`, generated by
BumbleDB Log 1.3.1. `pnpm schema:check` verifies its snapshot and TypeScript
bindings; schema generation does not transfer facts or upgrade a working store.
Read [migrations](docs/migrations.md) for a cutover or schema change. Retain the
transition contract before dispatch, resolve uncertainty under that identity,
compare facts and reports before activation, then adopt the returned binding.
Keep original request/evidence bytes. A schema mismatch requires the matching
bindings or an explicit transformation; never hide it with an empty database.

Keep company identities, account details, real examples, rates, evidence, database
files, and operational notes out of this skill and tracked code. Discover them
from the selected ledger and private records. Use domain commands, never generic
fact edits. Run `pnpm check` before publishing code and verify that private files
remain untracked.
