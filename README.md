# PersonalFinanceApp

A single-user personal finance ledger. Runs entirely in the browser on GitHub
Pages; reads and writes its data to a separate **private** repository through
the GitHub Contents API.

## Repositories

| repo | visibility | contents |
|---|---|---|
| `PersonalFinanceApp` | public | this app — HTML, CSS, JS. No data, no secrets. |
| `MyFinanceData` | **private** | `ledger.json` (transactions), `annotations.json` (labelling) |

Code and data are deliberately separate. Updating the app cannot touch the
data; importing a month cannot touch the code.

## Files

- `index.html` — shell and markup
- `styles.css` — all styling
- `core.js` — CSV parsing, fingerprinting, integrity checks, role rules, matchers, GitHub client. No DOM access.
- `app.js` — UI, import flow, labelling views

## Setup

Open the site, then **Settings**: GitHub username, data repo name, and a
fine-grained personal access token scoped to `MyFinanceData` with
**Contents: read and write**. The token is stored in `localStorage` on that
device only and is sent nowhere except `api.github.com`.

## Monthly routine

1. Export CSVs from Swedbank and Amex
2. **Import CSV** — parses in the browser, shows a diff, commits on confirmation
3. Label any merchants it hasn't seen before
4. **Save**

## Things that are load-bearing

**Fingerprints.** `Radnummer` shifts between exports and cannot be an identity
key. Balance alone is insufficient: on 2025-10-22 three transfers
(+2500 / −2500 / +2500) leave two rows byte-identical *including* the running
balance. Identity is `sha256(account|date|tdate|ref|desc|amount|balance)` plus
an occurrence index within the colliding group.

**Two CSV dialects.** Swedbank is CP1252, ISO dates, decimal point, ASCII
hyphen, outflow negative, and carries a running balance. Amex is UTF-8, US
`MM/DD/YYYY` dates, decimal comma, **U+2212 MINUS SIGN**, charges *positive*,
real newlines inside quoted address fields, no balance. Amounts are normalised
to Swedbank's convention on import.

**Card identity comes from the Amex side.** Corporate references start `057000`;
private start `AT`. Swedbank's own letter case (`American Express` vs
`AMERICAN EXPRESS`) happens to distinguish them too, but its casing drifts —
salary flips `LÖN` → `Lön` in May 2026 — so it is never used as a key.

**Balance-chain check.** For rows in export order,
`balance[i] − amount[i] === balance[i+1]`. A break means the export is missing
rows, and the import is refused rather than silently accepted.

**Matchers run across the whole ledger**, never only the new rows: a December
expense reimbursed in February spans two imports by definition.

**Reimbursements are not matched line-by-line.** The join key is McKinsey's XPD
expense-report ID, which exists only in their system. Subset-sum matching
produces confident nonsense. The float is tracked in aggregate instead.
