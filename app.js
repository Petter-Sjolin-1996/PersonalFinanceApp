import * as C from './core.js';

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
const SECTIONS = {
  control:      [['overview','Overview'], ['targets','Targets']],
  transactions: [['import','Upload transactions'], ['coverage','Data coverage']],
  categorise:   [['expenses','Expense categorisation'], ['corp','Corporate allocation'], ['swish','Swish counterparties']],
};

let cfg = null, repo = null;
let CONF = null, shaC = null, confDirty = false;
let ledger = null, ann = null, shaL = null, shaA = null;
let dirty = false, section = 'control', pane = 'overview';
let filter = 'todo', sort = 'value', query = '', adjust = false;
let pendingImport = null;

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

const trackedAccounts = () => (CONF.accounts || []).filter(a => a.tracked).map(a => a.id);
const complete = () => C.completeMonths(ledger.coverage, ledger.transactions, trackedAccounts());

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
const isSpendRow = t =>
  ((t.role === 'spend' || t.role === 'fee') && t.account !== 'amex_corp') ||
  (t.role === 'p2p' && !(t.ref || '').startsWith('+46'));

/** Money in and money out, per month.

    Income is salary only — reimbursements repay work expenses you fronted, so
    counting them would double up against the corporate card, which is already
    excluded on the spending side.

    Expenditure is money that leaves and does not come back: personal spending,
    the recurring obligations you owe, and the net of Swish with people.
    Excluded by design — transfers between your own accounts, Avanza (that is
    saving, not spending), Amex invoice payments (the charges themselves are
    already counted), and any account listed in meta.excludeFromCashflow. */
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
    if (t.role === 'income') out[m].income += t.amount;
    else if (isSpendRow(t)) { if (!ann.workExpenses[t.fp]) out[m].spend += Math.abs(t.amount); }
    else if (t.role === 'transfer_obligation') out[m].spend += Math.abs(t.amount);
    else if (t.role === 'p2p') out[m].spend -= t.amount;      // net: sent adds, received subtracts
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
const swishRefs = () => [...new Set(ledger.transactions
  .filter(t => t.role === 'p2p' && (t.ref || '').startsWith('+46')).map(t => t.ref))];
const swishUnnamed = () => swishRefs().filter(r => !ann.swishNames[r]).length;

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
  for (const k of ['merchantRules','swishNames','workExpenses','corporatePrivate','oneOffs']) ann[k] ||= {};
  dirty = false; confDirty = false; setSync('on', 'synced');
}

async function save() {
  if (!repo) return toast('Not connected');
  setSync('busy', 'saving');
  try {
    ann.updated = new Date().toISOString();
    shaA = await repo.write('annotations.json', ann, shaA, 'Update annotations');
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
    const badge = id === 'expenses' ? unconfirmed() : id === 'corp' ? corpUnreviewed() : id === 'swish' ? swishUnnamed() : 0;
    const b = el(`<button data-p="${id}" aria-pressed="${id === pane}">${label}
      <em ${badge ? '' : 'hidden'}>${badge}</em></button>`);
    b.onclick = () => go(sec, id);
    sn.appendChild(b);
  }
  $('subnav').hidden = panes.length < 2;

  const show = {
    overview: 'viewControl', targets: 'viewTargets', import: 'viewImport', coverage: 'viewCoverage',
    expenses: 'viewExpenses', corp: 'viewCorp', swish: 'viewSwish',
  };
  for (const v of Object.values(show)) $(v).hidden = true;
  $(show[pane]).hidden = false;
  $('toolsPersonal').hidden = pane !== 'expenses';
  $('gaugeWrap').hidden = pane !== 'expenses';

  const n = unconfirmed() + corpUnreviewed() + swishUnnamed();
  $('navBadge').textContent = n; $('navBadge').hidden = !n;

  ({ overview: drawControl, targets: drawTargets, import: drawImport, coverage: drawCoverage,
     expenses: render, corp: renderCorp, swish: renderSwish })[pane]();
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

  const rows = spendIn(months);
  const byGroup = {};
  for (const t of rows) {
    const m = t.date.slice(0, 7);
    (byGroup[groupOf(t)] ||= {})[m] = (byGroup[groupOf(t)][m] || 0) + Math.abs(t.amount);
  }
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
          <div class="fbw"><span class="fnum">${krN(c.spend)}</span>
            <div class="fb out" style="height:${c.spend / scale * 100}%"></div></div>
        </div>
        <span class="tlab">${monthName(m).slice(0, 3)}</span></div>`;
    }).join('')}</div>
    <p class="note">Everything rounded to the nearest 100 kr. Income counts salary only.
      Expenditure counts personal spending, recurring obligations and net Swish with people —
      it excludes transfers between your own accounts, Avanza, Amex invoice payments and lump repayments to your dad.</p>

    <h3 class="sh">Monthly targets — ${monthName(last)}</h3>
    <div class="tgt"><div class="tgt-h"><span>Group</span><span>Actual</span><span>Target</span><span>Progress</span></div>
      ${Object.keys(T.monthly).sort().map(g => {
        const a = byGroup[g]?.[last] || 0, t = T.monthly[g], pct = t ? Math.min(a / t * 100, 100) : 0;
        return `<div class="tgt-r"><b>${g}</b>
          <span class="v ${a > t ? 'over' : 'under'}">${kr(a)}</span><span class="v">${kr(t)}</span>
          <div class="bar"><i class="${a > t ? 'over' : ''}" style="width:${pct}%"></i></div></div>`;
      }).join('')}</div>

    <h3 class="sh">Annual budgets — used so far this year</h3>
    <div class="tgt"><div class="tgt-h"><span>Group</span><span>Used</span><span>Budget</span><span>Pace</span></div>
      ${Object.keys(T.annual).sort().map(g => {
        const used = Object.values(byGroup[g] || {}).reduce((a, b) => a + b, 0);
        const b = T.annual[g], pct = b ? Math.min(used / b * 100, 100) : 0;
        const pace = all.length / 12 * 100;
        return `<div class="tgt-r"><b>${g}</b>
          <span class="v ${used > b * all.length / 12 ? 'over' : 'under'}">${kr(used)}</span>
          <span class="v">${kr(b)}</span>
          <div class="bar"><i class="${used > b ? 'over' : ''}" style="width:${pct}%"></i><u style="left:${pace}%"></u></div></div>`;
      }).join('')}</div>
    <p class="note">The vertical marker shows where you would be if spending were even across the year
      — ${all.length} of 12 months elapsed.</p>`;

  $('adj').onchange = e => { adjust = e.target.checked; drawControl(); };
}

function drawTargets() {
  const host = $('viewTargets');
  const T = CONF.targets;
  const all = [...new Set(CONF.categories.map(c => c.group))].sort();
  host.innerHTML = `<p class="lede">Steady groups get a monthly target. Lumpy ones — where a single trip or
    a semi-annual bill dominates — get an annual budget instead, because a monthly figure for them would be
    breached or trivially met almost every month. Move a group between the two by clearing one field and filling the other.</p>
    <div class="tgt"><div class="tgt-h"><span>Group</span><span>Monthly</span><span>Annual</span><span></span></div>
    ${all.map(g => `<div class="tgt-r" data-g="${g}"><b>${g}</b>
      <span class="tgtin"><input data-k="monthly" inputmode="numeric" value="${T.monthly[g] ?? ''}"></span>
      <span class="tgtin"><input data-k="annual" inputmode="numeric" value="${T.annual[g] ?? ''}"></span>
      <span class="v">${T.monthly[g] ? kr(T.monthly[g] * 12) + ' / yr' : T.annual[g] ? kr(T.annual[g] / 12) + ' / mo' : '—'}</span>
    </div>`).join('')}</div>`;
  host.querySelectorAll('.tgt-r').forEach(r => r.querySelectorAll('input').forEach(i => i.onchange = e => {
    const g = r.dataset.g, k = i.dataset.k, v = parseFloat(e.target.value.replace(/\s/g, ''));
    if (isFinite(v) && v > 0) { T[k][g] = Math.round(v); T[k === 'monthly' ? 'annual' : 'monthly'] && delete T[k === 'monthly' ? 'annual' : 'monthly'][g]; }
    else delete T[k][g];
    confDirty = true; markDirty(); drawTargets();
  }));
}

/* ========================================================== COVERAGE ===== */
function drawCoverage() {
  const acc = C.coverageByAccount(ledger.coverage, ledger.transactions);
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
    <p class="note">Swedbank exports declare their own period in the file header, so their coverage is exact —
      including days with no transactions. Amex exports carry no period and no running balance, so coverage is
      inferred from the first and last row, and a gap in the middle would not be visible.</p>`;
}

/* ============================================================ IMPORT ===== */
function drawImport() {
  const acc = C.coverageByAccount(ledger.coverage, ledger.transactions);
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

  const pending = ms.filter(m => !ann.merchantRules[m.merchant]?.confirmed && ann.merchantRules[m.merchant]?.group);
  const b = $('bulk'); b.innerHTML = '';
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
  const rows = ledger.transactions.filter(t => t.role === 'p2p' && (t.ref || '').startsWith('+46'));
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

function refreshBadges() {
  const n = unconfirmed() + corpUnreviewed() + swishUnnamed();
  $('navBadge').textContent = n; $('navBadge').hidden = !n;
  document.querySelectorAll('#subnavIn button').forEach(b => {
    const id = b.dataset.p;
    const v = id === 'expenses' ? unconfirmed() : id === 'corp' ? corpUnreviewed() : id === 'swish' ? swishUnnamed() : 0;
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
    <p class="lede">Stored in <b>config.json</b> in your private repo. Renaming a label rewrites every merchant
      rule that points at it. Deleting one is refused while rules still use it.</p>
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
    $('setModal').hidden = true; banner(''); boot();
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
  $('confBtn').hidden = false;
  go(unconfirmed() ? 'categorise' : 'control');
}

(async function init() {
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { cfg = null; }
  if (!cfg) {
    banner('Not connected yet. Open <b>Settings</b> and enter your GitHub username, the data repository name, and your access token.');
    setSync('err', 'not set up');
    return;
  }
  try { await connect(); boot(); }
  catch (e) { setSync('err', 'error'); banner(e.message + ' — open Settings to check your details.'); }
})();
