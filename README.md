# wagie-tools

Payroll for the wagie who signs their own checks.

A local payroll and bookkeeping ledger for a single-owner Texas S corporation:
weekly paychecks against a salary target, Roth deferrals, owner distributions,
the mega backdoor Roth, federal and Texas payroll taxes, the plan's rollovers,
and the returns that report them. TypeScript and Effect over
[BumbleDB](https://www.npmjs.com/package/@bjornpagen/bumbledb).

[Operating skill](SKILL.md) · [Data model](src/schema.ts)

## The model

Every fact is stored once, and every invariant the data can state is a law the
database judges on each write: keys, containment, capacity, closed rosters,
sum types and half-open intervals. What follows from the facts is computed,
never stored.

- **Rosters carry the rules.** Each return, tax account, tax and plan account
  is a closed roster entry with typed columns: its jurisdiction, period, due
  rule, the ways it may be filed, the line that states what a period owes.
  Laws are generated from the rosters, and obligations interpret them.
- **Policy is data, per year.** A year's limits and wage ceiling, and each
  banded tax's slice of the year's wage axis at a rate in parts per million:
  social security to its base, Medicare without one, FUTA and Texas UI to
  theirs. Every year must price each federal tax exactly once.
- **A paycheck is one row a day** storing its gross. Its place on the year's
  wage axis, `[ytd, ytd + gross)`, follows from the paychecks before it, and
  each tax applies to the part of it inside the tax's band, so crossing a wage
  base is not a special case. What each employee tax withheld is stored as
  assessed.
- **Money out is a Mercury transfer**, keyed by Mercury's Tracking ID, with one
  arm saying what it paid: net pay, a Roth deferral, an after-tax contribution,
  a distribution, or a tax debit.
- **A tax payment** is one row for EFTPS and TWC alike, keyed by its EFT or
  confirmation number and funded by its Mercury debit. Filing a return never
  clears money owed; only payments do, and a penalty never pays tax.
- **A filing** records how it was filed (certified mail, e-file, or furnished)
  and every line as filed. Once filed, its liability line is what the period
  owes. Any return but the 1096 can be corrected, as often as needed, each
  correction restating only the lines that changed: a 941-X, whose line 27 is
  owed when sent; an amended 940 or C-3, owing the change in its liability; a
  W-2c with its W-3c; or corrected 1099-Rs, sent with their own 1096. `report`
  shows a correction before it is sent.
- **The 941 is computed the IRS way**: FICA priced on the quarter's totals,
  line 7 carrying the rounding of the employee share, and each month of line 16
  its paychecks' tax, the last month absorbing the quarter's cent.
- **The plan's books.** Roth basis enters only as Roth deferral and after-tax
  wires; Carry converts after-tax deposits to Roth as they settle. A rollover
  is a whole-account sweep into the owner's Roth IRA, and the basis it carries
  is the wires since the last sweep. The 1099-R follows.
- **History** is the span the ledger did not record. Only an import writes it,
  and only inside it may a filing be attested or a payment have been made
  outside Mercury.

Payroll is a system of checks and balances. `status` lists what is owed, when
it opens and falls due, and the op that clears it: a wire to send, a deposit, a
balance, a return, a correction, next year's policy. `payroll.post` refuses
while anything open by its day remains.

## Use

Node 24 or newer and pnpm (on macOS: `sudo port install nodejs24`, then
`sudo port install pnpm`).

```sh
pnpm install --frozen-lockfile
node src/cli.ts                     # the ops
node src/cli.ts status              # what blocks payroll, what comes next
node src/cli.ts payroll.quote '{"paidOn":"2026-10-09","input":{"by":"plan"}}'
```

One op, one JSON object in, one JSON object out. Money is dollars with two
decimals (`"8000.00"`), rates are percents (`"6.2"`), days are `"2026-10-02"`,
periods `"2026"`, `"2026Q3"` or `"2026-10"`. Input is strict and parsed once at
the boundary. A refusal prints `{code, message}` and exits 1.

The ledger lives in the ignored `private/ledger/`. `export` writes every fact as
canonical JSON to `private/Wagie Tools - CURRENT.facts.json`: that file is the
backup, and `import` restores it into a fresh ledger.

## Layout

- `src/schema.ts`: rosters, relations and laws.
- `src/check.ts`, `src/gross-up.ts`: a paycheck's arithmetic and how it is sized.
- `src/forms.ts`: every line of every return, computed from the facts.
- `src/plan.ts`: the plan's books: sweeps, the basis they carry, the 1099-R.
- `src/obligations.ts`: what is owed and what blocks payroll.
- `src/reports.ts`, `src/calendar.ts`: reports, and the due rule, rolled past
  weekends and DC holidays.
- `src/ops.ts`, `src/cli.ts`, `src/db.ts`: the op table, the command line and
  the store.

`pnpm check` runs the typecheck, lint and tests.
