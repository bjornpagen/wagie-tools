# wagie-tools

Payroll for the wagie who signs their own checks.

A local payroll and bookkeeping ledger for a single-owner Texas S corporation:
weekly paychecks against a salary target, Roth deferrals, owner distributions,
the mega backdoor Roth, federal and Texas payroll taxes, and the returns that
report them. TypeScript and Effect over [BumbleDB](https://www.npmjs.com/package/@bjornpagen/bumbledb).

[Operating skill](SKILL.md) · [Data model](src/schema.ts)

## The model

Every fact is stored once, and every invariant the data can state is a law the
database judges on each write: keys, containment, capacity, closed rosters,
sum types and half-open intervals.

- **A paycheck is one row a day**, its earnings a slice of the year's wage axis
  `[ytd, ytd + gross)`. Social security, FUTA and SUTA tax the part of that
  slice under their wage bases, so crossing a base is not a special case.
- **Money out is a Mercury transfer**, keyed by Mercury's Tracking ID, with one
  arm saying what it paid: net pay, a Roth deferral, an after-tax contribution,
  a distribution, or a tax debit.
- **A tax payment** is one row for EFTPS and TWC alike, keyed by its EFT or
  confirmation number and funded by its Mercury debit. Filing a return never
  clears money owed; only payments do.
- **A filing** records how it was filed (certified mail, e-file, or furnished)
  and every line as filed. A 941-X is a correction of its 941.
- **History that predates these rules** is held by import-only legacy rows,
  capped by closed rosters no operation can grow.

Payroll is a system of checks and balances. `status` lists what is owed, when
it opens and falls due, and the op that clears it: a wire to send, a deposit, a
balance, a return, a correction. `payroll.post` refuses while anything due by
its day is open.

## Use

Node 24 or newer.

```sh
pnpm install
node src/cli.ts                     # the ops
node src/cli.ts status              # what blocks payroll, what comes next
node src/cli.ts payroll.quote '{"paidOn":"2026-10-09","input":{"by":"plan"}}'
```

One op, one JSON object in, one JSON object out. Money is dollars with two
decimals (`"8000.00"`), days are `"2026-10-02"`, periods `"2026"`, `"2026Q3"`
or `"2026-10"`. Input is strict and parsed once at the boundary. A refusal
prints `{code, message}` and exits 1.

The ledger lives in the ignored `private/ledger/`. `export` writes every fact as
canonical JSON to `private/Wagie Tools - CURRENT.facts.json`: that file is the
backup, and `import` restores it into a fresh ledger. A schema change is the
same path: export, transform, import.

## Layout

- `src/schema.ts`: rosters, relations and laws.
- `src/check.ts`, `src/gross-up.ts`: a paycheck's arithmetic and how it is sized.
- `src/forms.ts`: every line of every return, computed from the facts.
- `src/obligations.ts`: what is owed and what blocks payroll.
- `src/reports.ts`, `src/calendar.ts`: reports, and deadlines rolled past
  weekends and DC holidays.
- `src/ops.ts`, `src/cli.ts`, `src/db.ts`: the op table, the command line and
  the store.

`pnpm check` runs the typecheck, lint and tests.
