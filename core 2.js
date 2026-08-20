/* core.js — parsing, ledger logic and GitHub sync.
   No DOM access in this file. */

/* ---------------------------------------------------------------- CSV ---- */

/** RFC-4180 tokeniser. Handles quoted fields containing commas AND newlines,
    which Amex address fields genuinely do. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false, i = 0;
  text = text.replace(/^\uFEFF/, '');
  while (i < text.length) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { q = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
}

/** Swedbank exports are CP1252; Amex are UTF-8. Decode both, pick by content. */
export function decode(buf) {
  const utf8 = new TextDecoder('utf-8').decode(buf);
  const cp = new TextDecoder('windows-1252').decode(buf);
  if (/Transaktioner Period/.test(cp)) return { text: cp, encoding: 'windows-1252' };
  if (/Datum,Beskrivning/.test(utf8)) return { text: utf8, encoding: 'utf-8' };
  // fall back to whichever has fewer replacement characters
  const bad = s => (s.match(/\uFFFD/g) || []).length;
  return bad(utf8) <= bad(cp)
    ? { text: utf8, encoding: 'utf-8' }
    : { text: cp, encoding: 'windows-1252' };
}

export function detectDialect(text) {
  if (/Transaktioner Period/.test(text)) return 'swedbank';
  if (/Datum,Beskrivning/.test(text)) return 'amex';
  return null;
}

/* ------------------------------------------------------------- numbers --- */

/** Amex writes "−1 234,56" with U+2212 MINUS SIGN and a decimal comma.
    Swedbank writes "-1234.56" with an ASCII hyphen and a decimal point. */
export function amount(raw) {
  let s = String(raw).trim()
    .replace(/\u2212/g, '-')      // true minus sign
    .replace(/\u00A0|\s/g, '')    // nbsp + ordinary spaces used as 000s separators
    .replace(/'/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  if (!isFinite(n)) throw new Error('unparseable amount: ' + raw);
  return Math.round(n * 100) / 100;
}

const iso = d => {
  const m = String(d).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(m)) return m;                 // Swedbank
  const us = m.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);            // Amex MM/DD/YYYY
  if (us) return `${us[3]}-${us[1]}-${us[2]}`;
  throw new Error('unparseable date: ' + d);
};

/* ---------------------------------------------------------- text repair -- */

const MANGLED = [
  [/G_teborg/g, 'Göteborg'], [/G TEBORG/g, 'GÖTEBORG'],
  [/\$RE/g, 'ÖRE'], [/³/g, 'Ä'], [/#/g, 'ä'], [/_/g, 'ö'],
];
export function clean(s) {
  let t = String(s);
  for (const [re, to] of MANGLED) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------ parsers ---- */

const SWB_ACCOUNTS = { '9232740481': 'swb_priv', '9139972534': 'swb_spar' };

/** The junk first line of a Swedbank export declares its own window:
    "* Transaktioner Period 2026-02-01–2026-02-28 …". This is authoritative and
    answers what transaction dates cannot — February's rows run 02-02 to 02-27,
    but the export covers the whole month. Amex has no equivalent. */
export function declaredPeriod(text) {
  const m = text.match(/Period\s*(\d{4}-\d{2}-\d{2})\s*[–\-—]\s*(\d{4}-\d{2}-\d{2})/);
  return m ? { from: m[1], to: m[2], basis: 'declared' } : null;
}

export function parseSwedbank(text) {
  const rows = parseCSV(text);
  const head = rows.findIndex(r => r[0] === 'Radnummer');
  if (head < 0) throw new Error('Swedbank header row not found');
  const out = [], rejects = [];
  for (const r of rows.slice(head + 1)) {
    if (r.length < 12) continue;
    try {
      const konto = r[2].trim();
      out.push({
        account: SWB_ACCOUNTS[konto] || ('swb_' + konto),
        date: iso(r[5]), tdate: iso(r[6]),
        ref: r[8].trim(), desc: r[9].trim(), merchant: clean(r[9]),
        amount: amount(r[10]), balance: amount(r[11]),
      });
    } catch (e) { rejects.push({ row: r, why: e.message }); }
  }
  return { rows: out, rejects, source: 'swedbank', period: declaredPeriod(text) };
}

/** Amex reports charges as POSITIVE. We normalise to Swedbank's convention:
    money leaving you is always negative. */
export function parseAmex(text) {
  const rows = parseCSV(text);
  const head = rows.findIndex(r => r[0] === 'Datum');
  if (head < 0) throw new Error('Amex header row not found');
  const body = rows.slice(head + 1).filter(r => r.length >= 10);
  const refs = body.map(r => (r[9] || '').replace(/'/g, '').trim());
  const corp = refs.filter(x => x.startsWith('057000')).length / (refs.length || 1);
  const account = corp >= 0.8 ? 'amex_corp' : 'amex_priv';
  const out = [], rejects = [];
  for (const r of body) {
    try {
      out.push({
        account, date: iso(r[0]), tdate: iso(r[0]),
        ref: (r[9] || '').replace(/'/g, '').trim(),
        desc: r[1].trim(), merchant: clean(r[1]),
        amount: -amount(r[2]), balance: null,
      });
    } catch (e) { rejects.push({ row: r, why: e.message }); }
  }
  const dates = out.map(r => r.date).sort();
  return { rows: out, rejects, source: 'amex', account,
           period: dates.length ? { from: dates[0], to: dates.at(-1), basis: 'inferred' } : null };
}

export function parseFile(text) {
  const d = detectDialect(text);
  if (d === 'swedbank') return parseSwedbank(text);
  if (d === 'amex') return parseAmex(text);
  throw new Error('Unrecognised file — expected a Swedbank or Amex CSV export');
}

/* -------------------------------------------------------- fingerprints --- */

async function sha16(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

/** Radnummer shifts between exports, so it cannot be an identity key.
    Balance alone is not enough either: on 2025-10-22 three transfers
    (+2500 / −2500 / +2500) leave the balance identical on two rows.
    Hence base hash + occurrence index within the colliding group. */
export async function fingerprint(rows) {
  const seen = new Map();
  for (const r of rows) {
    const base = await sha16([r.account, r.date, r.tdate, r.ref, r.desc, r.amount, r.balance].join('|'));
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    r.fp = `${base}:${n}`;
  }
  return rows;
}

/* ------------------------------------------------------ integrity check -- */

/** saldo[i] − belopp[i] must equal saldo[i+1] in export order.
    A break means rows are missing and the import should be refused. */
export function checkChain(rows) {
  const breaks = [];
  const byAcct = {};
  rows.forEach(r => { if (r.balance != null) (byAcct[r.account] ||= []).push(r); });
  for (const [acct, list] of Object.entries(byAcct)) {
    for (let i = 0; i < list.length - 1; i++) {
      const expect = Math.round((list[i].balance - list[i].amount) * 100) / 100;
      if (Math.abs(expect - list[i + 1].balance) > 0.005)
        breaks.push({ account: acct, after: list[i].date, expected: expect, found: list[i + 1].balance });
    }
  }
  return breaks;
}

/* ---------------------------------------------------------------- roles -- */

export function assignRole(r, meta) {
  const b = r.desc, ref = r.ref || '';
  if (r.account.startsWith('amex')) {
    if (/REMITTANCE|BETALNING MOTTAGEN/.test(b)) return 'card_payment';
    if (/SERVICE CHARGE|ÅRSAVGIFT|SafeKey/.test(b)) return 'fee';
    return r.amount < 0 ? 'spend' : 'reversal';
  }
  if (/^XPD\d+$/.test(b)) return 'reimbursement';
  if (b === 'LÖN' || b === 'Lön') return 'income';
  if (b === 'Sparränta' || b === 'ELSTÖD') return 'fee';
  if (/Överföring/.test(b)) {
    const a = (meta.accountsByRef || {})[ref];
    if (a === 'swb_priv' || a === 'swb_spar') return 'transfer_internal';
    if (a === 'ext_fond') return 'transfer_savings';
    if (a === 'ext_dad' || a === 'ext_mother_phone') return 'transfer_obligation';
    return 'transfer_savings';
  }
  if (/american express/i.test(b)) return 'card_payment';
  if (/Revolut/.test(b)) return 'wallet_load';
  if (/Swish/.test(b)) {
    if (/Avanza/i.test(b)) return 'transfer_savings';
    if (ref === meta.dadSwish) return 'transfer_obligation';
    return 'p2p';
  }
  return r.amount < 0 ? 'spend' : 'reversal';
}

/* ------------------------------------------------------------ matchers --- */

/** M3 — refund paired to an earlier charge. Amounts differ because of FX:
    Goldcar Jul 2026 was −25,122.43 against +24,185.99, a 3.7% gap, so exact
    matching finds nothing. Same merchant, opposite sign, ≤14 days, ≤6%. */
export function matchReversals(tx) {
  const pool = tx.filter(t => t.role === 'spend' || t.role === 'reversal');
  const day = 864e5;
  for (const credit of pool.filter(t => t.amount > 0 && !t.pair)) {
    const cd = Date.parse(credit.date);
    const hit = pool.find(t =>
      t.amount < 0 && !t.pair &&
      t.merchant.slice(0, 12) === credit.merchant.slice(0, 12) &&
      Math.abs(Date.parse(t.date) - cd) <= 14 * day &&
      Math.abs(Math.abs(t.amount) - credit.amount) / credit.amount <= 0.06);
    if (hit) { credit.pair = hit.fp; hit.pair = credit.fp; credit.role = hit.role = 'reversal'; }
  }
  return tx;
}

/** M2 — Amex invoice payment against the Swedbank outflow that settled it.
    Card identity comes from the Amex side (reference prefix), never from
    Swedbank's letter case, which drifts over time. Observed lag 0–3 days. */
export function matchCardPayments(tx) {
  const day = 864e5;
  const bank = tx.filter(t => t.role === 'card_payment' && t.account.startsWith('swb'));
  for (const a of tx.filter(t => t.role === 'card_payment' && t.account.startsWith('amex') && !t.pair)) {
    const ad = Date.parse(a.date);
    const hit = bank.find(b => !b.pair &&
      Math.abs(Math.abs(b.amount) - Math.abs(a.amount)) < 0.005 &&
      Math.abs(Date.parse(b.tdate) - ad) <= 6 * day);
    if (hit) { a.pair = hit.fp; hit.pair = a.fp; hit.card = a.account; }
  }
  return tx;
}

/** M1 — internal transfer between two tracked accounts. Deterministic.
    Consumed greedily so identical same-day pairs cannot double-match. */
export function matchInternal(tx) {
  const avail = tx.filter(t => t.role === 'transfer_internal' && !t.pair);
  for (const a of avail) {
    if (a.pair) continue;
    const hit = avail.find(b => !b.pair && b !== a &&
      b.account !== a.account && b.date === a.date &&
      Math.abs(b.amount + a.amount) < 0.005);
    if (hit) { a.pair = hit.fp; hit.pair = a.fp; }
  }
  return tx;
}

export function runMatchers(tx) {
  tx.forEach(t => { if (t.pair === undefined) t.pair = null; });
  matchInternal(tx); matchCardPayments(tx); matchReversals(tx);
  return tx;
}

/* ---------------------------------------------------------------- merge -- */

export function merge(existing, incoming) {
  const have = new Set(existing.map(t => t.fp));
  const added = incoming.filter(t => !have.has(t.fp));
  return { added, duplicates: incoming.length - added.length };
}

/* --------------------------------------------------------------- GitHub -- */

/** Chunked on purpose: String.fromCharCode(...bytes) spreads every byte into
    an argument list, which overflows the call stack somewhere above ~120 kB.
    ledger.json passes that the moment a year of transactions is in it. */
const b64encode = s => {
  const bytes = new TextEncoder().encode(s);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  return btoa(bin);
};
const b64decode = s => new TextDecoder().decode(
  Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0)));

export class Repo {
  constructor({ owner, repo, token }) { Object.assign(this, { owner, repo, token }); }

  get base() { return `https://api.github.com/repos/${this.owner}/${this.repo}/contents`; }
  get headers() {
    return { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json',
             'X-GitHub-Api-Version': '2022-11-28' };
  }

  async read(path) {
    const r = await fetch(`${this.base}/${path}?ref=main`, { headers: this.headers, cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(await this.explain(r));
    const j = await r.json();
    return { json: JSON.parse(b64decode(j.content)), sha: j.sha };
  }

  /** GitHub rejects a write whose sha is stale, so a concurrent change
      surfaces as a 409 rather than silently overwriting the newer version. */
  async write(path, obj, sha, message) {
    const r = await fetch(`${this.base}/${path}`, {
      method: 'PUT', headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: b64encode(JSON.stringify(obj, null, 1)),
                             sha: sha || undefined, branch: 'main' }),
    });
    if (r.status === 409) throw new Error('CONFLICT: the file changed since you loaded it. Reload and retry.');
    if (!r.ok) throw new Error(await this.explain(r));
    return (await r.json()).content.sha;
  }

  async explain(r) {
    let d = ''; try { d = (await r.json()).message || ''; } catch {}
    if (r.status === 401) return 'Token rejected (401). It may be expired or mistyped.';
    if (r.status === 403) return 'Forbidden (403). Check the token has Contents: read and write on this repo.';
    if (r.status === 404) return 'Not found (404). Check the owner and repository name, and that the token can see it.';
    return `GitHub error ${r.status}. ${d}`;
  }
}


/* ------------------------------------------------------------- coverage -- */

/** Coverage windows per account, merged and sorted. Declared windows beat
    inferred ones for the same span. */
export function mergeCoverage(existing, additions) {
  const out = [...(existing || [])];
  for (const a of additions) {
    if (!a || !a.account) continue;
    const same = out.find(x => x.account === a.account && x.from === a.from && x.to === a.to);
    if (same) { if (a.basis === 'declared') same.basis = 'declared'; continue; }
    out.push({ ...a });
  }
  return out.sort((x, y) => x.account === y.account ? (x.from < y.from ? -1 : 1) : (x.account < y.account ? -1 : 1));
}

/** Per account: earliest start, latest end, and whether any window was declared. */
export function coverageByAccount(cov, tx) {
  const acc = {};
  for (const c of cov || []) {
    const a = acc[c.account] ||= { from: c.from, to: c.to, declared: false };
    if (c.from < a.from) a.from = c.from;
    if (c.to > a.to) a.to = c.to;
    if (c.basis === 'declared') a.declared = true;
  }
  for (const t of tx) {                      // fall back to transaction extents
    const a = acc[t.account] ||= { from: t.date, to: t.date, declared: false };
    if (t.date < a.from) a.from = t.date;
    if (t.date > a.to) a.to = t.date;
  }
  return acc;
}

/** A month is complete only when EVERY tracked account covers its final day.
    That is the boundary beyond which comparisons are not trustworthy. */
export function completeMonths(cov, tx, trackedAccounts) {
  const acc = coverageByAccount(cov, tx);
  const present = trackedAccounts.filter(a => acc[a]);
  if (!present.length) return [];
  const start = present.map(a => acc[a].from).sort().at(-1).slice(0, 7);
  const end = present.map(a => acc[a].to).sort()[0];
  const months = [];
  let [y, m] = start.split('-').map(Number);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (last > end) break;
    months.push(key);
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

/* ------------------------------------------------------ near-duplicates -- */

/** Fingerprints catch an identical row sent twice. They cannot catch the same
    purchase arriving twice with different details — an Amex charge that settled
    at a different amount or date than when it was pending. Surface, never merge. */
export function nearDuplicates(existing, incoming) {
  const day = 864e5, hits = [];
  for (const n of incoming) {
    const nd = Date.parse(n.date);
    const m = existing.find(e => e.account === n.account && e.fp !== n.fp &&
      e.merchant.slice(0, 14) === n.merchant.slice(0, 14) &&
      Math.abs(Date.parse(e.date) - nd) <= 5 * day &&
      Math.abs(Math.abs(e.amount) - Math.abs(n.amount)) / Math.max(Math.abs(n.amount), 1) <= 0.02);
    if (m) hits.push({ incoming: n, existing: m });
  }
  return hits;
}
