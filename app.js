import * as C from './core.js?v=32';

/* Taxonomy, accounts, targets and thresholds are DATA, not program logic.
   They live in config.json in the private repo and are edited in-app.
   The list below is only a fallback for a repo with no config yet. */
const FALLBACK_CATS = [
  ['Food & Drinks',['Groceries','Restaurant','Alcohol','Coffee & snacks']],
  ['Transport',['Taxi','Scooters & bikes','Public transport','Fuel','Parking','Other transport']],
  ['Shopping',['Clothing','Home & furniture','Other shopping']],
  ['Lifestyle',['Entertainment','Golf','Surf','Ski','Subscriptions','Other lifestyle']],
  ['Health',['Beauty','Sport & fitness','Memberships','Pharmacy','Healthcare']],
  ['Travel',['Hotel','Flight','Car rental','Other travel']],
  ['Housing',['Rent/Avgift','Electricity','Internet & phone','Other housing']],
  ['Fees & Debt',['Mortgage','CSN','Bank & card fees','FX costs']],
  ['Insurance',['Home & contents','A-kassa','Other insurance']],
].flatMap(([group, labels]) => labels.map(label => ({ group, label, fixed: false })));

const CFG_KEY = 'ledger.cfg';
const SEEN_KEY = 'ledger.lastSaved';   // stamp of the newest annotations this device wrote
const SECTIONS = {
  control:      [['overview','Overview'], ['month','Month deep-dive'], ['subs','Subscriptions'], ['targets','Targets']],
  transactions: [['import','Upload transactions'], ['coverage','Data coverage']],
  categorise:   [['expenses','Expense categorisation'], ['corp','Corporate allocation'],
                 ['swish','Swish counterparties'], ['other','Transfers & income']],
};

let cfg = null, repo = null;
let CONF = null, shaC = null, confDirty = false;
let ledger = null, ann = null, shaL = null, shaA = null;
let dirty = false, section = 'control', pane = 'overview';
let filter = 'todo', sort = 'value', query = '', adjust = false;
let pendingImport = null, staleWarning = null, monthCursor = null;

const $ = id => document.getElementById(id);
const el = h => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const kr = n => Math.round(n).toLocaleString('sv-SE') + ' kr';
const kr0 = n => Math.round(n).toLocaleString('sv-SE');
const cat = r => r && r.group ? r.group + ' / ' + r.label : '';
const monthName = m => new Date(m + '-01').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });

/* ------------------------------------------------------------ derived ---- */
const groups = () => {
  const g = new Map();
  for (const c of CONF.categories) { if (!g.has(c.group)) g.set(c.group, []); g.get(c.group).push(c); }
  return g;
};
const TIERS = ['Must have','Essentials','Discretionary'];
const tierOf = (g, l) => CONF.categories.find(c => c.group === g && c.label === l)?.tier || 'Discretionary';
const tierOfTx = t => {
  const r = ann.merchantRules[mkey(t)];
  return r?.group ? tierOf(r.group, r.label) : 'Discretionary';
};

/** Recurrence is detected, not labelled. A merchant seen in most months is
    recurring; if the amount barely moves it is a subscription you cancel once,
    if it swings it is a habit you simply do less of. */
function recurring(months) {
  const cfgR = CONF.meta.recurring || {};
  const minMonths = Math.max(2, Math.ceil(months.length * (cfgR.minMonthsShare ?? 0.6)));
  const cv = cfgR.subscriptionCV ?? 0.15;
  const by = new Map();
  for (const t of spendRows()) {
    const m = t.date.slice(0, 7);
    if (!months.includes(m) || ann.workExpenses[t.fp]) continue;
    const k = mkey(t);
    const e = by.get(k) || { merchant: k, per: {}, total: 0 };
    e.per[m] = (e.per[m] || 0) + Math.abs(t.amount);
    e.total += Math.abs(t.amount);
    by.set(k, e);
  }
  const out = [];
  for (const e of by.values()) {
    const seen = Object.keys(e.per).length;
    if (seen < minMonths) continue;
    const vals = Object.values(e.per);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    const rule = ann.merchantRules[e.merchant] || {};
    const auto = mean && sd / mean <= cv ? 'subscription' : 'habit';
    // direction of travel: recent half against the earlier half
    const half = Math.floor(months.length / 2);
    const seq = months.map(m => e.per[m] || 0);
    const early = seq.slice(0, half).reduce((a, b) => a + b, 0) / (half || 1);
    const late = seq.slice(half).reduce((a, b) => a + b, 0) / (months.length - half || 1);
    const momentum = early ? (late - early) / early * 100 : (late ? 100 : 0);
    out.push({ ...e, seen, mean, cv: mean ? sd / mean : 1,
               kind: (ann.recurring[e.merchant] || {}).kind || auto, auto,
               cancelled: (ann.recurring[e.merchant] || {}).cancelled || null,
               last: e.per[months.at(-1)] || 0, momentum, early, late,
               tier: rule.group ? tierOf(rule.group, rule.label) : 'Discretionary',
               cat: rule.group ? rule.group + ' / ' + rule.label : '—',
               perYear: e.total / months.length * 12 });
  }
  return out.sort((a, b) => b.perYear - a.perYear);
}

const defaultFixed = (g, l) => !!CONF.categories.find(c => c.group === g && c.label === l)?.fixed;
const ruleCount = (g, l) => Object.values(ann.merchantRules).filter(r => r.group === g && r.label === l).length;

const spendRows = () => ledger.transactions.filter(t =>
  ((t.role === 'spend' || t.role === 'fee') && t.account !== 'amex_corp') ||
  (t.role === 'p2p' && !(t.ref || '').startsWith('+46')));
const mkey = t => t.role === 'p2p' ? t.ref : t.merchant;

const merchants = () => {
  const m = new Map();
  for (const t of spendRows()) {
    const k = mkey(t);
    const e = m.get(k) || { merchant: k, n: 0, total: 0, accounts: new Set(), first: t.date, last: t.date, tx: [] };
    e.n++; e.total += t.amount;
    e.accounts.add(t.role === 'p2p' ? 'swish' : t.account);
    if (t.date < e.first) e.first = t.date;
    if (t.date > e.last) e.last = t.date;
    e.tx.push(t); m.set(k, e);
  }
  return [...m.values()].map(e => ({ ...e, accounts: [...e.accounts], total: Math.round(e.total * 100) / 100 }));
};
const workOf = m => m.tx.filter(t => ann.workExpenses[t.fp]);
const netOf  = m => m.tx.reduce((a, t) => a + (ann.workExpenses[t.fp] ? 0 : t.amount), 0);

/** Amex declares no period, so its coverage is inferred from the first row —
    which reads a late-August first transaction as "August not covered".
    A manual window, stated on your own authority, overrides that. */
function effectiveCoverage() {
  const ov = CONF.meta.coverageOverride || {};
  const auto = CONF.meta.coverageAutoMonth || {};
  const out = [...(ledger.coverage || [])];

  /* "Assume the export covers to the end of its last month." Amex declares no
     period, so a final charge on the 28th otherwise reads as three missing
     days and holds the whole month back. */
  const first = {}, last = {};
  for (const t of ledger.transactions) {
    if (!first[t.account] || t.date < first[t.account]) first[t.account] = t.date;
    if (!last[t.account] || t.date > last[t.account]) last[t.account] = t.date;
  }
  for (const [id, on] of Object.entries(auto)) {
    if (!on || !last[id]) continue;
    const [y, m] = last[id].split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    out.push({ account: id, from: first[id], to: end, basis: 'auto' });
  }
  out.push(...Object.entries(ov).map(([account, w]) => ({ account, ...w, basis: 'manual' })));
  return out;
}

/** Month options spanning the ledger, plus a year either side. */
function monthOptions(sel, endOfMonth) {
  const ds = ledger.transactions.map(t => t.date).sort();
  if (!ds.length) return '';
  const start = new Date(ds[0] + 'T00:00:00Z'), stop = new Date(ds.at(-1) + 'T00:00:00Z');
  start.setUTCMonth(start.getUTCMonth() - 2); stop.setUTCMonth(stop.getUTCMonth() + 2);
  let h = '<option value="">—</option>';
  for (let d = new Date(start); d <= stop; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const v = endOfMonth
      ? new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
      : `${y}-${String(m).padStart(2, '0')}-01`;
    const lbl = d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
    h += `<option value="${v}"${v === sel ? ' selected' : ''}>${lbl}</option>`;
  }
  return h;
}

const trackedAccounts = () => (CONF.accounts || []).filter(a => a.tracked).map(a => a.id);
const complete = () => C.completeMonths(effectiveCoverage(), ledger.transactions, trackedAccounts());

/** Rows that count as personal spending in a given set of months.
    Work-flagged rows never count; one-offs only when the switch is on. */
function spendIn(months) {
  const set = new Set(months);
  return spendRows().filter(t =>
    set.has(t.date.slice(0, 7)) &&
    !ann.workExpenses[t.fp] &&
    !(adjust && ann.oneOffs[t.fp]));
}
const groupOf = t => ann.merchantRules[mkey(t)]?.group || 'Unknown';

/** Every krona of personal expenditure, resolved to group / label / tier.
    THE single source for the overview sections, the targets and the month
    drill-down — merchant purchases, obligations counted as expenditure
    (the mortgage, the phone bill) and the net of Swish with people. */
function expenditureItems(months) {
  const skip = excludedRefs();
  const set = new Set(months);
  const out = [];
  for (const t of ledger.transactions) {
    const m = t.date.slice(0, 7);
    if (!set.has(m) || skip.has(t.ref)) continue;
    if (adjust && ann.oneOffs[t.fp]) continue;
    if (isSpendRow(t)) {
      if (ann.workExpenses[t.fp]) continue;
      const r = ann.merchantRules[mkey(t)] || {};
      out.push({ m, fp: t.fp, group: r.group || 'Unknown', label: r.label || 'Unlabelled',
                 tier: r.group ? tierOf(r.group, r.label) : 'Discretionary', v: Math.abs(t.amount) });
    } else if (isPersonSwish(t)) {
      out.push({ m, fp: t.fp, group: 'Swish (net)', label: ann.swishNames[t.ref] || t.ref,
                 tier: 'Discretionary', v: -t.amount });
    } else if (isOther(t)) {
      const f = flowOf(t);
      if (f.counts !== 'expenditure') continue;
      const g = f.group || 'Uncategorised transfers', l = f.label || (t.ref || t.desc);
      out.push({ m, fp: t.fp, group: g, label: l,
                 tier: f.group ? tierOf(g, l) : 'Discretionary', v: -t.amount });
    }
  }
  return out;
}
const isSpendRow = t =>
  ((t.role === 'spend' || t.role === 'fee') && t.account !== 'amex_corp') ||
  (t.role === 'p2p' && !(t.ref || '').startsWith('+46'));
const isPersonSwish = t => roleOf(t) === 'p2p' && (t.ref || '').startsWith('+46');

/** Money in and money out, per month.

    Income is salary only — reimbursements repay work expenses you fronted, so
    counting them would double up against the corporate card, which is already
    excluded on the spending side.

    Expenditure is money that leaves and does not come back: personal spending,
    and the net of Swish with people. Obligations such as the mortgage are
    categorised here through their counterparty rule, same as any transfer.
    Excluded by design — transfers between your own accounts, Avanza (that is
    saving, not spending), Amex invoice payments (the charges themselves are
    already counted), and any account listed in meta.excludeFromCashflow. */
/* Rows that are neither merchant spending nor person-to-person Swish get
   classified here: salary, reimbursements, obligations, savings transfers,
   wallet loads and stray credits. Each carries a default, a rule by
   counterparty, and a per-transaction override. */
const OTHER_ROLES = ['income','reimbursement','transfer_obligation','transfer_savings','wallet_load','reversal'];

/** A row can be re-pointed at a different role. Setting "Personal Swish" on the
    two 22 July transfers moves them out of Obligations entirely and into the
    Swish counterparty view, where they net against each other. */
function roleOf(t) {
  const c = (ann.txOverrides[t.fp] || {}).counts || (ann.transferRules[otherKeyRaw(t)] || {}).counts;
  return c === 'p2p' ? 'p2p' : t.role;
}
const otherKeyRaw = t => t.role === 'income' ? 'Salary'
  : t.role === 'reimbursement' ? 'McKinsey reimbursements' : (t.ref || t.desc);
const isOther = t => OTHER_ROLES.includes(t.role) && roleOf(t) !== 'p2p' && !isSpendRow(t)
  && !(t.role === 'reversal' && t.account.startsWith('amex'));

const otherKey = otherKeyRaw;
const DEFAULT_COUNTS = { income: 'income', reimbursement: 'ignore', transfer_obligation: 'expenditure',
  transfer_savings: 'savings', wallet_load: 'ignore', reversal: 'ignore' };

/** How a row behaves in the cash-flow view. Per-transaction beats the
    counterparty rule, which beats the role default. */
function flowOf(t) {
  const o = ann.txOverrides[t.fp] || {};
  const r = ann.transferRules[otherKey(t)] || {};
  return {
    counts: o.counts || r.counts || DEFAULT_COUNTS[t.role] || 'ignore',
    group: ('group' in o) ? o.group : (r.group ?? null),
    label: ('label' in o) ? o.label : (r.label ?? null),
  };
}

function excludedRefs() {
  const ids = CONF.meta.excludeFromCashflow || [];
  return new Set((CONF.accounts || []).filter(a => ids.includes(a.id)).map(a => a.match?.ref).filter(Boolean));
}

function cashByMonth(months) {
  const skip = excludedRefs();
  const out = {};
  months.forEach(m => out[m] = { income: 0, spend: 0 });
  for (const t of ledger.transactions) {
    const m = t.date.slice(0, 7);
    if (!out[m]) continue;
    if (skip.has(t.ref)) continue;
    if (adjust && ann.oneOffs[t.fp]) continue;
    if (isSpendRow(t)) { if (!ann.workExpenses[t.fp]) out[m].spend += Math.abs(t.amount); }
    else if (isPersonSwish(t)) out[m].spend -= t.amount;      // net: sent adds, received subtracts
    else if (isOther(t)) {
      const f = flowOf(t);
      if (f.counts === 'income') out[m].income += Math.abs(t.amount);
      else if (f.counts === 'expenditure') out[m].spend -= t.amount;   // signed: a refund reduces it
    }
  }
  for (const m of months) out[m].net = out[m].income - out[m].spend;
  return out;
}
const r100 = n => Math.round(n / 100) * 100;
const krR = n => r100(n).toLocaleString('sv-SE') + ' kr';
const krN = n => r100(n).toLocaleString('sv-SE');
const delta = (latest, avg) => {
  const d = r100(latest - avg);
  if (!d) return 'in line with the average';
  return `${Math.abs(d).toLocaleString('sv-SE')} kr ${d > 0 ? 'above' : 'below'} the average`;
};

/* ------------------------------------------------------------- counts ---- */
const unconfirmed = () => merchants().filter(m => !ann.merchantRules[m.merchant]?.confirmed).length;
const corpRows = () => ledger.transactions
  .filter(t => t.account === 'amex_corp' && (t.role === 'spend' || t.role === 'fee'))
  .sort((a, b) => a.date < b.date ? 1 : -1);
const corpUnreviewed = () => {
  const through = ann.corpReviewedThrough || '0000-00-00';
  return corpRows().filter(t => t.date > through).length;
};
const swishRefs = () => [...new Set(ledger.transactions.filter(isPersonSwish).map(t => t.ref))];
const swishUnnamed = () => swishRefs().filter(r => !ann.swishNames[r]).length;
const otherGroups = () => {
  const g = new Map();
  for (const t of ledger.transactions.filter(isOther)) {
    const k = otherKey(t);
    const e = g.get(k) || { key: k, n: 0, total: 0, tx: [] };
    e.n++; e.total += t.amount; e.tx.push(t); g.set(k, e);
  }
  return [...g.values()].sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
};
const otherUnruled = () => otherGroups().filter(g => !ann.transferRules[g.key]?.confirmed).length;

/* -------------------------------------------------------------- sync ----- */
function setSync(state, text) { const s = $('sync'); s.className = 'sync ' + state; s.textContent = text; }
function markDirty() { dirty = true; if (repo) setSync('busy', 'unsaved'); }
function banner(msg) { $('banner').innerHTML = msg ? `<div class="fatal">${msg}</div>` : ''; }

async function connect() {
  repo = new C.Repo(cfg);
  setSync('busy', 'loading');
  const L = await repo.read('ledger.json');
  const A = await repo.read('annotations.json');
  const K = await repo.read('config.json');
  CONF = K ? K.json : { version: 1, categories: FALLBACK_CATS, meta: {}, accounts: [] };
  shaC = K ? K.sha : null;
  if (!CONF.categories?.length) CONF.categories = FALLBACK_CATS;
  CONF.targets ||= { monthly: {}, annual: {} };
  CONF.targets.monthly ||= {}; CONF.targets.annual ||= {};
  if (!L) throw new Error(`ledger.json not found in ${cfg.owner}/${cfg.repo}. Either the file is missing, or the token cannot see that repository — GitHub returns the same 404 for both. Check the repo name, and that the token lists it under Repository access.`);
  ledger = L.json; shaL = L.sha;
  ledger.coverage ||= [];
  CONF.meta = { ...(ledger.meta || {}), ...(CONF.meta || {}) };
  if (!CONF.accounts?.length) CONF.accounts = ledger.accounts || [];
  ann = A ? A.json : { version: 1 };
  shaA = A ? A.sha : null;

  /* Guard against an older annotations.json being uploaded over a newer one.
     Every save records its stamp on this device; if the file that comes back
     is older than that, something overwrote your work and we say so loudly
     rather than letting you carry on editing a stale copy. */
  const seen = localStorage.getItem(SEEN_KEY);
  staleWarning = (seen && ann.updated && ann.updated < seen)
    ? `<b>The labelling in GitHub is older than the last version this device saved.</b>
       It was last written ${ann.updated.slice(0, 16).replace('T', ' ')}, but this device saved a newer one at
       ${seen.slice(0, 16).replace('T', ' ')}. Something has overwritten your work — most likely an
       <code>annotations.json</code> uploaded by hand. Before editing anything, open
       <b>${cfg.repo} → annotations.json → History</b> on GitHub and restore the newer version.`
    : null;
  for (const k of ['merchantRules','swishNames','workExpenses','corporatePrivate','oneOffs','transferRules','txOverrides','recurring']) ann[k] ||= {};
  dirty = false; confDirty = false; setSync('on', 'synced');
}

async function save() {
  if (!repo) return toast('Not connected');
  setSync('busy', 'saving');
  try {
    ann.updated = new Date().toISOString();
    shaA = await repo.write('annotations.json', ann, shaA, 'Update annotations');
    localStorage.setItem(SEEN_KEY, ann.updated);
    if (confDirty) {
      CONF.updated = new Date().toISOString();
      shaC = await repo.write('config.json', CONF, shaC, 'Update configuration');
      confDirty = false;
    }
    dirty = false; setSync('on', 'synced'); toast('Saved to GitHub');
  } catch (e) { setSync('err', 'error'); banner(e.message); }
}

/* ============================================================ ROUTING ==== */
function go(sec, p) {
  section = sec;
  const panes = SECTIONS[sec];
  pane = p && panes.some(x => x[0] === p) ? p : panes[0][0];
  document.querySelectorAll('#nav button').forEach(b => b.setAttribute('aria-pressed', b.dataset.s === sec));

  const sn = $('subnavIn'); sn.innerHTML = '';
  for (const [id, label] of panes) {
    const badge = id === 'expenses' ? unconfirmed() : id === 'corp' ? corpUnreviewed()
                : id === 'swish' ? swishUnnamed() : id === 'other' ? otherUnruled() : 0;
    const b = el(`<button data-p="${id}" aria-pressed="${id === pane}">${label}
      <em ${badge ? '' : 'hidden'}>${badge}</em></button>`);
    b.onclick = () => go(sec, id);
    sn.appendChild(b);
  }
  $('subnav').hidden = panes.length < 2;

  const show = {
    overview: 'viewControl', month: 'viewMonth', subs: 'viewSubs', targets: 'viewTargets', import: 'viewImport', coverage: 'viewCoverage',
    expenses: 'viewExpenses', corp: 'viewCorp', swish: 'viewSwish', other: 'viewOther',
  };
  for (const v of Object.values(show)) $(v).hidden = true;
  $(show[pane]).hidden = false;
  $('toolsPersonal').hidden = pane !== 'expenses';
  $('gaugeWrap').hidden = pane !== 'expenses';

  const n = unconfirmed() + corpUnreviewed() + swishUnnamed() + otherUnruled();
  $('navBadge').textContent = n; $('navBadge').hidden = !n;

  ({ overview: drawControl, month: drawMonth, subs: drawSubs, targets: drawTargets, import: drawImport, coverage: drawCoverage,
     expenses: render, corp: renderCorp, swish: renderSwish, other: renderOther })[pane]();
}
document.querySelectorAll('#nav button').forEach(b => b.onclick = () => go(b.dataset.s));

/* ==================================================== EXPENSE CONTROL ==== */
function drawControl() {
  const host = $('viewControl');
  const all = complete();
  if (!all.length) { host.innerHTML = '<div class="empty"><h3>No complete months yet</h3><p>Import a full month for every account and this fills in.</p></div>'; return; }
  const months = all.slice(-12);                    // rolling 12, or everything we have
  const cash = cashByMonth(months);
  const last = months.at(-1);
  const mean = k => months.reduce((a, m) => a + cash[m][k], 0) / months.length;
  const avgIn = mean('income'), avgOut = mean('spend'), avgNet = avgIn - avgOut;

  const items = expenditureItems(months);
  const byGroup = {};
  for (const it of items) (byGroup[it.group] ||= {})[it.m] = (byGroup[it.group][it.m] || 0) + it.v;
  const T = CONF.targets;
  const targetTotal = Object.values(T.monthly).reduce((a, b) => a + b, 0)
    + Object.values(T.annual).reduce((a, b) => a + b, 0) / 12;
  const oneOffCount = Object.keys(ann.oneOffs).length;
  const scale = Math.max(...months.flatMap(m => [cash[m].income, cash[m].spend]), 1);

  host.innerHTML = `
    <div class="kpi">
      <div class="stat"><b>Average income</b><span>${krR(avgIn)}</span>
        <small>${monthName(last)}: ${krR(cash[last].income)} — ${delta(cash[last].income, avgIn)}</small></div>
      <div class="stat"><b>Average expenditure</b><span>${krR(avgOut)}</span>
        <small>${monthName(last)}: ${krR(cash[last].spend)} — ${delta(cash[last].spend, avgOut)}</small></div>
      <div class="stat big"><b>Average net savings</b><span>${krR(avgNet)}</span>
        <small>${monthName(last)}: ${krR(cash[last].net)} — ${delta(cash[last].net, avgNet)}</small></div>
    </div>

    <div class="verdict">Averages are a rolling <b>${months.length} month${months.length > 1 ? 's' : ''}</b>${
      months.length < 12 ? ' — everything complete so far, building towards 12' : ''}, ${monthName(months[0])} to ${monthName(last)}.
      Showing <b>${adjust ? 'figures excluding one-offs' : 'raw figures'}</b>.
      ${oneOffCount ? `${oneOffCount} transaction${oneOffCount > 1 ? 's are' : ' is'} marked one-off.` : 'Nothing is marked one-off yet.'}</div>
    <div style="margin-top:12px"><label class="toggle"><input type="checkbox" id="adj" ${adjust ? 'checked' : ''}> Exclude one-offs</label></div>

    <h3 class="sh">Income, expenditure and net by month</h3>
    <div class="legend"><span><i class="sw-in"></i>Income</span><span><i class="sw-out"></i>Expenditure</span>
      <span><i class="sw-pill"></i>Net savings</span></div>
    <div class="flow">${months.map(m => {
      const c = cash[m], neg = c.net < 0;
      return `<div class="fcol">
        <div class="pill ${neg ? 'neg' : ''}">${krN(c.net)}</div>
        <div class="fpair">
          <div class="fbw"><span class="fnum">${krN(c.income)}</span>
            <div class="fb in" style="height:${c.income / scale * 100}%"></div></div>
          <div class="fbw tapme" data-m="${m}" role="button" tabindex="0"
               aria-label="Breakdown for ${monthName(m)}"><span class="fnum">${krN(c.spend)}</span>
            <div class="fb out" style="height:${c.spend / scale * 100}%"></div></div>
        </div>
        <span class="tlab">${monthName(m).slice(0, 3)}</span></div>`;
    }).join('')}</div>
    <p class="note">Everything rounded to the nearest 100 kr. Income counts salary only.
      Expenditure counts personal spending and net Swish with people —
      it excludes transfers between your own accounts, Avanza and Amex invoice payments.</p>

    <h3 class="sh">Category movement</h3>
    ${(() => {
      const list = Object.entries(byGroup)
        .map(([c, by]) => ({ c, by, avg: months.reduce((a, m) => a + (by[m] || 0), 0) / months.length }))
        .sort((a, b) => b.avg - a.avg);
      return `<table class="heat"><thead><tr><th>Category</th>
        ${months.map(m => `<th>${monthName(m).slice(0, 3)}</th>`).join('')}<th>Avg</th></tr></thead><tbody>
        ${list.map(r => `<tr><td class="hc">${r.c}</td>
          ${months.map(m => {
            const v = r.by[m] || 0, d = r.avg ? (v - r.avg) / r.avg : 0;
            const lvl = Math.min(3, Math.floor(Math.abs(d) / 0.35));
            return `<td class="${d > 0 ? 'hi' : 'lo'}${lvl}">${krN(v)}</td>`;
          }).join('')}<td class="hav">${krN(r.avg)}</td></tr>`).join('')}
      </tbody></table>
      <p class="note">Shaded against each category's own average — darker red is further above, darker blue further below.</p>`;
    })()}

    <h3 class="sh">Where the money goes</h3>
    <div class="legend">${TIERS.map((t, i) => `<span><i class="tk t${i}"></i>${t}</span>`).join('')}</div>
    ${(() => {
      const per = months.map(m => {
        const seg = {}; TIERS.forEach(t => seg[t] = 0);
        const lab = {};
        for (const it of items.filter(x => x.m === m)) {
          seg[it.tier] += it.v;
          lab[it.label] = lab[it.label] || { v: 0, tier: it.tier };
          lab[it.label].v += it.v;
        }
        const top = Object.entries(lab).sort((a, b) => b[1].v - a[1].v).slice(0, 3);
        return { m, seg, top, tot: TIERS.reduce((a, t) => a + seg[t], 0) };
      });
      const mx = Math.max(...per.map(p => p.tot), 1);
      const avg = per.reduce((a, p) => a + p.tot, 0) / per.length;
      return `<div class="tiers">${per.map(p => `<div class="trow">
        <span class="tm">${monthName(p.m).slice(0, 3)}</span>
        <div class="ttrack"><u class="tavg" style="left:${avg / mx * 100}%"></u>
          <div class="tstack" style="width:${p.tot / mx * 100}%">
            ${TIERS.map((t, i) => `<i class="t${i}" style="width:${p.seg[t] / (p.tot || 1) * 100}%"
              title="${t} ${krN(p.seg[t])} kr"></i>`).join('')}</div></div>
        ${TIERS.map(t => `<span class="tn">${krN(p.seg[t])}</span>`).join('')}
        <div class="tchips">${p.top.map(([label, o]) =>
          `<span class="chip3 t${TIERS.indexOf(o.tier)}">${label}</span>`).join('')}</div>
      </div>`).join('')}</div>
      <div class="thead"><span></span><span></span>${TIERS.map(t => `<span class="tn">${t}</span>`).join('')}</div>
      <p class="note">Bars are absolute, so length is total spend that month; the vertical line marks the
        ${months.length}-month average of ${krN(avg)} kr. Chips are the three largest labels of the month,
        coloured by tier. Discretionary averages <b>${krN(per.reduce((a, p) => a + p.seg['Discretionary'], 0) / per.length)} kr</b> a month.</p>`;
    })()}

`;

  $('adj').onchange = e => { adjust = e.target.checked; drawControl(); };
  host.querySelectorAll('.fbw.tapme').forEach(b => {
    const open = () => openMonth(b.dataset.m, months);
    b.onclick = open;
    b.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
  });
}

/* ------------------------------------------------- month drill-down ------ */
/** Obligations and net Swish are shown as categories of their own. They carry
    no merchant rule, but without them the rows would not add up to the bar
    that was tapped — and both are large movers. */
function breakdown(months) {
  const cats = {};                                   // cat -> { byMonth, subs: sub -> byMonth }
  const put = (cat, sub, m, v) => {
    const c = cats[cat] ||= { byMonth: {}, subs: {} };
    c.byMonth[m] = (c.byMonth[m] || 0) + v;
    (c.subs[sub] ||= {})[m] = (c.subs[sub][m] || 0) + v;
  };
  for (const it of expenditureItems(months)) put(it.group, it.label, it.m, it.v);
  return cats;
}





/* ---------------------------------------------------------- treemap ----- */
/** Squarified treemap (Bruls, Huizing & van Wijk). Packs items into rows
    chosen to keep tiles as close to square as possible, which is what makes
    areas comparable by eye. Laid out in an abstract 1000x560 box and emitted
    as percentages so it scales to any container. */
function squarify(items, x, y, w, h, out = []) {
  if (!items.length || w <= 0 || h <= 0) return out;
  const total = items.reduce((a, i) => a + i.v, 0);
  if (total <= 0) return out;
  const alongHeight = w >= h;
  const side = alongHeight ? h : w;
  const row = [];
  let rowSum = 0, best = Infinity, n = 0;
  for (; n < items.length; n++) {
    const s = rowSum + items[n].v;
    const len = (s / total) * (alongHeight ? w : h);
    const worst = Math.max(...[...row, items[n]].map(it => {
      const thick = (it.v / s) * side;
      return thick && len ? Math.max(len / thick, thick / len) : Infinity;
    }));
    if (row.length && worst > best) break;
    row.push(items[n]); rowSum = s; best = worst;
  }
  const len = (rowSum / total) * (alongHeight ? w : h);
  let off = 0;
  for (const it of row) {
    const thick = (it.v / rowSum) * side;
    out.push(alongHeight ? { ...it, x, y: y + off, w: len, h: thick }
                         : { ...it, x: x + off, y, w: thick, h: len });
    off += thick;
  }
  return alongHeight ? squarify(items.slice(row.length), x + len, y, w - len, h, out)
                     : squarify(items.slice(row.length), x, y + len, w, h - len, out);
}

/* Muted, harmonised palette. Colour identifies the category, and the order is
   fixed by the taxonomy rather than by size, so a category keeps its colour
   from one month to the next. */
const PALETTE = ['#2B4C6F','#3F6F70','#7A6A5D','#4E7A5E','#6B5A72','#5A6E82',
                 '#8A6A5C','#6E7350','#8E7B93','#4A6A85','#94806A','#66707A'];
function catColour(group) {
  const order = [...new Set(CONF.categories.map(c => c.group))];
  const extra = ['Swish (net)', 'Unknown', 'Uncategorised transfers'];
  const all = [...order, ...extra.filter(e => !order.includes(e))];
  const i = all.indexOf(group);
  return PALETTE[(i < 0 ? all.length : i) % PALETTE.length];
}
/** Lighten a hex colour towards white by t (0..1). Used to separate the labels
    inside one category without introducing a second colour scale. */
function lighten(hex, t) {
  const n = parseInt(hex.slice(1), 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const m = v => Math.round(v + (255 - v) * t);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}


/** Opened from an expenditure bar on the overview. Reads from breakdown(),
    which sits on expenditureItems(), so it can never disagree with the
    deep-dive or the sections underneath. */
function openMonth(m, months) {
  document.getElementById('monthModal')?.remove();
  const cats = breakdown(months);
  const rows = Object.entries(cats).map(([cat, c]) => {
    const now = c.byMonth[m] || 0;
    const avg = months.reduce((a, x) => a + (c.byMonth[x] || 0), 0) / months.length;
    const subs = Object.entries(c.subs)
      .map(([label, by]) => ({ label, now: by[m] || 0,
                               avg: months.reduce((a, x) => a + (by[x] || 0), 0) / months.length }))
      .filter(x => x.now || x.avg).sort((a, b) => b.now - a.now);
    return { cat, now, avg, delta: now - avg, subs };
  }).filter(r => r.now || r.avg).sort((a, b) => b.now - a.now);

  const total = rows.reduce((a, r) => a + r.now, 0);
  const totAvg = rows.reduce((a, r) => a + r.avg, 0);
  const gap = total - totAvg;

  const maxPos = Math.max(...rows.flatMap(r => [r.now, r.avg, 0]));
  const maxNeg = Math.abs(Math.min(...rows.flatMap(r => [r.now, r.avg, 0])));
  const span = maxPos + maxNeg || 1;
  const zero = maxNeg / span * 100;
  const seg = v => v >= 0 ? { left: zero, width: v / span * 100 }
                          : { left: zero - Math.abs(v) / span * 100, width: Math.abs(v) / span * 100 };
  const tick = v => zero + v / span * 100;
  const headScale = Math.max(total, totAvg, 1);
  const bar = (v, cls) => `<div class="hbar"><i class="${cls}" style="width:${v / headScale * 100}%"></i></div>`;

  const modal = el(`<div class="modal" id="monthModal"><div class="sheet wide drill">
    <div class="dhead">
      <div><h2>${new Date(m + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2></div>
      <button class="xclose" aria-label="Close">&times;</button>
    </div>

    <div class="hcompare">
      <div class="hrow"><span class="hlab">This month</span>${bar(total, 'in')}<span class="hval">${krN(total)} kr</span></div>
      <div class="hrow"><span class="hlab">${months.length}-month average</span>${bar(totAvg, 'out')}<span class="hval muted">${krN(totAvg)} kr</span></div>
      <div class="hdelta ${gap > 0 ? 'up' : 'dn'}">${gap > 0 ? '+' : '−'}${krN(Math.abs(gap))} kr ${gap > 0 ? 'above' : 'below'} average</div>
    </div>

    <div class="dlist">
      <div class="dl-h"><span>Category</span><span class="hcol">This month against average</span>
        <span>This month</span><span>Average</span><span>Difference</span></div>
      ${rows.map((r, i) => {
        const b = seg(r.now);
        return `<div class="dl-r" data-i="${i}" role="button" tabindex="0">
          <b>${r.cat}<span class="chev">›</span></b>
          <div class="cbar"><u class="zero" style="left:${zero}%"></u>
            <i class="${r.now < 0 ? 'neg' : ''}" style="left:${b.left}%;width:${b.width}%"></i>
            <u class="avg" style="left:${tick(r.avg)}%"></u></div>
          <span class="v">${krN(r.now)}</span><span class="v muted">${krN(r.avg)}</span>
          <span class="v ${r.delta > 0 ? 'over' : 'under'}">${r.delta > 0 ? '+' : '−'}${krN(Math.abs(r.delta))}</span>
        </div>
        <div class="dl-sub" data-sub="${i}" hidden>${r.subs.map(x => `<div class="dl-s">
          <span>${x.label}</span>
          <div class="cbar sub"><u class="zero" style="left:${zero}%"></u>
            <i class="${x.now < 0 ? 'neg' : ''}" style="left:${seg(x.now).left}%;width:${seg(x.now).width}%"></i>
            <u class="avg" style="left:${tick(x.avg)}%"></u></div>
          <span class="v">${krN(x.now)}</span><span class="v muted">${krN(x.avg)}</span>
          <span class="v ${x.now - x.avg > 0 ? 'over' : 'under'}">${x.now - x.avg > 0 ? '+' : '−'}${krN(Math.abs(x.now - x.avg))}</span>
        </div>`).join('') || '<div class="dl-s"><span>No detail</span></div>'}</div>`;
      }).join('')}
    </div>
    <div class="sheet-act"><button class="btn" id="mmDeep">Open the full month</button>
      <button class="btn pri" id="mmClose">Done</button></div>
    <p class="note">The grey tick on each bar marks the ${months.length}-month average, which includes this month.
      Tap any category for its labels.</p>
  </div></div>`);

  document.body.appendChild(modal);
  const close = () => modal.remove();
  modal.querySelector('.xclose').onclick = close;
  modal.querySelector('#mmClose').onclick = close;
  modal.querySelector('#mmDeep').onclick = () => { close(); monthCursor = complete().indexOf(m); go('control', 'month'); };
  modal.onclick = e => { if (e.target === modal) close(); };
  modal.querySelectorAll('.dl-r').forEach(r => {
    const toggle = () => {
      const sub = modal.querySelector(`[data-sub="${r.dataset.i}"]`);
      sub.hidden = !sub.hidden; r.classList.toggle('open', !sub.hidden);
    };
    r.onclick = toggle;
    r.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  });
}

/* ==================================================== MONTH DEEP-DIVE ==== */
function drawMonth() {
  const all = complete();
  const host = $('viewMonth');
  if (!all.length) { host.innerHTML = '<div class="empty"><h3>No complete months yet</h3></div>'; return; }
  if (monthCursor == null || monthCursor < 0 || monthCursor >= all.length) monthCursor = all.length - 1;
  const m = all[monthCursor];
  const window12 = all.slice(-12);
  const items = expenditureItems(window12);
  const here = items.filter(i => i.m === m);

  const cats = {};
  for (const it of here) {
    const c = cats[it.group] ||= { group: it.group, total: 0, labels: {}, tier: it.tier };
    c.total += it.v;
    const l = c.labels[it.label] ||= { label: it.label, v: 0, tier: it.tier, fps: [] };
    l.v += it.v; l.fps.push(it.fp);
  }
  const cols = Object.values(cats).sort((a, b) => b.total - a.total);
  const mx = Math.max(...cols.map(c => c.total), 1);
  const total = cols.reduce((a, c) => a + c.total, 0);

  const labAvg = {};
  for (const it of items) (labAvg[it.label] ||= {})[it.m] = (labAvg[it.label][it.m] || 0) + it.v;
  const avgLabel = l => window12.reduce((a, mm) => a + ((labAvg[l] || {})[mm] || 0), 0) / window12.length;

  const avgOf = (fn) => window12.reduce((a, mm) =>
    a + items.filter(i => i.m === mm && fn(i)).reduce((x, i) => x + i.v, 0), 0) / window12.length;
  const totalAvg = avgOf(() => true);

  host.innerHTML = `
    <div class="mnav">
      <button class="narw" id="mPrev" ${monthCursor === 0 ? 'disabled' : ''} aria-label="Previous month">‹</button>
      <div class="mnow"><h2>${new Date(m + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</h2></div>
      <button class="narw" id="mNext" ${monthCursor === all.length - 1 ? 'disabled' : ''} aria-label="Next month">›</button>
    </div>

    <div class="insight">${insightFor(m, items, window12)}</div>

    <div class="tmap">${(() => {
      const boxes = squarify(cols.map(c => ({ ...c, v: c.total })), 0, 0, 1000, 560);
      return boxes.map(b => {
        const labs = Object.values(b.labels).sort((a, l) => l.v - a.v).map(l => ({ ...l, v: l.v }));
        const base = catColour(b.group);
        const head = Math.min(20, b.h * 0.16);
        const inner = squarify(labs, b.x + 1, b.y + head, Math.max(b.w - 2, 1), Math.max(b.h - head - 1, 1));
        return `<div class="tgrp" style="left:${b.x / 10}%;top:${b.y / 5.6}%;width:${b.w / 10}%;height:${b.h / 5.6}%">
            <span class="tgh">${b.group} <em>${krN(b.total)}</em></span></div>` +
          inner.map((t, k) => {
            const shade = lighten(base, Math.min(0.42, k * 0.11));
            const light = k * 0.11 > 0.24;
            const showName = t.w > 62 && t.h > 24;
            const showVal = t.w > 62 && t.h > 44;
            const one = t.fps.every(fp => ann.oneOffs[fp]) ? ' one' : '';
            return `<button class="tile${one}" style="left:${t.x / 10}%;top:${t.y / 5.6}%;width:${t.w / 10}%;height:${t.h / 5.6}%;background:${shade};color:${light ? '#132A3E' : '#fff'}"
              data-g="${encodeURIComponent(b.group)}" data-l="${encodeURIComponent(t.label)}"
              title="${t.label} — ${krN(t.v)} kr">
              ${showName ? `<b>${t.label}</b>` : ''}${showVal ? `<i>${krN(t.v)}</i>` : ''}</button>`;
          }).join('');
      }).join('');
    })()}</div>
    <div class="catkey">${cols.map(c => `<span class="ck">
      <i style="background:${catColour(c.group)}"></i>${c.group} <em>${krN(c.total)}</em></span>`).join('')}</div>
    <p class="note">Every label in the month, sized by amount and grouped into its category.
      Shades within a block separate the labels. Tap any tile for its transactions;
      a tile marked with a dot is flagged as a one-off.</p>`;

  $('mPrev').onclick = () => { monthCursor--; drawMonth(); };
  $('mNext').onclick = () => { monthCursor++; drawMonth(); };
  host.querySelectorAll('.tile').forEach(b => b.onclick = () =>
    openSeg(m, decodeURIComponent(b.dataset.g), decodeURIComponent(b.dataset.l)));
}

/** Rules-based synthesis: real deviations, and what holding them to average
    would have saved. Arithmetic with sentences around it, not interpretation. */
function insightFor(m, items, window12) {
  const byCat = {}, byLab = {};
  for (const it of items) {
    (byCat[it.group] ||= {})[it.m] = (byCat[it.group][it.m] || 0) + it.v;
    (byLab[it.label] ||= {})[it.m] = (byLab[it.label][it.m] || 0) + it.v;
  }
  const dev = o => Object.entries(o).map(([k, by]) => {
    const now = by[m] || 0;
    const avg = window12.reduce((a, mm) => a + (by[mm] || 0), 0) / window12.length;
    return { k, now, avg, d: now - avg };
  }).sort((a, b) => b.d - a.d);
  const cats = dev(byCat), labs = dev(byLab);
  const tot = items.filter(i => i.m === m).reduce((a, i) => a + i.v, 0);
  const totAvg = window12.reduce((a, mm) => a + items.filter(i => i.m === mm).reduce((x, i) => x + i.v, 0), 0) / window12.length;
  const disc = items.filter(i => i.m === m && i.tier === 'Discretionary').reduce((a, i) => a + i.v, 0);
  const discAvg = window12.reduce((a, mm) =>
    a + items.filter(i => i.m === mm && i.tier === 'Discretionary').reduce((x, i) => x + i.v, 0), 0) / window12.length;
  const up = labs.filter(l => l.d > 500).slice(0, 2);
  const down = labs.filter(l => l.d < -500).slice(-1);
  const saving = up.reduce((a, l) => a + l.d, 0);
  const s = [];
  s.push(`Spending came to <b>${krN(tot)} kr</b>, ${tot > totAvg ? 'above' : 'below'} the ${window12.length}-month
    average by ${krN(Math.abs(tot - totAvg))} kr, with discretionary at ${krN(disc)} kr against a usual ${krN(discAvg)} kr.`);
  if (cats[0] && cats[0].d > 300)
    s.push(`<b>${cats[0].k}</b> was the biggest mover at ${krN(cats[0].now)} kr against ${krN(cats[0].avg)} kr.`);
  if (up.length)
    s.push(`Within it the pressure came from ${up.map(l => `<b>${l.k}</b> at ${krN(l.now)} kr against a usual ${krN(l.avg)} kr`).join(' and ')}.`);
  if (down.length)
    s.push(`<b>${down[0].k}</b> pulled the other way, ${krN(Math.abs(down[0].d))} kr below average.`);
  if (saving > 500)
    s.push(`Holding ${up.length > 1 ? 'those' : 'that'} to ${up.length > 1 ? 'their usual levels' : 'its usual level'}
      would have saved about <b>${krN(saving)} kr</b>.`);
  return s.slice(0, 4).join(' ');
}

/** Transactions behind one block — and the three controls you would otherwise
    have to go to Categorise to reach. */
function openSeg(m, group, label) {
  $('segModal')?.remove();
  const skip = excludedRefs();
  const rows = ledger.transactions.filter(t => {
    if (t.date.slice(0, 7) !== m || skip.has(t.ref)) return false;
    if (isSpendRow(t)) {
      const r = ann.merchantRules[mkey(t)] || {};
      return (r.group || 'Unknown') === group && (r.label || 'Unlabelled') === label;
    }
    if (isPersonSwish(t)) return group === 'Swish (net)' && (ann.swishNames[t.ref] || t.ref) === label;
    if (isOther(t)) { const f = flowOf(t); return f.counts === 'expenditure' && f.group === group && f.label === label; }
    return false;
  }).sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
  const sum = rows.filter(t => !ann.workExpenses[t.fp]).reduce((a, t) => a + Math.abs(t.amount), 0);

  const mod = el(`<div class="modal" id="segModal"><div class="sheet">
    <div class="dhead"><div><h2>${label}</h2>
      <p class="dsum">${group} · ${rows.length} transaction${rows.length > 1 ? 's' : ''} · <b>${krN(sum)} kr</b></p></div>
      <button class="xclose" aria-label="Close">&times;</button></div>
    <div class="seglist">${rows.map(t => `<div class="segr${ann.oneOffs[t.fp] ? ' isone' : ''}${ann.workExpenses[t.fp] ? ' iswork' : ''}" data-fp="${t.fp}">
      <span class="sd">${t.date.slice(5)}</span>
      <span class="sm" title="${t.merchant}">${t.merchant}</span>
      <span class="sv num">${kr(t.amount)}</span>
      <span class="sf">
        <label class="mini"><input type="checkbox" class="fo" ${ann.oneOffs[t.fp] ? 'checked' : ''}> one-off</label>
        <label class="mini"><input type="checkbox" class="fw" ${ann.workExpenses[t.fp] ? 'checked' : ''}> work</label>
      </span></div>`).join('')}</div>
    ${rows.length && isSpendRow(rows[0]) ? `<label>Recategorise ${mkey(rows[0])}
      <select id="segCat">${optionsFor(group + ' / ' + label)}</select></label>` : ''}
    <div class="sheet-act"><button class="btn pri" id="segClose">Done</button></div>
  </div></div>`);
  document.body.appendChild(mod);
  const shut = () => { mod.remove(); drawMonth(); };
  mod.querySelector('.xclose').onclick = shut;
  mod.querySelector('#segClose').onclick = shut;
  mod.onclick = e => { if (e.target === mod) shut(); };
  mod.querySelectorAll('.segr').forEach(r => {
    const fp = r.dataset.fp;
    r.querySelector('.fo').onchange = e => {
      if (e.target.checked) ann.oneOffs[fp] = true; else delete ann.oneOffs[fp];
      r.classList.toggle('isone', !!ann.oneOffs[fp]); markDirty(); };
    r.querySelector('.fw').onchange = e => {
      if (e.target.checked) ann.workExpenses[fp] = true; else delete ann.workExpenses[fp];
      r.classList.toggle('iswork', !!ann.workExpenses[fp]); markDirty(); };
  });
  mod.querySelector('#segCat')?.addEventListener('change', e => {
    const [g, l] = (e.target.value || ' / ').split(' / ');
    const r = ann.merchantRules[mkey(rows[0])] ||= {};
    r.group = g || null; r.label = l || null; r.confirmed = true;
    markDirty(); toast('Recategorised — applies to every transaction from this merchant');
  });
}



/* ------------------------------------------------- duplicate repair ----- */
/** Amex identities used to include the statement reference, which changes when
    a period is re-exported — so overlapping imports landed as new rows. The
    rule is fixed, but rows already in the ledger still carry old identities.
    This recomputes them and offers to drop the extras. */
let dupScan = null;

async function scanDuplicates() {
  const marked = await C.refingerprint(ledger.transactions);
  const groups = new Map();
  for (const m of marked) {
    if (!groups.has(m.base)) groups.set(m.base, []);
    groups.get(m.base).push(m);
  }
  dupScan = { marked, groups: [...groups.values()].filter(g => g.length > 1)
    .sort((a, b) => Math.abs(b[0].row.amount) - Math.abs(a[0].row.amount)) };
  drawCoverage();
}

async function applyRepair(dropAll) {
  setSync('busy', 'repairing');
  try {
    const drop = new Set();
    if (dropAll) {
      document.querySelectorAll('.dupg').forEach(g => {
        if (!g.querySelector('input').checked) return;
        JSON.parse(g.dataset.drop).forEach(fp => drop.add(fp));
      });
    }
    const remap = {};
    const kept = [];
    for (const m of dupScan.marked) {
      if (drop.has(m.oldFp)) continue;
      remap[m.oldFp] = m.fp;
      kept.push({ ...m.row, fp: m.fp });
    }
    // annotations are keyed by fingerprint, so they have to follow
    for (const store of ['workExpenses', 'oneOffs', 'corporatePrivate', 'txOverrides']) {
      const next = {};
      for (const [fp, v] of Object.entries(ann[store] || {})) if (remap[fp]) next[remap[fp]] = v;
      ann[store] = next;
    }
    const removed = ledger.transactions.length - kept.length;
    ledger.transactions = kept;
    C.runMatchers(ledger.transactions);
    shaL = await repo.write('ledger.json', ledger, shaL,
      `Repair duplicates: ${removed} removed, identities recomputed`);
    ann.updated = new Date().toISOString();
    shaA = await repo.write('annotations.json', ann, shaA, 'Remap annotations after repair');
    localStorage.setItem(SEEN_KEY, ann.updated);
    dupScan = null; dirty = false; setSync('on', 'synced');
    toast(removed ? `${removed} duplicate rows removed` : 'Identities recomputed, nothing removed');
    drawCoverage();
  } catch (e) { setSync('err', 'error'); banner(e.message); }
}

/* ========================================================== TARGETS ====== */
/** A target key is either a group ("Food & Drinks") or a single label
    ("Food & Drinks / Alcohol"). Groups aggregate their labels. */
const targetKeys = () => {
  const out = [...new Set(CONF.categories.map(c => c.group))].sort()
    .flatMap(g => [g, ...CONF.categories.filter(c => c.group === g).map(c => g + ' / ' + c.label)]);
  return [...out, 'Swish (net)'];
};

/** History for whatever is highlighted in the picker — you cannot set a
    sensible monthly figure without seeing what the last year actually looked
    like. Clears once the target is added. */
function targetPreview(key) {
  const months = complete().slice(-12);
  const items = expenditureItems(months);
  const vals = months.map(m => items.filter(i => i.m === m && matchesKey(i, key)).reduce((a, i) => a + i.v, 0));
  const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
  const mx = Math.max(...vals, 1);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || 0;
  return { avg, median, min: Math.min(...vals), max: mx, html: `
    <div class="preview">
      <div class="pvHead"><b>${key}</b>
        <span>average <em>${krN(avg)}</em> · typical <em>${krN(median)}</em> ·
          range ${krN(Math.min(...vals))}–${krN(mx)}</span></div>
      <div class="hbars">${months.map((m, i) => `<div class="hcol">
        <span class="hv">${vals[i] ? krN(vals[i]) : '–'}</span>
        <div class="hb" style="height:${vals[i] / mx * 78}px"></div>
        <span class="tlab">${monthName(m).slice(0, 3)}</span></div>`).join('')}</div>
      <p class="note">A target below the typical month asks for a change of habit;
        one above it will simply always be met.</p>
    </div>` };
}
/** Grouped so the picker reads as a structure rather than a wall of
    "Group / Label" strings — the same shape as the merchant category picker. */
function targetOptions() {
  const taken = CONF.targets?.monthly || {};
  let h = '<option value="">Choose a category or label…</option>';
  for (const [g, list] of groups()) {
    const opts = [];
    if (!taken[g]) opts.push(`<option value="${g}">All of ${g}</option>`);
    for (const c of list) {
      const k = g + ' / ' + c.label;
      if (!taken[k]) opts.push(`<option value="${k}">${c.label}</option>`);
    }
    if (opts.length) h += `<optgroup label="${g}">${opts.join('')}</optgroup>`;
  }
  if (!taken['Swish (net)']) h += `<optgroup label="Other"><option value="Swish (net)">Swish (net)</option></optgroup>`;
  return h;
}

const matchesKey = (it, key) => key.includes(' / ')
  ? it.group + ' / ' + it.label === key : it.group === key;

/** Month-by-month scoring for the headline rule and every label target.
    Everything is retrospective: this is a scorecard for closed months, not a
    gauge for a month in progress. */
function scoreMonths() {
  const months = complete().slice(-12);
  const items = expenditureItems(months);
  const cash = cashByMonth(months);
  const T = CONF.targets ||= {}; T.monthly ||= {};
  const rows = [];

  const disc = {}, sav = {};
  for (const m of months) {
    disc[m] = items.filter(i => i.m === m && i.tier === 'Discretionary').reduce((a, i) => a + i.v, 0);
    sav[m] = cash[m].net;
  }
  if (T.discretionaryUnderSavings !== false) rows.push({
    key: '__rule', name: 'Discretionary below what you saved', kind: 'rule',
    cells: months.map(m => ({ m, value: disc[m], limit: sav[m], hit: disc[m] < sav[m] })),
  });

  for (const [key, limit] of Object.entries(T.monthly)) {
    rows.push({
      key, name: key, kind: 'label', limit,
      cells: months.map(m => {
        const v = items.filter(i => i.m === m && matchesKey(i, key)).reduce((a, i) => a + i.v, 0);
        return { m, value: v, limit, hit: v <= limit };
      }),
    });
  }
  return { months, rows };
}

const streakOf = cells => {
  let n = 0;
  for (let i = cells.length - 1; i >= 0 && cells[i].hit; i--) n++;
  return n;
};

function drawTargets() {
  const { months, rows } = scoreMonths();
  const host = $('viewTargets');
  if (!months.length) { host.innerHTML = '<div class="empty"><h3>No complete months yet</h3></div>'; return; }
  const last = months.at(-1);
  const rule = rows.find(r => r.key === '__rule');
  const labels = rows.filter(r => r.kind === 'label');
  const hits = r => r.cells.filter(c => c.hit).length;
  const saved = labels.reduce((a, r) => a + r.cells.reduce((x, c) => x + Math.max(0, c.limit - c.value), 0), 0);
  const over = labels.reduce((a, r) => a + r.cells.reduce((x, c) => x + Math.max(0, c.value - c.limit), 0), 0);

  host.innerHTML = `
    ${rule ? (() => {
      const c = rule.cells.at(-1);
      return `<div class="ruleCard ${c.hit ? 'hit' : 'miss'}">
        <div class="rcMain"><b>Discretionary below what you saved</b>
          <span class="rcVerdict">${monthName(last)} — ${c.hit ? 'met' : 'missed'} by ${krN(Math.abs(c.limit - c.value))} kr</span></div>
        <div class="rcNums">
          <span><em>${krN(c.value)}</em>discretionary</span>
          <span><em>${krN(c.limit)}</em>saved</span>
          <span><em>${hits(rule)}/${months.length}</em>months met</span>
        </div></div>`;
    })() : ''}

    <h3 class="sh">Scorecard</h3>
    <div class="score" style="--mn:${months.length}">
      <div class="scHead"><span></span>${months.map(m =>
        `<span>${monthName(m).slice(0, 1)}</span>`).join('')}<span class="scSum">Met</span><span class="scSum">Streak</span></div>
      ${rows.map(r => `<div class="scRow">
        <span class="scName">${r.name}${r.kind === 'label'
          ? `<em>${krN(r.limit)} kr</em>` : ''}</span>
        ${r.cells.map(c => `<span class="dot ${c.hit ? 'on' : 'off'}"
          title="${monthName(c.m)} — ${krN(c.value)} against ${krN(c.limit)}"></span>`).join('')}
        <span class="scSum">${hits(r)}/${months.length}</span>
        <span class="scSum ${streakOf(r.cells) ? 'good' : ''}">${streakOf(r.cells)}</span>
      </div>`).join('')}
    </div>
    <p class="note">One square per complete month, oldest first. Filled means the target was met.
      Hover or tap a square for the figures.</p>

    ${labels.length ? `<div class="kpi" style="margin-top:22px">
      <div class="stat big"><b>Under target, cumulative</b><span class="good">${krN(saved)} kr</span>
        <small>across ${labels.length} target${labels.length > 1 ? 's' : ''} and ${months.length} months</small></div>
      <div class="stat"><b>Over target, cumulative</b><span>${krN(over)} kr</span>
        <small>net ${saved - over >= 0 ? '+' : '−'}${krN(Math.abs(saved - over))} kr</small></div>
    </div>` : ''}

    <h3 class="sh">Your targets</h3>
    <p class="lede">Pick any category or label and set what you want to spend on it each month.
      Steady things make good targets; something that swings between nothing and ten thousand does not.</p>
    <div class="tgt">
      ${labels.length ? labels.map(r => `<div class="tgt-r2" data-k="${encodeURIComponent(r.key)}">
        <b>${r.name}</b>
        <span class="v muted">${krN(r.cells.reduce((a, c) => a + c.value, 0) / months.length)} avg</span>
        <span class="tgtin"><input inputmode="numeric" value="${r.limit}"></span>
        <button class="cdel" title="Remove">&times;</button></div>`).join('')
        : '<div class="tgt-r2"><b class="muted">No targets yet.</b></div>'}
    </div>
    <div class="addrow">
      <select id="newTargetKey">${targetOptions()}</select>
      <input id="newTargetVal" inputmode="numeric" placeholder="kr per month" style="max-width:150px">
      <button class="btn pri" id="addTarget">Add target</button>
    </div>
    <div id="targetPreview"></div>`;

  host.querySelectorAll('.tgt-r2').forEach(r => {
    const key = decodeURIComponent(r.dataset.k || '');
    r.querySelector('input')?.addEventListener('change', e => {
      const v = parseFloat(e.target.value.replace(/\s/g, ''));
      if (isFinite(v) && v > 0) CONF.targets.monthly[key] = Math.round(v);
      confDirty = true; markDirty(); drawTargets();
    });
    r.querySelector('.cdel')?.addEventListener('click', () => {
      delete CONF.targets.monthly[key]; confDirty = true; markDirty(); drawTargets();
    });
  });
  const preview = () => {
    const box = $('targetPreview'), key = $('newTargetKey').value;
    if (!key) { box.innerHTML = ''; return; }
    const items = expenditureItems(months);
    const vals = months.map(m => items.filter(i => i.m === m && matchesKey(i, key)).reduce((a, i) => a + i.v, 0));
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const mx = Math.max(...vals, 1);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    box.innerHTML = `<div class="prev">
      <div class="prevHead"><b>${key}</b>
        <span>average <em>${krN(avg)} kr</em> · range ${krN(lo)}–${krN(hi)} kr over ${months.length} months</span></div>
      <div class="prevBars">${months.map((m, i) => `<div class="pcol">
        <span class="pv">${vals[i] ? krN(vals[i]) : '–'}</span>
        <div class="pb" style="height:${vals[i] / mx * 78}px"></div>
        <span class="tlab">${monthName(m).slice(0, 3)}</span></div>`).join('')}
        <div class="pavg" style="bottom:${22 + avg / mx * 78}px"></div></div>
      <p class="note">Set the target against this, not against a guess. The line marks the average.</p>
    </div>`;
    if (!$('newTargetVal').value) $('newTargetVal').value = Math.round(avg / 100) * 100;
  };
  $('newTargetKey').onchange = () => { $('newTargetVal').value = ''; preview(); };

  $('newTargetKey').onchange = e => {
    const k = e.target.value;
    if (!k) { $('targetPreview').innerHTML = ''; $('newTargetVal').value = ''; return; }
    const p = targetPreview(k);
    $('targetPreview').innerHTML = p.html;
    $('newTargetVal').value = Math.round(p.median / 100) * 100 || Math.round(p.avg / 100) * 100;
  };
  $('addTarget').onclick = () => {
    const k = $('newTargetKey').value;
    const v = parseFloat($('newTargetVal').value.replace(/\s/g, ''));
    if (!k) return toast('Choose a category or label');
    if (!isFinite(v) || v <= 0) return toast('Set a monthly amount');
    CONF.targets.monthly[k] = Math.round(v);
    confDirty = true; markDirty(); drawTargets(); toast('Target added');
  };
}

/* ========================================================== COVERAGE ===== */
function drawCoverage() {
  const acc = C.coverageByAccount(effectiveCoverage(), ledger.transactions);
  const months = complete();
  const labels = Object.fromEntries((CONF.accounts || []).map(a => [a.id, a.label]));
  const tracked = trackedAccounts();
  const end = months.length ? months.at(-1) : null;
  $('viewCoverage').innerHTML = `
    <p class="lede">Insights only use months where <b>every</b> tracked account has data. This is what the
      ledger currently holds.</p>
    <table class="cov"><thead><tr><th>Account</th><th>From</th><th>To</th><th>Basis</th></tr></thead><tbody>
    ${tracked.map(id => {
      const a = acc[id];
      if (!a) return `<tr><td>${labels[id] || id}</td><td colspan="3" class="warnc">No data</td></tr>`;
      const short = end && a.to < end + '-28';
      return `<tr><td><b>${labels[id] || id}</b></td><td class="num">${a.from}</td>
        <td class="num ${short ? 'warnc' : 'okc'}">${a.to}</td>
        <td class="basis">${a.declared ? 'Declared by the export' : 'Inferred from first and last row'}</td></tr>`;
    }).join('')}
    </tbody></table>
    <div class="callout">${months.length
      ? `<b>${months.length} complete month${months.length > 1 ? 's' : ''}:</b> ${monthName(months[0])} to ${monthName(end)}.
         Anything after ${end} is held back from insights until every account covers it.`
      : '<b>No complete months yet.</b> Every tracked account needs to cover the same calendar month.'}</div>
    <h3 class="sh">Declare coverage by hand</h3>
    <p class="lede"><b>To month end</b> is the setting you probably want: it treats an export as covering
      the whole month its last transaction falls in. Amex declares no period, so a final charge on the 28th
      otherwise looks like three missing days and holds the month back. The two dropdowns are for stating a
      window outright; leave them blank to rely on the file.</p>
    <div class="tgt">${tracked.map(id => {
      const ov = (CONF.meta.coverageOverride || {})[id] || {};
      const auto = (CONF.meta.coverageAutoMonth || {})[id];
      return `<div class="ovr-r" data-a="${id}"><b>${labels[id] || id}</b>
        <label class="toggle"><input type="checkbox" class="cva" ${auto ? 'checked' : ''}> To month end</label>
        <span><select class="cvf">${monthOptions(ov.from, false)}</select></span>
        <span><select class="cvt">${monthOptions(ov.to, true)}</select></span></div>`;
    }).join('')}</div>

    <h3 class="sh">Duplicate check</h3>
    <p class="lede">Amex identities used to include the statement reference, which changes when a period is
      re-exported — so an overlapping import could land the same charge twice. The rule is fixed for future
      imports; run this once to recompute identities on what is already stored and clear any duplicates.</p>
    ${!dupScan ? '<button class="btn" id="dupScan">Scan for duplicates</button>' : (() => {
      if (!dupScan.groups.length) return `<div class="callout"><b>No duplicates found.</b>
        Identities still need recomputing so future imports line up.</div>
        <button class="btn pri" id="dupApply">Recompute identities</button>`;
      const total = dupScan.groups.reduce((a, g) => a + (g.length - 1), 0);
      const kr2 = dupScan.groups.reduce((a, g) => a + Math.abs(g[0].row.amount) * (g.length - 1), 0);
      return `<div class="callout"><b>${total} duplicate row${total > 1 ? 's' : ''} found</b>,
        worth ${krN(kr2)} kr. Untick anything that is a genuine repeat purchase — two identical charges on
        one day do happen.</div>
        <div class="tgt">${dupScan.groups.map(g => `<div class="dupg" data-drop='${JSON.stringify(g.slice(1).map(x => x.oldFp))}'>
          <label class="toggle"><input type="checkbox" checked> Remove ${g.length - 1}</label>
          <span class="dupd">${g[0].row.date}</span>
          <span class="dupm">${g[0].row.merchant}</span>
          <span class="v num">${kr(g[0].row.amount)}</span>
          <span class="v muted">${g.length} copies</span></div>`).join('')}</div>
        <div class="addrow"><button class="btn pri" id="dupApply">Remove ticked and recompute</button></div>`;
    })()}

    <p class="note">Swedbank exports declare their own period in the file header, so their coverage is exact —
      including days with no transactions. Amex exports carry no period and no running balance, so coverage is
      inferred from the first and last row, and a gap in the middle would not be visible.</p>`;

  $('dupScan')?.addEventListener('click', scanDuplicates);
  $('dupApply')?.addEventListener('click', () => applyRepair(true));
  $('viewCoverage').querySelectorAll('.ovr-r').forEach(r => {
    const id = r.dataset.a;
    // Update state only. Re-drawing here would replace the control the user is
    // still interacting with, which is what made the date picker unusable.
    const apply = () => {
      const from = r.querySelector('.cvf').value, to = r.querySelector('.cvt').value;
      const ov = CONF.meta.coverageOverride ||= {};
      if (from && to) ov[id] = { from, to }; else delete ov[id];
      confDirty = true; markDirty();
    };
    r.querySelector('.cvf').onchange = apply;
    r.querySelector('.cvt').onchange = apply;
    r.querySelector('.cva').onchange = e => {
      const auto = CONF.meta.coverageAutoMonth ||= {};
      if (e.target.checked) auto[id] = true; else delete auto[id];
      confDirty = true; markDirty(); drawCoverage();      // safe: a checkbox is done being touched
    };
  });
}

/* ============================================================ IMPORT ===== */
function drawImport() {
  const acc = C.coverageByAccount(effectiveCoverage(), ledger.transactions);
  const labels = Object.fromEntries((CONF.accounts || []).map(a => [a.id, a.label]));
  $('viewImport').innerHTML = `
    <p class="lede">Swedbank and Amex CSV exports. Files are read here in your browser — nothing is uploaded
      anywhere except your own private repository. The account is detected from the file; you do not need to pick it.</p>
    <div class="callout">${Object.entries(acc).map(([id, a]) =>
      `<b>${labels[id] || id}</b> through ${a.to}`).join(' &nbsp;·&nbsp; ') || 'Ledger is empty.'}</div>
    <input type="file" id="impFiles" accept=".csv,text/csv" multiple>
    <div id="impOut"></div>
    <div class="sheet-act" style="justify-content:flex-start">
      <button class="btn pri" id="impCommit" disabled>Commit to ledger</button></div>`;
  $('impFiles').onchange = onFiles;
  $('impCommit').onclick = commitImport;
}

async function onFiles(e) {
  const out = $('impOut'); out.innerHTML = '<p class="msg">Reading…</p>';
  const rows = [], notes = [], fatals = [], periods = [];
  for (const f of e.target.files) {
    try {
      const { text, encoding } = C.decode(await f.arrayBuffer());
      const p = C.parseFile(text);
      const breaks = C.checkChain(p.rows);
      const accts = [...new Set(p.rows.map(r => r.account))];
      notes.push({ name: f.name, n: p.rows.length, enc: encoding, accts, period: p.period,
                   rejects: p.rejects.length, breaks: breaks.length });
      if (breaks.length) fatals.push(`${f.name}: the running balance does not chain across ${breaks.length} row(s) — the export is missing transactions. Re-download the full period.`);
      if (p.period) accts.forEach(a => periods.push({ account: a, ...p.period }));
      rows.push(...p.rows);
    } catch (err) { fatals.push(`${f.name}: ${err.message}`); }
  }
  await C.fingerprint(rows);
  const byRef = {};
  for (const a of CONF.accounts || []) {
    if (a.match?.ref) byRef[a.match.ref] = a.id;
    if (a.match?.konto) byRef['81059' + a.match.konto] = a.id;
  }
  rows.forEach(r => { r.role = C.assignRole(r, { dadSwish: CONF.meta.dadSwish, accountsByRef: byRef });
                      r.pair = null; r.review = (r.ref || '') === CONF.meta.dadSwish; });

  const { added, duplicates } = C.merge(ledger.transactions, rows);
  const near = C.nearDuplicates(ledger.transactions, added);
  const known = new Set(merchants().map(m => m.merchant));
  const fresh = [...new Set(added.filter(t => t.role === 'spend' || t.role === 'fee').map(t => t.merchant).filter(m => !known.has(m)))];
  const labels = Object.fromEntries((CONF.accounts || []).map(a => [a.id, a.label]));

  out.innerHTML = '<div class="diff">' + notes.map(n =>
    `<div class="diff-r ${n.breaks || n.rejects ? 'bad' : ''}">
      <span>${n.name}<br><span class="basis">${n.accts.map(a => labels[a] || a).join(', ')} · ${n.enc}${
        n.period ? ` · ${n.period.from} → ${n.period.to} (${n.period.basis})` : ''}</span></span>
      <b>${n.n} rows${n.rejects ? ` · ${n.rejects} unreadable` : ''}${n.breaks ? ` · ${n.breaks} chain breaks` : ''}</b></div>`).join('')
    + `<div class="diff-r"><span><b>New transactions</b></span><b>${added.length}</b></div>
       <div class="diff-r"><span>Already in ledger, skipped</span><b>${duplicates}</b></div>
       <div class="diff-r"><span>Merchants not seen before</span><b>${fresh.length}</b></div>
       ${near.length ? `<div class="diff-r bad"><span>Possible near-duplicates — same merchant, within 5 days, amount within 2%</span><b>${near.length}</b></div>` : ''}
       </div>`
    + (near.length ? `<div class="callout">${near.slice(0, 6).map(h =>
        `${h.incoming.date} ${h.incoming.merchant} ${kr(h.incoming.amount)} — already have ${h.existing.date} ${kr(h.existing.amount)}`).join('<br>')}
        <br><br>These are not identical, so they are being imported. Check them afterwards if a pending charge may have settled twice.</div>` : '')
    + (fatals.length ? `<div class="fatal">${fatals.join('<br>')}</div>` : '');

  pendingImport = fatals.length ? null : { added, periods };
  $('impCommit').disabled = !added.length || !!fatals.length;
}

async function commitImport() {
  if (!pendingImport) return;
  setSync('busy', 'committing');
  try {
    ledger.transactions.push(...pendingImport.added);
    ledger.transactions.sort((a, b) => a.date < b.date ? -1 : 1);
    ledger.coverage = C.mergeCoverage(ledger.coverage, pendingImport.periods);
    C.runMatchers(ledger.transactions);        // across the whole ledger, never just the new rows
    ledger.lastImport = { at: new Date().toISOString(), rows: pendingImport.added.length };
    shaL = await repo.write('ledger.json', ledger, shaL, `Import ${pendingImport.added.length} transactions`);
    pendingImport = null;
    setSync('on', 'synced'); toast('Ledger updated'); go('categorise', 'expenses');
  } catch (e) { setSync('err', 'error'); banner(e.message); }
}

/* ========================================================= CATEGORISE ==== */
function optionsFor(sel) {
  let h = '<option value="">— pick a category —</option>';
  h += `<option value="Unknown / Unknown"${sel === 'Unknown / Unknown' ? ' selected' : ''}>Unknown — decide later</option>`;
  for (const [g, list] of groups()) {
    h += `<optgroup label="${g}">`;
    for (const c of list) { const v = g + ' / ' + c.label; h += `<option value="${v}"${v === sel ? ' selected' : ''}>${c.label}</option>`; }
    h += '</optgroup>';
  }
  return h;
}

function paintGauge() {
  const ms = merchants();
  let done = 0, vDone = 0, vAll = 0, left = 0;
  for (const m of ms) {
    const v = Math.abs(m.total); vAll += v;
    if (ann.merchantRules[m.merchant]?.confirmed) { done++; vDone += v; } else left += v;
  }
  $('grow').style.width = (ms.length ? done / ms.length * 100 : 0) + '%';
  $('gval').style.width = (vAll ? vDone / vAll * 100 : 0) + '%';
  $('lrow').textContent = done; $('trow').textContent = ms.length;
  $('lval').textContent = Math.round(vAll ? vDone / vAll * 100 : 0) + '%';
  $('lkr').textContent = kr(left);
}

function card(m) {
  const r = ann.merchantRules[m.merchant] ||= { group: null, label: null, fixed: false, confirmed: false };
  const wq = workOf(m), net = netOf(m);
  const ones = m.tx.filter(t => ann.oneOffs[t.fp]).length;
  const n = el(`<article class="m ${r.confirmed ? 'ok' : 'todo'}" data-m="${encodeURIComponent(m.merchant)}">
    <div class="m-head">
      <div class="m-id">
        <div class="m-name" title="${m.merchant}">${m.merchant}</div>
        <div class="m-meta"><span class="num">${m.n}&times;</span><span>${m.first} → ${m.last}</span>
          ${m.accounts.map(a => `<span class="tag${a === 'swish' ? ' sw' : ''}">${a.replace('swb_','').replace('amex_','amex ')}</span>`).join('')}
          ${m.tx.some(t => t.review) ? '<span class="tag rev">check</span>' : ''}
          ${wq.length ? `<span class="tag wk">${wq.length} work</span>` : ''}
          ${ones ? `<span class="tag one">${ones} one-off</span>` : ''}</div>
      </div>
      <div class="m-amt num">${kr(net)}${wq.length ? `<small>was ${kr(m.total)}</small>` : ''}</div>
      <div class="m-ctl">
        <select class="pick">${optionsFor(cat(r))}</select>
        <label class="toggle"><input type="checkbox" class="fix" ${r.fixed ? 'checked' : ''}> Fixed</label>
        <button class="ok-btn">${r.confirmed ? 'Confirmed' : 'Confirm'}</button>
        <button class="disc">${m.n > 1 ? `Show ${m.n} transactions` : 'Show transaction'}</button>
      </div>
    </div>
    <div class="tx">${m.tx.slice().sort((a, b) => a.date < b.date ? 1 : -1).map(t =>
      `<div class="tx-r${ann.workExpenses[t.fp] ? ' wk' : ''}" data-fp="${t.fp}">
        <span class="when">${t.date} · ${(t.account || '').replace('swb_','').replace('amex_','amex ')}</span>
        <span class="num">${kr(t.amount)}</span>
        <label class="mini"><input type="checkbox" class="cbw" ${ann.workExpenses[t.fp] ? 'checked' : ''}> Work</label>
        <label class="mini"><input type="checkbox" class="cbo" ${ann.oneOffs[t.fp] ? 'checked' : ''}> One-off</label>
       </div>`).join('')}</div>
  </article>`);

  n.querySelector('.pick').onchange = e => {
    const [g, l] = (e.target.value || ' / ').split(' / ');
    r.group = g || null; r.label = l || null;
    if (g) { r.fixed = defaultFixed(g, l); n.querySelector('.fix').checked = r.fixed; }
    markDirty();
  };
  n.querySelector('.fix').onchange = e => { r.fixed = e.target.checked; markDirty(); };
  n.querySelector('.ok-btn').onclick = () => {
    if (!r.group) return toast('Pick a category first');
    r.confirmed = !r.confirmed; markDirty(); render(); refreshBadges();
  };
  n.querySelector('.disc').onclick = () => n.classList.toggle('open');
  const reopen = () => document.querySelector(`[data-m="${encodeURIComponent(m.merchant)}"]`)?.classList.add('open');
  n.querySelectorAll('.cbw').forEach(cb => cb.onchange = ev => {
    const fp = ev.target.closest('.tx-r').dataset.fp;
    if (ev.target.checked) ann.workExpenses[fp] = true; else delete ann.workExpenses[fp];
    markDirty(); render(); reopen();
  });
  n.querySelectorAll('.cbo').forEach(cb => cb.onchange = ev => {
    const fp = ev.target.closest('.tx-r').dataset.fp;
    if (ev.target.checked) ann.oneOffs[fp] = true; else delete ann.oneOffs[fp];
    markDirty(); render(); reopen();
  });
  return n;
}

function render() {
  if (!ledger) return;
  let ms = merchants().filter(m => {
    const r = ann.merchantRules[m.merchant];
    if (filter === 'todo' && r?.confirmed) return false;
    if (filter === 'ok' && !r?.confirmed) return false;
    if (filter === 'unknown' && r?.group !== 'Unknown') return false;
    if (filter === 'once' && (m.n !== 1 || r?.confirmed)) return false;
    if (query && !m.merchant.toLowerCase().includes(query)) return false;
    return true;
  });
  ms.sort((a, b) => sort === 'value' ? Math.abs(b.total) - Math.abs(a.total)
                  : sort === 'count' ? b.n - a.n
                  : (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));

  const list = $('list'); list.innerHTML = '';
  if (!ms.length) list.appendChild(el(`<div class="empty"><h3>Nothing here</h3><p>${
    filter === 'todo' ? 'Every merchant is confirmed.' : 'Try a different filter.'}</p></div>`));
  else ms.forEach(m => list.appendChild(card(m)));

  const b = $('bulk'); b.innerHTML = '';

  // suggest categories for anything still blank
  const blank = ms.filter(m => !ann.merchantRules[m.merchant]?.group);
  if (blank.length > 1) {
    const n = el(`<div class="bulk"><span><b>${blank.length}</b> merchants have no category yet.
      Suggest one for each by matching against the rules you already have.</span>
      <button class="btn">Suggest categories</button></div>`);
    n.querySelector('button').onclick = () => {
      let hit = 0;
      const M = suggestModel();
      for (const m of blank) {
        const g = suggestFor(m.merchant, M);
        if (!g) continue;
        const r = ann.merchantRules[m.merchant] ||= {};
        r.group = g.group; r.label = g.label; r.fixed = defaultFixed(g.group, g.label); hit++;
      }
      markDirty(); render();
      toast(hit ? `${hit} of ${blank.length} suggested — check them, then confirm`
                : 'Nothing close enough to suggest');
    };
    b.appendChild(n);
  }

  // assign one category to everything currently listed
  if (ms.length > 1 && filter !== 'ok') {
    const n = el(`<div class="bulk alt"><span>Assign one category to all <b>${ms.length}</b> merchants shown</span>
      <select class="bulkcat">${optionsFor('')}</select>
      <button class="btn">Apply</button></div>`);
    n.querySelector('button').onclick = () => {
      const v = n.querySelector('.bulkcat').value;
      if (!v) return toast('Pick a category first');
      const [g, l] = v.split(' / ');
      for (const m of ms) {
        const r = ann.merchantRules[m.merchant] ||= {};
        r.group = g; r.label = l; r.fixed = defaultFixed(g, l); r.confirmed = true;
      }
      markDirty(); render(); refreshBadges();
      toast(`${ms.length} merchants set to ${l}`);
    };
    b.appendChild(n);
  }

  const pending = ms.filter(m => !ann.merchantRules[m.merchant]?.confirmed && ann.merchantRules[m.merchant]?.group);
  if (filter === 'todo' && pending.length > 1) {
    const n = el(`<div class="bulk"><span><b>${pending.length}</b> merchants already have a category.
      Confirm them all, then fix any that look wrong.</span><button class="btn pri">Confirm all ${pending.length}</button></div>`);
    n.querySelector('button').onclick = () => {
      pending.forEach(m => ann.merchantRules[m.merchant].confirmed = true);
      markDirty(); render(); refreshBadges(); toast(pending.length + ' confirmed');
    };
    b.appendChild(n);
  }
  paintGauge(); summary();
}

function summary() {
  const agg = {};
  for (const m of merchants()) {
    const r = ann.merchantRules[m.merchant];
    if (!r?.confirmed || !r.group) continue;
    agg[r.group] = (agg[r.group] || 0) + Math.abs(netOf(m));
  }
  const rows = Object.entries(agg).sort((a, b) => b[1] - a[1]);
  const wkTot = Object.keys(ann.workExpenses).reduce((a, fp) => {
    const t = ledger.transactions.find(x => x.fp === fp); return a + (t ? Math.abs(t.amount) : 0); }, 0);
  const s = $('sum');
  if (!rows.length) { s.innerHTML = '<h2>Breakdown</h2><p class="lede">Confirm a few merchants and the breakdown builds here.</p>'; return; }
  const max = rows[0][1];
  s.innerHTML = '<h2>Breakdown — confirmed only, whole ledger</h2>' + rows.map(([g, v]) =>
    `<div class="sum-r"><b>${g}</b><div class="sum-bar"><i style="width:${v / max * 100}%"></i></div>
     <em class="num">${kr(v)}</em></div>`).join('')
    + (wkTot ? `<div class="wknote"><b>${Object.keys(ann.workExpenses).length}</b> transactions marked work-related —
       <span class="num">${kr(wkTot)}</span> excluded from spending, expected back as reimbursement.</div>` : '');
}

/* --------------------------------------------------------- corporate ----- */
function renderCorp() {
  if (!ledger) return;
  const rows = corpRows();
  const unrev = corpUnreviewed();
  const host = $('viewCorp');
  host.querySelector('#corpTop')?.remove();
  const top = el(`<div id="corpTop">${unrev
    ? `<div class="bulk"><span><b>${unrev}</b> charge${unrev > 1 ? 's' : ''} imported since you last reviewed this card.</span>
       <button class="btn pri">Mark all reviewed</button></div>`
    : `<div class="callout">All ${rows.length} charges reviewed${ann.corpReviewedThrough ? ` through ${ann.corpReviewedThrough}` : ''}.</div>`}</div>`);
  host.insertBefore(top, $('corpList'));
  top.querySelector('button')?.addEventListener('click', () => {
    ann.corpReviewedThrough = rows[0]?.date || null;
    markDirty(); renderCorp(); refreshBadges(); toast('Marked reviewed');
  });

  const list = $('corpList'); list.innerHTML = '';
  let month = null, sub = 0, head = null;
  const flush = () => { if (head) head.querySelector('em').textContent = kr(sub); };
  for (const t of rows) {
    const mo = t.date.slice(0, 7);
    if (mo !== month) {
      flush(); month = mo; sub = 0;
      head = el(`<div class="mo"><span>${new Date(mo + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span><em class="num"></em></div>`);
      list.appendChild(head);
    }
    sub += t.amount;
    const p = ann.corporatePrivate[t.fp];
    const row = el(`<div class="c${p ? ' priv' : ''}"><span class="c-d num">${t.date.slice(5)}</span>
      <span class="c-m" title="${t.merchant}">${t.merchant}</span>
      <span class="c-a num">${kr(t.amount)}</span>
      <label class="toggle"><input type="checkbox" ${p ? 'checked' : ''}> Private</label></div>`);
    row.querySelector('input').onchange = e => {
      if (e.target.checked) ann.corporatePrivate[t.fp] = { private: true, group: null, label: null };
      else delete ann.corporatePrivate[t.fp];
      markDirty(); renderCorp();
    };
    if (p) {
      const pick = el(`<select class="c-pick">${optionsFor(cat(p))}</select>`);
      pick.onchange = e => { const [g, l] = (e.target.value || ' / ').split(' / '); p.group = g || null; p.label = l || null; markDirty(); };
      row.appendChild(pick);
    }
    list.appendChild(row);
  }
  flush();
}

/* ------------------------------------------------------------- swish ----- */
function renderSwish() {
  if (!ledger) return;
  const rows = ledger.transactions.filter(isPersonSwish);
  const by = new Map();
  for (const t of rows) {
    const e = by.get(t.ref) || { ref: t.ref, n: 0, sent: 0, recv: 0, net: 0 };
    e.n++; e.net += t.amount; t.amount < 0 ? e.sent += t.amount : e.recv += t.amount;
    by.set(t.ref, e);
  }
  const ppl = [...by.values()].sort((a, b) => a.net - b.net);
  const sent = ppl.reduce((a, c) => a + c.sent, 0), recv = ppl.reduce((a, c) => a + c.recv, 0), net = sent + recv;

  const mo = new Map();
  for (const t of rows) {
    const k = t.date.slice(0, 7);
    const e = mo.get(k) || { m: k, sent: 0, recv: 0, net: 0 };
    e.net += t.amount; t.amount < 0 ? e.sent += t.amount : e.recv += t.amount; mo.set(k, e);
  }
  const months = [...mo.values()].sort((a, b) => a.m < b.m ? -1 : 1);

  $('swHead').innerHTML = `<div class="stat3">
    <div class="stat"><b>Sent</b><span>${kr(sent)}</span><small>${rows.filter(t => t.amount < 0).length} payments</small></div>
    <div class="stat"><b>Received</b><span>${kr(recv)}</span><small>${rows.filter(t => t.amount > 0).length} payments</small></div>
    <div class="stat big"><b>Net</b><span>${kr(net)}</span><small>${kr(net / (months.length || 1))} / month</small></div></div>
    <div class="verdict">You are a net <b>${net < 0 ? 'sender' : 'receiver'}</b> — across ${rows.length} transactions with
    ${ppl.length} people you ${net < 0 ? 'put in' : 'took out'} <b>${kr(Math.abs(net))}</b> more than came back.</div>`;

  const mx = Math.max(...months.map(m => Math.max(-m.sent, m.recv)), 1);
  $('swChart').innerHTML = '<div class="chart">' + months.map(m => `<div class="col">
    <div class="plot"><div class="pos" style="height:${m.recv / mx * 72}px"></div></div><div class="mid"></div>
    <div class="plot lower"><div class="neg2" style="height:${-m.sent / mx * 72}px"></div></div>
    <em>${Math.round(m.net / 100) / 10}k</em><span class="lab">${monthName(m.m).slice(0, 3)}</span></div>`).join('') + '</div>';

  const host = $('swPeople');
  host.innerHTML = '<div class="cp-h"><span>Person</span><span>Sent</span><span>Received</span><span>Net</span></div>';
  for (const c of ppl) {
    const r = el(`<div class="cp"><input placeholder="${c.ref}" value="${(ann.swishNames[c.ref] || '').replace(/"/g, '&quot;')}">
      <span class="v">${c.sent ? kr(c.sent) : '—'}</span><span class="v">${c.recv ? kr(c.recv) : '—'}</span>
      <span class="net ${c.net < 0 ? 'dn' : 'up'}">${kr(c.net)}</span></div>`);
    r.querySelector('input').onchange = e => {
      const v = e.target.value.trim();
      if (v) ann.swishNames[c.ref] = v; else delete ann.swishNames[c.ref];
      markDirty(); refreshBadges();
    };
    host.appendChild(r);
  }
}


/* ------------------------------------------------------- suggestions ---- */
const norm = s => String(s).toUpperCase().replace(/[^A-ZÅÄÖ]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => [...new Set(norm(s).split(' ').filter(w => w.length >= 3))];

/** Learns which words go with which category from the rules you have already
    written, then scores a new merchant on the evidence its words carry.
    Rare words count for more than common ones, and a guess is only offered
    when it clearly beats the runner-up — tested against your own 242 rules it
    ventures an answer on about 30% of them and is right 92% of the time.
    Deliberately silent on the rest: a wrong suggestion costs more than none. */
function suggestModel() {
  const idx = {}, docs = {};
  let n = 0;
  for (const [name, r] of Object.entries(ann.merchantRules)) {
    if (!r.group || r.group === 'Unknown') continue;
    n++;
    const key = r.group + ' / ' + r.label;
    for (const w of toks(name)) { (idx[w] ||= {})[key] = (idx[w][key] || 0) + 1; docs[w] = (docs[w] || 0) + 1; }
  }
  return { idx, docs, n: n || 1 };
}

function suggestFor(name, M) {
  const votes = {};
  for (const w of toks(name)) {
    const e = M.idx[w];
    if (!e) continue;
    const idf = Math.log(M.n / (M.docs[w] || 1)) + 1;
    for (const [k, c] of Object.entries(e)) votes[k] = (votes[k] || 0) + c * idf;
  }
  const rank = Object.entries(votes).sort((a, b) => b[1] - a[1]);
  if (!rank.length) return null;
  const [k, score] = rank[0];
  const second = rank[1] ? rank[1][1] : 0;
  if (score < 1.5 || score < second * 1.2) return null;
  const [group, label] = k.split(' / ');
  return { group, label, score };
}

/* --------------------------------------------------- subscriptions ------ */
function drawSubs() {
  const months = complete().slice(-12);
  const host = $('viewSubs');
  if (!months.length) { host.innerHTML = '<div class="empty"><h3>No complete months yet</h3></div>'; return; }
  const last = months.at(-1);
  // Must-have recurring costs are not decisions, so they would only crowd out
  // the things you can actually act on.
  const all = recurring(months).filter(r => r.tier !== 'Must have');
  const live = all.filter(r => !r.cancelled);
  const subs = live.filter(r => r.kind === 'subscription').sort((a, b) => b.last - a.last);
  const habits = live.filter(r => r.kind === 'habit').sort((a, b) => b.mean - a.mean);
  const gone = all.filter(r => r.cancelled).sort((a, b) => b.mean - a.mean);
  const basis = (r, mode) => mode === 'subscription' ? r.last : r.mean;   // habits are too lumpy for one month
  const runRate = (list, mode) => list.reduce((a, r) => a + basis(r, mode) * 12, 0);
  const saved = gone.reduce((a, r) => a + r.mean * 12, 0);

  host.innerHTML = `
    <p class="lede">Detected automatically: anything appearing in most of the last ${months.length} months.
      Must-have costs such as rent, energy and a-kassa are left out. Figures are ${monthName(last)}
      annualised — what you are on track to spend if nothing changes.</p>

    <div class="kpi">
      <div class="stat big"><b>Subscriptions, annual run rate</b><span>${krN(runRate(subs))} kr</span>
        <small>${subs.length} active · ${krN(runRate(subs) / 12)} kr in ${monthName(last)}</small></div>
      <div class="stat"><b>Habits, annual</b><span>${krN(habits.reduce((a, r) => a + r.mean * 12, 0))} kr</span>
        <small>${habits.length} merchants · averaged, not annualised from one month</small></div>
      <div class="stat"><b>Cancelled — saving</b><span class="good">${krN(saved)} kr</span>
        <small>${gone.length ? `${gone.length} cancelled · ${krN(saved / 12)} kr a month` : 'nothing cancelled yet'}</small></div>
    </div>

    <h3 class="sh">Subscriptions — same amount every month</h3>
    <p class="lede">These renew whether you use them or not. Tick one off when you cancel it.</p>
    ${subTable(subs, last, 'subscription')}

    <h3 class="sh">Habits — recurring, but the amount varies</h3>
    <p class="lede">Not cancellable, but trackable. Tap a row to see how it has moved month by month.</p>
    ${subTable(habits, last, 'habit')}

    ${gone.length ? `<h3 class="sh">Cancelled</h3>
      <p class="lede">Kept here so the saving stays visible. Untick to bring one back.</p>
      ${subTable(gone, last, 'gone')}` : ''}

    <p class="note">A merchant counts as recurring when it appears in at least
      ${Math.ceil(months.length * ((CONF.meta.recurring || {}).minMonthsShare ?? 0.6))} of ${months.length} months.
      Subscriptions are those whose monthly amount barely moves; the split is automatic but you can move any row.
      Subscriptions are shown at ${monthName(last)} annualised. Habits are averaged across the ${months.length} months,
      because several bill nothing in a given month — the arrow compares the recent months against the earlier ones.
      A cancelled item is valued at its average, since ${monthName(last)} may already be zero.</p>`;

  wireSubs(host, months);
}

const arrow = pct => pct > 5 ? `<i class="arw up" title="up ${Math.round(pct)}%">▲</i>`
  : pct < -5 ? `<i class="arw dn" title="down ${Math.round(pct)}%">▼</i>`
  : '<i class="arw fl" title="steady">–</i>';

function subTable(list, last, mode) {
  if (!list.length) return '<p class="lede">None.</p>';
  // Subscriptions bill the same amount every month, so the latest month is the
  // truest run rate. Habits are lumpy — several bill nothing at all in a given
  // month — so they are averaged, with an arrow for direction.
  const avgBasis = mode !== 'subscription';
  return `<div class="tgt"><div class="sub-h">
      <span>Merchant</span><span>Category</span><span>${avgBasis ? 'Per month, avg' : monthName(last)}</span><span>Per year</span><span></span></div>
    ${list.map((r, i) => `<div class="sub-r ${mode === 'gone' ? 'off' : ''} ${mode === 'habit' ? 'tap' : ''}" data-m="${encodeURIComponent(r.merchant)}" data-i="${i}">
        <b>${r.merchant}${mode === 'habit' ? '<span class="chev">›</span>' : ''}</b>
        <span class="sc">${r.cat}<span class="tag tt${TIERS.indexOf(r.tier)}">${r.tier}</span></span>
        <span class="v">${krN(avgBasis ? r.mean : r.last)}${mode === 'habit' ? ' ' + arrow(r.momentum) : ''}</span>
        <span class="v strong">${krN((avgBasis ? r.mean : r.last) * 12)}</span>
        <span class="acts2">
          <label class="mini"><input type="checkbox" class="cx" ${r.cancelled ? 'checked' : ''}> Cancelled</label>
          ${mode !== 'gone' ? `<button class="lnk mv2">${r.kind === 'subscription' ? 'to habits' : 'to subscriptions'}</button>` : ''}
        </span>
      </div>
      ${mode === 'habit' ? `<div class="hist" data-h="${i}" hidden></div>` : ''}`).join('')}
  </div>`;
}

function wireSubs(host, months) {
  const byName = Object.fromEntries(recurring(months).map(r => [r.merchant, r]));
  host.querySelectorAll('.sub-r').forEach(row => {
    const name = decodeURIComponent(row.dataset.m);
    row.querySelector('.cx').onchange = e => {
      const rec = ann.recurring[name] ||= {};
      if (e.target.checked) rec.cancelled = new Date().toISOString().slice(0, 10);
      else delete rec.cancelled;
      markDirty(); drawSubs();
    };
    row.querySelector('.mv2')?.addEventListener('click', ev => {
      ev.stopPropagation();
      const rec = ann.recurring[name] ||= {};
      rec.kind = byName[name]?.kind === 'subscription' ? 'habit' : 'subscription';
      markDirty(); drawSubs();
    });
    if (!row.classList.contains('tap')) return;
    row.onclick = ev => {
      if (ev.target.closest('.acts2')) return;
      const box = host.querySelector(`[data-h="${row.dataset.i}"]`);
      if (!box) return;
      if (!box.dataset.built) { box.innerHTML = historyFor(byName[name], months); box.dataset.built = '1'; }
      box.hidden = !box.hidden; row.classList.toggle('open', !box.hidden);
    };
  });
}

/** Month-by-month for one habit, with the recent half compared to the earlier
    half — the question is direction, not level. */
function historyFor(r, months) {
  if (!r) return '';
  const vals = months.map(m => r.per[m] || 0);
  const mx = Math.max(...vals, 1);
  const half = Math.floor(months.length / 2);
  const { early, late, momentum: pct } = r;
  return `<div class="histin">
    <div class="hbars">${months.map((m, i) => `<div class="hcol">
      <span class="hv">${vals[i] ? krN(vals[i]) : '–'}</span>
      <div class="hb" style="height:${vals[i] / mx * 72}px"></div>
      <span class="tlab">${monthName(m).slice(0, 3)}</span></div>`).join('')}</div>
    <div class="htrend ${pct > 5 ? 'up' : pct < -5 ? 'dn' : ''}">
      Recent ${months.length - half} months average <b>${krN(late)} kr</b> against
      <b>${krN(early)} kr</b> earlier — ${pct > 0 ? '+' : ''}${Math.round(pct)}%</div>
  </div>`;
}

/* ------------------------------------------------- transfers & income --- */
const COUNTS = [['expenditure','Expenditure'],['income','Income'],['savings','Savings'],
                ['p2p','Personal Swish'],['ignore','Ignore']];

function renderOther() {
  if (!ledger) return;
  const host = $('viewOther');
  const band = CONF.meta.mortgageBand;
  const accByRef = Object.fromEntries((CONF.accounts || []).filter(a => a.match?.ref).map(a => [a.match.ref, a.label]));
  host.innerHTML = `<p class="lede">Everything that is not a merchant purchase or a Swish with a person:
    salary, reimbursements, the mortgage, transfers to savings. Set a rule per counterparty; override an
    individual transaction where it differs.</p><div id="otherList"></div>`;
  const list = $('otherList');

  for (const g of otherGroups()) {
    const rule = ann.transferRules[g.key] ||= { counts: null, group: null, label: null, confirmed: false };
    const eff = rule.counts || DEFAULT_COUNTS[g.tx[0].role] || 'ignore';
    const name = accByRef[g.key] || ann.swishNames[g.key] || g.key;
    const odd = band ? g.tx.filter(t => t.amount < 0 && (Math.abs(t.amount) < band[0] || Math.abs(t.amount) > band[1])).length : 0;

    const card = el(`<article class="m ${rule.confirmed ? 'ok' : 'todo'}">
      <div class="m-head">
        <div class="m-id"><div class="m-name">${name}</div>
          <div class="m-meta"><span class="num">${g.n}&times;</span>
            <span>${g.tx[0].date} → ${g.tx.at(-1).date}</span>
            <span class="tag">${g.tx[0].role.replace(/_/g,' ')}</span>
            ${odd && eff === 'expenditure' ? `<span class="tag rev">${odd} outside band</span>` : ''}</div></div>
        <div class="m-amt num">${kr(g.total)}</div>
        <div class="m-ctl">
          <select class="cnt">${COUNTS.map(([v,l]) => `<option value="${v}"${v === eff ? ' selected' : ''}>Counts as ${l}</option>`).join('')}</select>
          <select class="pick" ${eff === 'expenditure' ? '' : 'disabled'}>${optionsFor(cat(rule))}</select>
          <button class="ok-btn">${rule.confirmed ? 'Confirmed' : 'Confirm'}</button>
          <button class="disc">Show ${g.n} transaction${g.n > 1 ? 's' : ''}</button>
        </div>
      </div>
      <div class="tx">${g.tx.slice().sort((a,b) => a.date < b.date ? 1 : -1).map(t => {
        const o = ann.txOverrides[t.fp] || {};
        const out = Math.abs(t.amount), flag = band && t.amount < 0 && (out < band[0] || out > band[1]);
        const oc = o.counts || eff;
        return `<div class="tx-r" data-fp="${t.fp}">
          <span class="when">${t.date}${flag ? ' <span class="tag rev">outside band</span>' : ''}</span>
          <span class="num">${kr(t.amount)}</span>
          <select class="ovr"><option value="">follow rule</option>
            ${COUNTS.map(([v,l]) => `<option value="${v}"${o.counts === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <select class="ovrcat" ${oc === 'expenditure' ? '' : 'disabled'}>
            <option value="">follow rule</option>
            ${('group' in o) ? optionsFor(cat(o)).replace('<option value="">— pick a category —</option>','') : optionsFor('').replace('<option value="">— pick a category —</option>','')}
          </select>
        </div>`;
      }).join('')}</div></article>`);

    card.querySelector('.cnt').onchange = e => {
      rule.counts = e.target.value;
      if (rule.counts !== 'expenditure') { rule.group = rule.label = null; }
      markDirty(); renderOther();
    };
    card.querySelector('.pick').onchange = e => {
      const [gr, l] = (e.target.value || ' / ').split(' / ');
      rule.group = gr || null; rule.label = l || null; markDirty();
    };
    card.querySelector('.ok-btn').onclick = () => {
      if (!rule.counts) rule.counts = eff;
      if (rule.counts === 'expenditure' && !rule.group) return toast('Pick a category first');
      rule.confirmed = !rule.confirmed; markDirty(); renderOther(); refreshBadges();
    };
    card.querySelector('.disc').onclick = () => card.classList.toggle('open');
    card.querySelectorAll('.ovr').forEach(sel => sel.onchange = ev => {
      const fp = ev.target.closest('.tx-r').dataset.fp;
      if (ev.target.value) (ann.txOverrides[fp] ||= {}).counts = ev.target.value;
      else { const o = ann.txOverrides[fp]; if (o) { delete o.counts; if (!Object.keys(o).length) delete ann.txOverrides[fp]; } }
      markDirty(); renderOther(); refreshBadges();
    });
    card.querySelectorAll('.ovrcat').forEach(sel => sel.onchange = ev => {
      const fp = ev.target.closest('.tx-r').dataset.fp;
      const o = ann.txOverrides[fp] ||= {};
      if (ev.target.value) { const [gr, l] = ev.target.value.split(' / '); o.group = gr; o.label = l; }
      else { delete o.group; delete o.label; if (!Object.keys(o).length) delete ann.txOverrides[fp]; }
      markDirty();
    });
    list.appendChild(card);
  }
}

function refreshBadges() {
  const n = unconfirmed() + corpUnreviewed() + swishUnnamed() + otherUnruled();
  $('navBadge').textContent = n; $('navBadge').hidden = !n;
  document.querySelectorAll('#subnavIn button').forEach(b => {
    const id = b.dataset.p;
    const v = id === 'expenses' ? unconfirmed() : id === 'corp' ? corpUnreviewed()
            : id === 'swish' ? swishUnnamed() : id === 'other' ? otherUnruled() : 0;
    const em = b.querySelector('em'); em.textContent = v; em.hidden = !v;
  });
}

/* -------------------------------------------------- categories editor ---- */
$('confBtn').onclick = openConfig;
function openConfig() {
  if (!CONF || !ann) return toast('Connect first');
  $('confModal')?.remove();
  const m = el(`<div class="modal" id="confModal"><div class="sheet wide">
    <h2>Categories &amp; settings</h2>
    <p class="lede">Stored in <b>config.json</b> in your private repo. The tier decides whether spending counts as
      must have, essential or discretionary. Renaming a label rewrites every merchant rule that points at it.</p>
    <div id="confList"></div>
    <div class="addrow"><input id="newGroup" placeholder="New group name" autocapitalize="words">
      <button class="btn" id="addGroup">Add group</button></div>
    <h3 class="sh">Settings</h3>
    <label>Opening receivable at ${CONF.meta.openingDate || 'start'} (kr)
      <input id="mOpen" inputmode="numeric" value="${CONF.meta.openingReceivable ?? ''}"></label>
    <label>Dad — Swish number, flagged for review on every import
      <input id="mDad" autocapitalize="off" value="${CONF.meta.dadSwish || ''}"></label>
    <div class="sheet-act"><button class="btn pri" id="confClose">Done</button></div>
  </div></div>`);
  document.body.appendChild(m);
  m.querySelector('#confClose').onclick = () => {
    const o = parseFloat(m.querySelector('#mOpen').value);
    if (isFinite(o)) CONF.meta.openingReceivable = o;
    CONF.meta.dadSwish = m.querySelector('#mDad').value.trim();
    confDirty = true; markDirty(); m.remove();
  };
  m.querySelector('#addGroup').onclick = () => {
    const g = m.querySelector('#newGroup').value.trim();
    if (!g) return;
    if (groups().has(g)) return toast('That group already exists');
    CONF.categories.push({ group: g, label: 'Other ' + g.toLowerCase(), fixed: false });
    confDirty = true; markDirty(); drawConfig();
  };
  drawConfig();
}

function drawConfig() {
  const host = $('confList'); if (!host) return;
  host.innerHTML = '';
  for (const [g, list] of groups()) {
    const box = el(`<div class="cgrp"><div class="cgrp-h"><b>${g}</b><span class="num">${list.length} labels</span></div>
      <div class="cgrp-b"></div>
      <div class="addrow subrow"><input placeholder="New label in ${g}"><button class="btn">Add</button></div></div>`);
    const body = box.querySelector('.cgrp-b');
    for (const c of list) {
      const used = ruleCount(c.group, c.label);
      const row = el(`<div class="crow"><input class="cname" value="${c.label.replace(/"/g, '&quot;')}">
        <select class="ctier">${TIERS.map(t => `<option${t === (c.tier || 'Discretionary') ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <label class="mini"><input type="checkbox" class="cfix" ${c.fixed ? 'checked' : ''}> Fixed</label>
        <span class="cuse num">${used ? used + ' in use' : 'unused'}</span>
        <button class="cdel" title="Delete">&times;</button></div>`);
      row.querySelector('.cname').onchange = e => {
        const to = e.target.value.trim();
        if (!to) { e.target.value = c.label; return; }
        if (list.some(x => x !== c && x.label === to)) { e.target.value = c.label; return toast('That label already exists here'); }
        const from = c.label;
        Object.values(ann.merchantRules).forEach(r => { if (r.group === g && r.label === from) r.label = to; });
        Object.values(ann.corporatePrivate).forEach(r => { if (r.group === g && r.label === from) r.label = to; });
        c.label = to; confDirty = true; markDirty(); drawConfig(); render();
        toast(used ? `Renamed — ${used} merchant rule(s) updated` : 'Renamed');
      };
      row.querySelector('.ctier').onchange = e => { c.tier = e.target.value; confDirty = true; markDirty(); };
      row.querySelector('.cfix').onchange = e => { c.fixed = e.target.checked; confDirty = true; markDirty(); };
      row.querySelector('.cdel').onclick = () => {
        if (used) return toast(`Still used by ${used} merchant(s) — move them first`);
        CONF.categories = CONF.categories.filter(x => x !== c);
        confDirty = true; markDirty(); drawConfig();
      };
      body.appendChild(row);
    }
    const addI = box.querySelector('.addrow.subrow input'), addB = box.querySelector('.addrow.subrow button');
    addB.onclick = () => {
      const l = addI.value.trim();
      if (!l) return;
      if (list.some(x => x.label === l)) return toast('That label already exists here');
      CONF.categories.push({ group: g, label: l, fixed: false });
      confDirty = true; markDirty(); drawConfig();
    };
    host.appendChild(box);
  }
}

/* ---------------------------------------------------------- settings ----- */
$('setBtn').onclick = () => {
  if (cfg) { $('cfgOwner').value = cfg.owner; $('cfgRepo').value = cfg.repo; $('cfgToken').value = cfg.token; }
  $('setMsg').textContent = ''; $('setModal').hidden = false;
};
$('setClose').onclick = () => $('setModal').hidden = true;
$('setForget').onclick = () => { localStorage.removeItem(CFG_KEY); location.reload(); };
$('setSave').onclick = async () => {
  const next = { owner: $('cfgOwner').value.trim(), repo: $('cfgRepo').value.trim(), token: $('cfgToken').value.trim() };
  if (!next.owner || !next.repo || !next.token) { $('setMsg').className = 'msg bad'; $('setMsg').textContent = 'All three fields are needed.'; return; }
  $('setMsg').className = 'msg'; $('setMsg').textContent = 'Connecting…';
  cfg = next;
  try {
    await connect();
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    $('setModal').hidden = true; banner(staleWarning || ''); boot();
  } catch (e) { $('setMsg').className = 'msg bad'; $('setMsg').textContent = e.message; setSync('err', 'error'); }
};

/* -------------------------------------------------------------- wiring --- */
document.querySelectorAll('.chip[data-f]').forEach(c => c.onclick = () => {
  filter = c.dataset.f;
  document.querySelectorAll('.chip[data-f]').forEach(x => x.setAttribute('aria-pressed', x === c));
  render();
});
document.querySelectorAll('.chip[data-s]').forEach(c => c.onclick = () => {
  sort = c.dataset.s;
  document.querySelectorAll('.chip[data-s]').forEach(x => x.setAttribute('aria-pressed', x === c));
  render();
});
$('q').oninput = e => { query = e.target.value.toLowerCase().trim(); render(); };
$('saveBtn').onclick = save;

let tt; function toast(m) { const t = $('toast'); t.textContent = m; t.classList.add('on'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('on'), 1900); }
addEventListener('beforeunload', e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

/* ---------------------------------------------------------------- boot --- */
function boot() {
  window.__booted = true;                    // tells the watchdog in index.html we are alive
  $('confBtn').hidden = false;
  go(unconfirmed() ? 'categorise' : 'control');
}

(async function init() {
  window.__booted = true;
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { cfg = null; }
  if (!cfg) {
    banner('Not connected yet. Open <b>Settings</b> and enter your GitHub username, the data repository name, and your access token.');
    setSync('err', 'not set up');
    return;
  }
  try { await connect(); boot(); if (staleWarning) banner(staleWarning); }
  catch (e) { setSync('err', 'error'); banner(e.message + ' — open Settings to check your details.'); }
})();
