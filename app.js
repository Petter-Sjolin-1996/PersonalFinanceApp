import * as C from './core.js';

/* ------------------------------------------------------------- state ----- */
/* Taxonomy, accounts and thresholds are DATA, not program logic.
   They live in config.json in the private repo and are edited in-app.
   The list below is only a fallback for a repo that has no config yet. */
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

let cfg = null, repo = null;
let CONF = null, shaC = null, confDirty = false;
let ledger = null, ann = null, shaL = null, shaA = null;
let dirty = false, tab = 'personal', filter = 'todo', sort = 'value', query = '';
let pendingImport = null;

const $ = id => document.getElementById(id);
const el = h => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstElementChild; };
const kr = n => Math.round(n).toLocaleString('sv-SE') + ' kr';
const cat = r => r && r.group ? r.group + ' / ' + r.label : '';
const groups = () => {
  const g = new Map();
  for (const c of CONF.categories) { if (!g.has(c.group)) g.set(c.group, []); g.get(c.group).push(c); }
  return g;
};
const defaultFixed = (g, l) => !!CONF.categories.find(c => c.group === g && c.label === l)?.fixed;
const ruleCount = (g, l) => Object.values(ann.merchantRules).filter(r => r.group === g && r.label === l).length;

/* ------------------------------------------------------------ derived ---- */
// Spending rows are everything personal: card + bank purchases, fees, and
// businesses paid by Swish. Corporate card is handled on its own tab.
const spendRows = () => ledger.transactions.filter(t =>
  ((t.role === 'spend' || t.role === 'fee') && t.account !== 'amex_corp') ||
  (t.role === 'p2p' && !(t.ref || '').startsWith('+46')));

const merchants = () => {
  const m = new Map();
  for (const t of spendRows()) {
    const key = t.role === 'p2p' ? t.ref : t.merchant;
    const e = m.get(key) || { merchant: key, n: 0, total: 0, accounts: new Set(),
                              first: t.date, last: t.date, tx: [], swish: t.role === 'p2p' };
    e.n++; e.total += t.amount; e.accounts.add(e.swish ? 'swish' : t.account);
    if (t.date < e.first) e.first = t.date;
    if (t.date > e.last) e.last = t.date;
    e.tx.push(t); m.set(key, e);
  }
  return [...m.values()].map(e => ({ ...e, accounts: [...e.accounts], total: Math.round(e.total * 100) / 100 }));
};

const workOf = m => m.tx.filter(t => ann.workExpenses[t.fp]);
const netOf  = m => m.tx.reduce((a, t) => a + (ann.workExpenses[t.fp] ? 0 : t.amount), 0);

/* -------------------------------------------------------------- sync ----- */
function setSync(state, text) { const s = $('sync'); s.className = 'sync ' + state; s.textContent = text; }

async function connect() {
  repo = new C.Repo(cfg);
  setSync('busy', 'loading');
  const L = await repo.read('ledger.json');
  const A = await repo.read('annotations.json');
  const K = await repo.read('config.json');
  CONF = K ? K.json : { version: 1, categories: FALLBACK_CATS, meta: {}, accounts: [] };
  shaC = K ? K.sha : null;
  if (!CONF.categories?.length) CONF.categories = FALLBACK_CATS;
  if (!L) throw new Error(`ledger.json not found in ${cfg.owner}/${cfg.repo}. Either the file is missing, or the token cannot see that repository — GitHub returns the same 404 for both. Check the repo name and that the token lists it under Repository access.`);
  ledger = L.json; shaL = L.sha;
  CONF.meta = { ...(ledger.meta || {}), ...(CONF.meta || {}) };
  if (!CONF.accounts?.length) CONF.accounts = ledger.accounts || [];
  ann = A ? A.json : { version: 1, merchantRules: {}, swishNames: {}, workExpenses: {}, corporatePrivate: {} };
  shaA = A ? A.sha : null;
  for (const k of ['merchantRules','swishNames','workExpenses','corporatePrivate']) ann[k] ||= {};
  dirty = false; setSync('on', 'synced');
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
    if (pendingImport === 'saved-ledger') pendingImport = null;
    dirty = false; setSync('on', 'synced'); toast('Saved to GitHub');
  } catch (e) { setSync('err', 'error'); banner(e.message); }
}

function markDirty() { dirty = true; if (repo) setSync('busy', 'unsaved'); }

/* ------------------------------------------------------------ banner ----- */
function banner(msg, kind = 'fatal') {
  $('banner').innerHTML = msg ? `<div class="wrap"><div class="${kind}">${msg}</div></div>` : '';
}

/* ------------------------------------------------------------ import ----- */
$('importBtn').onclick = () => { $('impOut').innerHTML = ''; $('impCommit').disabled = true; $('impModal').hidden = false; };
$('impClose').onclick = () => { $('impModal').hidden = true; pendingImport = null; };

$('impFiles').onchange = async e => {
  const out = $('impOut'); out.innerHTML = '<p class="msg">Reading…</p>';
  const rows = [], notes = [], fatals = [];
  for (const f of e.target.files) {
    try {
      const { text, encoding } = C.decode(await f.arrayBuffer());
      const p = C.parseFile(text);
      const breaks = C.checkChain(p.rows);
      notes.push({ name: f.name, n: p.rows.length, enc: encoding, src: p.source,
                   rejects: p.rejects.length, breaks: breaks.length });
      if (breaks.length) fatals.push(`${f.name}: running balance does not chain across ${breaks.length} row(s) — the export is missing transactions. Re-download the full month.`);
      rows.push(...p.rows);
    } catch (err) { fatals.push(`${f.name}: ${err.message}`); }
  }
  await C.fingerprint(rows);
  const meta = { dadSwish: ledger.meta.dadSwish, accountsByRef: Object.fromEntries(
    ledger.accounts.filter(a => a.match.ref).map(a => [a.match.ref, a.id])
      .concat(ledger.accounts.filter(a => a.match.konto).map(a => [`81059${a.match.konto}`, a.id]))) };
  rows.forEach(r => { r.role = C.assignRole(r, meta); r.pair = null;
                      r.review = (r.ref || '') === ledger.meta.dadSwish; });

  const { added, duplicates } = C.merge(ledger.transactions, rows);
  const known = new Set(merchants().map(m => m.merchant));
  const fresh = [...new Set(added.filter(t => t.role === 'spend' || t.role === 'fee')
                  .map(t => t.merchant).filter(m => !known.has(m)))];

  out.innerHTML = '<div class="diff">' + notes.map(n =>
    `<div class="diff-r ${n.breaks || n.rejects ? 'bad' : ''}"><span>${n.name} · ${n.src} · ${n.enc}</span>
     <b>${n.n} rows${n.rejects ? ` · ${n.rejects} unreadable` : ''}${n.breaks ? ` · ${n.breaks} chain breaks` : ''}</b></div>`).join('')
    + `<div class="diff-r"><span><b>New transactions</b></span><b>${added.length}</b></div>`
    + `<div class="diff-r"><span>Already in ledger (skipped)</span><b>${duplicates}</b></div>`
    + `<div class="diff-r"><span>Merchants you have not seen before</span><b>${fresh.length}</b></div></div>`
    + (fatals.length ? `<div class="fatal">${fatals.join('<br>')}</div>` : '');

  pendingImport = fatals.length ? null : added;
  $('impCommit').disabled = !added.length || !!fatals.length;
};

$('impCommit').onclick = async () => {
  if (!pendingImport) return;
  setSync('busy', 'committing');
  try {
    ledger.transactions.push(...pendingImport);
    ledger.transactions.sort((a, b) => a.date < b.date ? -1 : 1);
    C.runMatchers(ledger.transactions);          // always across the whole ledger, never just the new rows
    shaL = await repo.write('ledger.json', ledger, shaL, `Import ${pendingImport.length} transactions`);
    pendingImport = null; $('impModal').hidden = true;
    setSync('on', 'synced'); render(); renderCorp(); renderSwish();
    toast('Ledger updated');
  } catch (e) { setSync('err', 'error'); banner(e.message); }
};

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

/* ------------------------------------------------------------ gauge ------ */
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

/* --------------------------------------------------------- merchants ----- */
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

function card(m) {
  const r = ann.merchantRules[m.merchant] ||= { group: null, label: null, fixed: false, confirmed: false };
  const wq = workOf(m), net = netOf(m);
  const n = el(`<article class="m ${r.confirmed ? 'ok' : 'todo'}" data-m="${encodeURIComponent(m.merchant)}">
    <div class="m-head">
      <div class="m-id">
        <div class="m-name" title="${m.merchant}">${m.merchant}</div>
        <div class="m-meta"><span class="num">${m.n}&times;</span><span>${m.first} → ${m.last}</span>
          ${m.accounts.map(a => `<span class="tag${a === 'swish' ? ' sw' : ''}">${a.replace('swb_','').replace('amex_','amex ')}</span>`).join('')}
          ${m.tx.some(t => t.review) ? '<span class="tag rev">check</span>' : ''}
          ${wq.length ? `<span class="tag wk">${wq.length} work</span>` : ''}</div>
      </div>
      <div class="m-amt num ${net < 0 ? 'neg' : ''}">${kr(net)}${wq.length ? `<small>was ${kr(m.total)}</small>` : ''}</div>
      <div class="m-ctl">
        <select class="pick">${optionsFor(cat(r))}</select>
        <label class="toggle"><input type="checkbox" class="fix" ${r.fixed ? 'checked' : ''}> Fixed</label>
        <button class="ok-btn">${r.confirmed ? 'Confirmed' : 'Confirm'}</button>
        <button class="disc">${m.n > 1 ? `Show ${m.n} transactions` : 'Show transaction'}</button>
      </div>
    </div>
    <div class="tx">${m.tx.map(t => `<div class="tx-r${ann.workExpenses[t.fp] ? ' wk' : ''}" data-fp="${t.fp}">
      <span>${t.date} · ${(t.account || '').replace('swb_','').replace('amex_','amex ')}</span>
      <span class="num">${kr(t.amount)}</span>
      <label class="mini"><input type="checkbox" ${ann.workExpenses[t.fp] ? 'checked' : ''}> Work</label></div>`).join('')}</div>
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
    r.confirmed = !r.confirmed; markDirty(); render();
  };
  n.querySelector('.disc').onclick = () => n.classList.toggle('open');
  n.querySelectorAll('.tx-r input').forEach(cb => cb.onchange = ev => {
    const fp = ev.target.closest('.tx-r').dataset.fp;
    if (ev.target.checked) ann.workExpenses[fp] = true; else delete ann.workExpenses[fp];
    markDirty(); render();
    document.querySelector(`[data-m="${encodeURIComponent(m.merchant)}"]`)?.classList.add('open');
  });
  return n;
}

function render() {
  if (!ledger) return;
  const list = $('list');
  let ms = merchants().filter(m => {
    const r = ann.merchantRules[m.merchant];
    if (filter === 'todo' && r?.confirmed) return false;
    if (filter === 'ok' && !r?.confirmed) return false;
    if (filter === 'unknown' && r?.group !== 'Unknown') return false;
    if (query && !m.merchant.toLowerCase().includes(query)) return false;
    return true;
  });
  ms.sort((a, b) => sort === 'value' ? Math.abs(b.total) - Math.abs(a.total) : b.n - a.n);

  list.innerHTML = '';
  if (!ms.length) list.appendChild(el(`<div class="empty"><h3>Nothing here</h3><p>${
    filter === 'todo' ? 'Every merchant is confirmed.' : 'Try a different filter.'}</p></div>`));
  else ms.forEach(m => list.appendChild(card(m)));

  const pending = ms.filter(m => !ann.merchantRules[m.merchant]?.confirmed && ann.merchantRules[m.merchant]?.group);
  const b = $('bulk'); b.innerHTML = '';
  if (filter === 'todo' && pending.length > 1) {
    const n = el(`<div class="bulk"><span><b>${pending.length}</b> merchants have a category already.
      Confirm them all, then fix any that look wrong.</span><button class="btn pri">Confirm all ${pending.length}</button></div>`);
    n.querySelector('button').onclick = () => {
      pending.forEach(m => ann.merchantRules[m.merchant].confirmed = true);
      markDirty(); render(); toast(pending.length + ' confirmed');
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
  s.innerHTML = '<h2>Breakdown — confirmed only</h2>' + rows.map(([g, v]) =>
    `<div class="sum-r"><b>${g}</b><div class="sum-bar"><i style="width:${v / max * 100}%"></i></div>
     <em class="num">${kr(v)}</em></div>`).join('')
    + (wkTot ? `<div class="wknote"><b>${Object.keys(ann.workExpenses).length}</b> transactions marked work-related —
       <span class="num">${kr(wkTot)}</span> excluded from spending, expected back as reimbursement.</div>` : '');
}

/* --------------------------------------------------------- corporate ----- */
function renderCorp() {
  if (!ledger) return;
  const host = $('corpList'); host.innerHTML = '';
  const rows = ledger.transactions.filter(t => t.account === 'amex_corp' && (t.role === 'spend' || t.role === 'fee'))
    .sort((a, b) => a.date < b.date ? 1 : -1);
  let month = null, sub = 0, head = null;
  const flush = () => { if (head) head.querySelector('em').textContent = kr(sub); };
  for (const t of rows) {
    const mo = t.date.slice(0, 7);
    if (mo !== month) {
      flush(); month = mo; sub = 0;
      head = el(`<div class="mo"><span>${new Date(mo + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span><em class="num"></em></div>`);
      host.appendChild(head);
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
    host.appendChild(row);
  }
  flush();
  const n = Object.keys(ann.corporatePrivate).length;
  $('corpBadge').textContent = n; $('corpBadge').hidden = !n;
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
    <em>${Math.round(m.net / 100) / 10}k</em><span class="lab">${new Date(m.m + '-01').toLocaleDateString('en-GB', { month: 'short' })}</span></div>`).join('') + '</div>';

  const host = $('swPeople');
  host.innerHTML = '<div class="cp-h"><span>Person</span><span>Sent</span><span>Received</span><span>Net</span></div>';
  for (const c of ppl) {
    const r = el(`<div class="cp"><input placeholder="${c.ref}" value="${(ann.swishNames[c.ref] || '').replace(/"/g, '&quot;')}">
      <span class="v">${c.sent ? kr(c.sent) : '—'}</span><span class="v">${c.recv ? kr(c.recv) : '—'}</span>
      <span class="net ${c.net < 0 ? 'dn' : 'up'}">${kr(c.net)}</span></div>`);
    r.querySelector('input').onchange = e => {
      const v = e.target.value.trim();
      if (v) ann.swishNames[c.ref] = v; else delete ann.swishNames[c.ref];
      markDirty();
    };
    host.appendChild(r);
  }
}


/* ------------------------------------------------------- config editor --- */
/* Categories and settings are yours to change without a deploy. Renaming a
   label rewrites every merchant rule that points at it, so nothing is
   orphaned; deleting one is refused while rules still use it. */

const confBtn = el('<button class="btn" id="confBtn" hidden>Categories</button>');
document.querySelector('.acts').insertBefore(confBtn, document.getElementById('setBtn'));
confBtn.onclick = openConfig;

function openConfig() {
  if (!CONF || !ann) return toast('Connect first');
  document.getElementById('confModal')?.remove();
  const m = el(`<div class="modal" id="confModal"><div class="sheet wide">
    <h2>Categories &amp; settings</h2>
    <p class="lede">Stored in <b>config.json</b> in your private repo. Changes take effect immediately;
      press <b>Save</b> in the header to commit them.</p>
    <div id="confList"></div>
    <div class="addrow">
      <input id="newGroup" placeholder="New group name" autocapitalize="words">
      <button class="btn" id="addGroup">Add group</button>
    </div>
    <h3 class="sh">Settings</h3>
    <label>Opening receivable at ${CONF.meta.openingDate || 'start'} (kr)
      <input id="mOpen" inputmode="numeric" value="${CONF.meta.openingReceivable ?? ''}"></label>
    <label>Dad — Swish number (flagged for review on every import)
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
  const host = document.getElementById('confList');
  if (!host) return;
  host.innerHTML = '';
  for (const [g, list] of groups()) {
    const box = el(`<div class="cgrp"><div class="cgrp-h"><b>${g}</b>
      <span class="num">${list.length} labels</span></div><div class="cgrp-b"></div>
      <div class="addrow sub"><input placeholder="New label in ${g}"><button class="btn">Add</button></div></div>`);
    const body = box.querySelector('.cgrp-b');
    for (const c of list) {
      const used = ruleCount(c.group, c.label);
      const row = el(`<div class="crow">
        <input class="cname" value="${c.label.replace(/"/g, '&quot;')}">
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
    const addI = box.querySelector('.addrow.sub input'), addB = box.querySelector('.addrow.sub button');
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

/* -------------------------------------------------------------- wiring --- */
document.querySelectorAll('.tab').forEach(t => t.onclick = () => setTab(t.dataset.t));
function setTab(t) {
  tab = t;
  document.querySelectorAll('.tab').forEach(x => x.setAttribute('aria-pressed', x.dataset.t === t));
  $('panelPersonal').hidden = t !== 'personal';
  $('panelCorp').hidden = t !== 'corp';
  $('panelSwish').hidden = t !== 'swish';
  $('toolsPersonal').style.display = t === 'personal' ? '' : 'none';
  if (t === 'corp') renderCorp();
  if (t === 'swish') renderSwish();
}
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
  document.getElementById('confBtn').hidden = false;
  const span = ledger.transactions.length
    ? ` ${ledger.transactions[0].date.slice(0, 7)} → ${ledger.transactions.at(-1).date.slice(0, 7)}`
    : '';
  $('win').textContent = span;
  render(); renderCorp(); setTab('personal');
}

(async function init() {
  try { cfg = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { cfg = null; }
  if (!cfg) {
    banner('Not connected yet. Open <b>Settings</b> and enter your GitHub username, the data repository name, and your access token.', 'fatal');
    setSync('err', 'not set up');
    return;
  }
  try { await connect(); boot(); }
  catch (e) { setSync('err', 'error'); banner(e.message + ' — open Settings to check your details.'); }
})();
