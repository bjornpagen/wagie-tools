---
name: wagie-tools
description: Operate a Wagie Tools payroll ledger — payroll, Roth wires, tax payments, filings, retirement bookkeeping, policy and backups — through its JSON ops.
---

# Wagie Tools

Three verbs, one JSON object each. Everything else is data.

```sh
pnpm cli read   --input -    # {"read": "status", "business": "…"}
pnpm cli apply  --input -    # {"op": "payroll.post", "request": "…", …}
pnpm cli schema [NAME]       # every op and read, or one op's JSON Schema
pnpm cli id                  # a fresh UUIDv7 for a request or operation
```

`--input FILE` reads a file; `-` or nothing reads stdin. `--binding FILE`
selects another store; the default is `private/binding.json`, and startup
never creates an empty ledger. Output is JSON.

## Units at the boundary

- Money is dollars with exactly two decimals, as a string: `"8000.00"`, `"0.01"`.
  Never cents, never a number, never `"8000"`.
- Dates are `"YYYY-MM-DD"`. A span is `{"start": …, "endExclusive": …}`.
- Ids are UUIDv7 strings. Mint request and operation ids with `pnpm cli id`.
- `evidence` is prose: why this write is justified (the approval, the receipt,
  the document). The ledger stores each distinct text once and shows it back
  as text on every fact that cites it.
- Input is strict: unknown keys refuse. A refusal names every bad path at once.

Units come from field names and never vary: `amount`, `gross`, `roth`, `limit`,
`taxable` are always money; `paidOn`, `dueOn`, `signedOn` are always dates;
`period`, `valid`, `work`, `span` are always spans; `year`, `row`, `sequence`,
`forms`, `numerator`, `denominator` are plain JSON integers. Closed vocabularies
(`kind`, `form`, `issuer`, `filingStatus`, `distributionCode`, …) are listed as
`enum` in `schema`; anything outside the list refuses.

## Start every task with `status`

```json
{"read": "status", "business": "BUSINESS_ID"}
```

Don't know the business id? `{"read": "businesses"}` lists every business and
its employees with their ids.

`status` returns only what is open:

- `blockers`: items that stop new payroll right now. Clear these first.
- `open`: every open item, blockers included. Each carries `rule`, `label`,
  `amount`, `dueOn`, and `next`: the op that moves it forward and the input
  fields the ledger already knows. Add `request`, `evidence`, and whatever
  only the outside world knows (a Mercury id, a date, an amount).
- `readiness`: notes on figures (an open review question, unattributed recovery,
  an unarchived document). They do not block.

`{"read": "work", …}` returns every item including complete ones. `asOf`
(`"YYYY-MM-DD"`) on status, work, report and filings.inspect changes the view.

Other reads: `report` (`year`, optional `quarter`), `business.inspect`,
`questions`, `filings.inspect`, `policy.inspect`, `payroll.inspect`
(`calculation`), `compensation.suggest`, `artifact.audit`, `command.resolve`
(`request`), `businesses`, `db.audit` (every fact digest; large).

## Writes

Every write is `{"op": NAME, "request": UUIDv7, "business": ID, …}`. The
request id is the intent's identity: keep the same id and payload on retry, and
never reuse one for a different intent. A committed receipt has
`outcome.result`; payroll ops add figure readback. A `ReconciliationRequired`
result exits nonzero and opens a question in `status`.

If a write is interrupted, `{"read": "command.resolve", "request": ID}` first.
Committed or no-change settles it. Anything else: read the reason before doing
anything, and never treat uncertainty as permission to send money again.

Run `pnpm cli schema OP` before an unfamiliar op. It is the authority on fields.

## Recipes

### Regular payroll

1. `status`. Clear blockers through their `next` ops.
2. Gross: use `compensation.suggest` (`employee`, `paidOn`, `work`) or the
   owner's figure. Federal income tax withholding is a supplied, evidenced
   input, never a default or a guess.
3. Calculate:
   ```json
   {"op": "payroll.calculate", "request": "…", "business": "…", "employee": "…",
    "purpose": {"kind": "NewWage", "paidOn": "2026-10-07", "gross": "2301.37", "roth": "0.00",
                "work": {"start": "2026-09-30", "endExclusive": "2026-10-07"}},
    "fit": {"amount": "0.01", "evidence": "…"}, "evidence": "…"}
   ```
   The readback shows `paycheck`: automatic recovery of prior employee FICA,
   Roth, and `cash`. Nothing is posted yet.
4. Send the Mercury payment for exactly `cash`.
5. Post, with the real Mercury transaction id, bank date and amount:
   ```json
   {"op": "payroll.post", "request": "…", "business": "…", "calculation": "…",
    "evidence": "Owner approved; Mercury sent",
    "settlement": {"kind": "Bank", "reference": "MERCURY_ID", "paidOn": "2026-10-07", "amount": "2125.31"}}
   ```
   Posting checks the register at the real employer date and refuses a stale
   calculation. `{"kind": "NoTransfer"}` only when cash and Roth are both zero.

### Employee Roth wire (zero cash pay)

The owner wants exactly `$X` to reach the plan as employee Roth. Do not solve
for gross by hand: `RothOnly` finds the smallest gross whose paycheck leaves
exactly zero cash after employee FICA, supplied FIT and automatic recovery.

```json
{"op": "payroll.calculate", "request": "…", "business": "…", "employee": "…",
 "purpose": {"kind": "RothOnly", "paidOn": "2026-09-16", "roth": "8000.00",
             "work": {"start": "2026-09-09", "endExclusive": "2026-09-16"}},
 "fit": {"amount": "0.01", "evidence": "Owner-directed withholding"},
 "evidence": "Owner requested an $8,000.00 Roth wire"}
```

Readback: `figures.input.gross` is the wage, `paycheck.cash` is `0.00`. Show the
owner gross, each deduction, Roth and taxes remaining payable, then:

1. Owner (or you, if authorized) sends the wire to the plan provider for `roth`.
2. `payroll.post` with `settlement.amount` = `roth` and the Mercury id. This one
   write creates the wage, deduction, bank movement, contribution and funding
   link. Do not also fund the contribution.
3. Download the Mercury wire receipt (Created or Sent both count).
   `artifact.record` its file, then `artifact.attach-bank` to the movement (its
   id is in the post readback or `report`). The `roth-remittance` blocker
   completes here.
4. That is the whole job. The Mercury receipt is the evidence; the plan
   provider's own confirmation is not tracked and never asked for.

Requirements the ledger enforces: a current signed election and allowance for
the year (`election.document`, `election.record`), the year's retirement
`retirement.annual`, and remaining capacity. `EmployeeRothDeferral` and
`EmployeeAfterTax` are different sources; use the one requested.

### Provider year-end reports

`retirement.supplied-report` records a provider's form as stated, never derived:
`plan`, `year`, `artifact`, `evidence` and `report`, either
`{"form": "F1099R", "account", "distributionCode": "G" | "H", "gross", "taxable", "basis"?}`
(box 5 only when the form states it) or `{"form": "F1096", "forms", "gross"}`.
`retirement.confirm-reported-conversion` then confirms a receipt's conversion
from that report when the provider supplied no event date.

### Record a tax payment already sent

`payment.record`: `account`, `sentOn`, `amount`, `evidence`, `references`
(`[{issuer: "EFTPS" | "TWC", value}]`, the acknowledgement numbers), `artifacts`,
optional `settlement: {settlesOn, evidence}`. Then `payment.reconcile` with the
complete attribution: `payments: [{payment, period, evidence, entries: [{revision}], adjustments}]`.
Entries plus evidenced adjustments must equal actual money. A negative entry
needs `negativeApplicationEvidence`. Recording does not submit a return. A
negative entry settled without a payment is `payment.dispose` with
`disposition`: `Refunded`, `Credited` or `Abandoned`, plus evidence.

### Prepare and submit a form

`filings.prepare` (`filing`, `evidence`, `documents: [{slot, role, artifact, part, file}]`)
freezes the reported basis and verifies bytes. After the actual submission,
`filings.submit` (`version`, `manifest`, `method`): `{"kind": "Digital", "submittedOn", "evidence", "reference"?}`,
or `mailing.record` first then `{"kind": "CertifiedMail", "mailing"}`.
`Grandfathered` is for imported history only. `filings.amend` opens a
correction; `filings.deadline` records an evidenced change; `payroll.revise-tax`
reassesses a posted wage.

### Questions

An open question is a fact: `question.ask` with a `subject` of kind `Review`
(employee, year, topic), `PlanSetup` (plan), `Bookkeeping`, or `TaxAccount`
(account). The kind decides what it holds back; `question.answer` closes it
with evidence. Answer only from evidence that addresses the question.

### Documents

Documents live in Google Drive, never in the database or its backups; the
ledger keeps each one's Drive file id and SHA-256. `artifact.record` hashes a
local file. Upload the same bytes to Drive, then `artifact.archive` (`artifact`,
`driveFileId`, `remote`, `evidence`) downloads them by id with rclone, checks the
hash and records the copy. A document without a Drive copy shows in
`status` under `readiness`. `artifact.audit` with `verify: true` re-reads every document.

### Policy year

`policy.install` a release with reviewed calendars, then `policy.annual`,
`policy.evidence`, `policy.refresh` per authority, `policy.activate`.
`retirement.annual` each year. Values never roll forward; missing coverage
blocks payroll and says so in `status`.

### Backups

A backup is one `.tar.xz` file holding the database and nothing else. All three
are `apply` ops:

```json
{"op": "db.backup", "output": "Wagie Tools - CURRENT.bumbledb.tar.xz"}
{"op": "db.verify-backup", "archive": "Wagie Tools - CURRENT.bumbledb.tar.xz"}
{"op": "db.restore", "archive": "Wagie Tools - CURRENT.bumbledb.tar.xz", "directory": "private/ledger", "bindingOutput": "private/binding.json"}
```

`db.backup` refuses an existing output path and refuses while a write is
unresolved. `db.verify-backup` restores into a throwaway directory and checks
every fact against the digest captured at backup time. `db.restore` needs a new,
empty directory and a binding path that doesn't exist yet. The Drive copy is
`Wagie Tools - CURRENT.bumbledb.tar.xz` in the Wagie Tools folder: replace it
with a fresh `db.backup` after changes worth keeping.

## Rules

- Sending money and submitting forms are external. The ledger records their
  evidence. An absent record does not prove an action never happened.
- Never invent a Mercury id, a date, or a withholding amount. Never reuse a
  historical figure as a default.
- Native rules price tax from stored policy. Do not add a second calculator.
- Keep company identities, account numbers, real amounts and private Drive ids
  out of this repository. They live in the ledger and under `private/`.
- Retained requests, receipts and evidence live under `private/` and are never
  force-added to Git.
