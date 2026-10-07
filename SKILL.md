---
name: wagie-tools
description: Run payroll, wires, tax payments, filings, distributions, the mega backdoor Roth and the plan's rollovers for a single-owner S corporation through the wagie-tools ledger's JSON ops.
---

# Wagie Tools

```sh
node src/cli.ts <op> '<json>'
node src/cli.ts                  # every op with a one-line summary
```

- Money is dollars with two decimals, as a string: `"8000.00"`, `"0.01"`.
- Rates are percents, as a string: `"6.2"`, `"1.45"`.
- Days are `"YYYY-MM-DD"`. Periods are `"2026"`, `"2026Q3"` or `"2026-10"`.
- Unknown keys refuse. A refusal prints `{code, message}` and exits 1.
- Every write prints `"outcome": "committed"`, or `"no-change"` when the same
  facts are already there. Running a write twice is safe.

**The Tracking ID.** Every transfer is recorded by Mercury's Tracking ID: in
the transaction's detail panel under "Transaction tracking number" (or the
CSV export's `Tracking ID` column). It is `YYYYMMDDMMQFMP4S######` for wires
and send-money transfers, a 15-digit ACH trace for IRS and TWC debits. A
transaction UUID is refused.

**Waiting for a wire.** A sent wire shows Pending until Mercury gives it its
Tracking ID, usually within 10 minutes. Wait with a background timer, never a
foreground sleep: 10 minutes, then ×1.5 each time (15, 22, 33, 50), checking
the transaction's detail panel each time. Record and back up as soon as it has
its ID. A scheduled wire goes out the next business day around 13:00 UTC;
check then. This is part of the task, not a follow-up check.

**The machine.** Node 24+ and pnpm, from MacPorts, `nodejs24` first:

```sh
sudo port install nodejs24
sudo port install pnpm
pnpm install --frozen-lockfile
```

**The ledger** is `private/ledger/`. The copy that counts is the backup in
Google Drive, `Payroll/Backups/Current/Wagie Tools - CURRENT.facts.tar.xz`.
Start each session from it: move any existing `private/ledger/` aside to
`private/ledger.bak-<day>/` (`import` needs a fresh ledger), then

```sh
tar -xJf "<downloaded archive>" -C private
node src/cli.ts import '{"file":"private/Wagie Tools - CURRENT.facts.json"}'
```

Every write ends with a new backup (see Backup).

**Who presses what.** Claude works in the owner's Chrome. At the start, ask
the owner to sign in to Carry and Mercury. Claude never types passwords,
routing numbers or account numbers; Claude Code's auto mode may block other
writes too. When either happens, give the owner the exact field and value to
paste, and carry on. Fill in Carry and Mercury forms completely, then stop at
the last screen: the owner says yes before a Carry form is submitted, and
presses Send on every Mercury wire.

**What a task never includes:** notes files, receipts or confirmation PDFs,
dated copies in `Backups/Old/`, scratch-ledger round trips, a sweep to a Roth
IRA unless asked, or a follow-up check. A task ends with its backup.

**Start with `status`.** `blockers` stop payroll, each naming the op that
clears it; `upcoming` is what opens later.

## Setup

`setup` creates the ledger once:

```sh
node src/cli.ts setup '{"employer":{"name":"…","tin":"…","address":"…"},"employee":{…},"plan":{…},"registrations":[{"state":"TX","number":"…"}],"employment":{"from":"2026-01-02","state":"TX"},"custody":{"Pretax":{"custodian":"Carry","number":"…"},"AfterTax":{…},"Roth":{…}}}'
```

## Changing setup

Each replaces one fact whole:

```sh
node src/cli.ts party.set '{"role":"Employee","name":"…","tin":"…","address":"…"}'
node src/cli.ts registration.set '{"state":"TX","number":"…"}'
node src/cli.ts custody.set '{"account":"Roth","custodian":"Carry","number":"…"}'
node src/cli.ts employment.end '{"lastDay":"2027-06-30"}'
node src/cli.ts employment.start '{"from":"2027-09-01","state":"TX"}'
```

## Each year's policy

From December 1 `status` shows next year's policy as upcoming; from January 1
it blocks. Set it per jurisdiction, each time whole:

```sh
node src/cli.ts policy.set '{"jurisdiction":"Federal","year":2027,"limits":{"deferralLimit":"…","additionsLimit":"…","compensationLimit":"…","wageCeiling":"200000.00"},"rates":{"SocialSecurity":{"rate":"6.2","base":"…"},"Medicare":{"rate":"1.45"},"FederalUnemployment":{"rate":"0.6","base":"7000.00"}}}'
node src/cli.ts policy.set '{"jurisdiction":"TX","year":2027,"rates":{"TexasUnemployment":{"rate":"…","base":"9000.00"}}}'
node src/cli.ts election.set '{"year":2027,"roth":"…","afterTax":"…","signedOn":"…"}'
node src/cli.ts plan.set '{"year":2027,"salary":"…","fitPerCheck":"0.01"}'
```

A rate without a `base` taxes every dollar. The Roth and after-tax elections
together stay within the year's 415(c) limit.

## Payroll

1. `status` shows no blockers.
2. Quote the paycheck. `by` is `"plan"` (keeps the year on its salary target),
   `"gross"` with `gross`, or `"net"` with `net`. `roth` is optional; `fit`
   defaults to the year's plan.

   ```sh
   node src/cli.ts payroll.quote '{"paidOn":"2026-10-09","input":{"by":"plan","roth":"500.00"}}'
   ```

3. Post it with the same input: `payroll.post`. It prints the wires to send.
4. Send both wires from Mercury: net pay to the owner; the Roth deferral to
   Carry as in the mega backdoor Roth's steps 2–3, with To "Solo 401k Roth".
5. Once they show Sent, record each with its Tracking ID:

   ```sh
   node src/cli.ts transfer.record '{"kind":"NetPay","paidOn":"2026-10-09","mercury":"20261009MMQFMP4S000123","sentOn":"2026-10-09","amount":"1234.56"}'
   node src/cli.ts transfer.record '{"kind":"RothDeferral","paidOn":"2026-10-09","mercury":"20261009MMQFMP4S000124","sentOn":"2026-10-09","amount":"500.00"}'
   ```

## Federal deposit (EFTPS)

`status` lists each month's 941 deposit, due the 15th of the next month. Pay
it in EFTPS; once the debit has posted in Mercury, record it with its EFT
number and the debit's Tracking ID:

```sh
node src/cli.ts tax.paid '{"tracker":"270000000000001","account":"Federal941","kind":"Deposit","period":"2026Q4","amount":"612.34","initiatedOn":"2026-11-12","mercury":"061036010000001","sentOn":"2026-11-13"}'
```

`period` is the quarter the deposit pays (the year for `Federal940`). `kind` is
`Deposit`, `Balance` (a balance due with a return, a 941-X or a notice) or
`Penalty` (a notice's penalty or interest).

## Texas UI (TWC)

The same, with account `TexasUI`, the quarter, and the TWC confirmation number
as `tracker`.

## Mega backdoor Roth

An after-tax contribution that Carry converts to Roth inside the plan.

1. `status`: no blockers, and `afterTax.room` covers the amount.
2. Carry (app.carry.com): Accounts → Solo 401k → Deposit.
   - To: "Solo 401k Mega Backdoor Roth" (it defaults to Roth).
   - From: "Domestic Wire Transfer", never a linked bank.
   - The tax year and the amount. The amount Carry shows available must equal
     `afterTax.room`.
   - Continue: "Confirm your deposit" reads To "Solo 401k After-Tax", Transfer
     To "Solo 401k Roth". Show the owner; on their yes, Continue.
   - Wire Details: the bank, routing, account, beneficiary, FBO (the after-tax
     account in `custody`) and a memo with a code unique to this deposit.
     Confirm.
3. Mercury (app.mercury.com): Payments → Recipients → the Carry recipient
   whose account number is the one on Carry's Wire Details → Send money.
   Carry recipients are named by that number, "Carry (DriveWealth ••1234)";
   the memo, not the account, decides which Carry account the money reaches.
   If no recipient has the number, create one; the owner pastes the routing
   and account on the Recipient step.
   - Recipient: Wire.
   - Amount: exactly the amount, from the main checking.
   - Wire purpose: Other, "Solo 401(k) retirement plan contribution,
     <employer>".
   - Details: replace the memo "via mercury.com" with Carry's memo, exactly.
   - Review: bank, routing, account, beneficiary, amount and memo must match
     Carry's Wire Details; if anything doesn't, stop. The owner presses Send
     (or "Schedule wire" after the day's cutoff).
4. Once it shows Sent (a scheduled wire, the next business day), record it.
   Until then there is nothing to record or back up.

   ```sh
   node src/cli.ts transfer.record '{"kind":"AfterTax","year":2026,"mercury":"20261015MMQFMP4S000200","sentOn":"2026-10-15","amount":"5000.00"}'
   ```

   `status` then shows `afterTax.room` less, and `rothBasis.awaiting` more,
   by the amount.
5. Back up.

A contribution counts toward a year only if sent in it or by January 30 of the
next.

## Rollover

Every rollover sweeps a whole account into the owner's Roth IRA. Record it
with the day and the amount that left. The after-tax account is never swept:
Carry converts it.

```sh
node src/cli.ts plan.rollover '{"account":"Roth","on":"2026-11-02","gross":"25000.00"}'
```

## Distribution

```sh
node src/cli.ts transfer.record '{"kind":"Distribution","mercury":"20261015MMQFMP4S000201","sentOn":"2026-10-15","amount":"8000.00"}'
```

## Quarter end

1. `node src/cli.ts report '{"year":2026,"quarter":4}'` prints every line of
   the 941 and the C-3.
2. Prepare both from it. Mail the 941 by certified mail; file the C-3 online.
   If a return differs from the report, fix the ledger first.
3. Record them:

   ```sh
   node src/cli.ts filing.record '{"form":"F941","period":"2026Q4","method":"CertifiedMail","mailedOn":"2027-01-20","tracking":"9400100000000000000001"}'
   node src/cli.ts filing.record '{"form":"C3","period":"2026Q4","method":"Electronic","on":"2027-01-15","confirmation":"12345678"}'
   ```

## Year end

`report '{"year":2026}'` prints the 940, W-2, W-3 and, when there were
after-tax contributions or a rollover, the 1099-R and 1096. Pay any FUTA
balance (`tax.paid`, `Federal940`). Each form takes the methods it allows:

| Form | Method |
|---|---|
| `F941`, `F940`, `F1096` | `CertifiedMail` |
| `W3` | `CertifiedMail` or `Electronic` (SSA BSO) |
| `C3` | `Electronic` |
| `W2`, `F1099R` | `Furnished` (the recipient's copy, with the day it was given) |

```sh
node src/cli.ts filing.record '{"form":"W2","period":"2026","method":"Furnished","on":"2027-01-20"}'
```

## Correction

`payroll.correct` reprices a posted paycheck: `fit` or `roth` on any paycheck,
`gross` only on the year's latest. Then follow the blockers:

- underpaid: wire the difference and `transfer.record` it as `NetPay`;
- overpaid: nothing to do; the next `payroll.post` recovers it;
- a deposit short: pay it;
- a filed quarter's wages or FIT changed: the quarter's `report` shows the
  941-X under `forms.F941.correctionDue`. Mail it by certified mail, record
  it, then pay its line 27 as a `Balance`:

  ```sh
  node src/cli.ts filing.correct '{"form":"F941","period":"2026Q3","mailedOn":"…","tracking":"…"}'
  ```

A filed 1099-R that no longer matches shows in `status` under `mismatches`
without blocking payroll. The year's `report` shows the correction under
`forms.F1099R.correctionDue`: each changed box, and the new 1096 (`count`,
`gross`). Prepare each changed form again, marked CORRECTED, with every box as
`forms.F1099R.lines` shows it. Mail Copy A with the new 1096 by certified
mail, give the owner Copy B, and record it:

```sh
node src/cli.ts filing.correct '{"form":"F1099R","period":"2025","mailedOn":"…","tracking":"…"}'
```

Every return but the 1096 can be corrected, one correction a day, each mailed
after the return it corrects under its own tracking number:

- `F940` and `C3` work like the 941-X: pay the change as a `Balance`. For a
  C-3 adjusted online, `mailedOn` is the day filed and `tracking` the TWC
  confirmation.
- `W2` and `W3` (a W-2c and its W-3c) show under `mismatches` without
  blocking. Send both together and record each with the same day and
  tracking number.

## Backup

After every write:

```sh
node src/cli.ts export        # private/Wagie Tools - CURRENT.facts.json
tar -cJf "private/Wagie Tools - CURRENT.facts.tar.xz" -C private "Wagie Tools - CURRENT.facts.json"
```

Upload the archive to Drive `Payroll/Backups/Current/` as `Wagie Tools -
CURRENT.facts.tar.xz` (Drive connector: base64, content type
`application/x-xz`, conversion off). Download it back and check its SHA-256
matches the local file, then trash the previous one. `Current/` holds exactly
one file; nothing else in Drive changes.
