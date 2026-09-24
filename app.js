(function(){
const $=id=>document.getElementById(id);
const TODAY=new Date(); TODAY.setHours(0,0,0,0);

/* ---------- company data ----------
   [ticker, name, country, price, day change] */
const OMX=[
 ["ABB","ABB Ltd","SE",572.4,0.004],["ALFA","Alfa Laval","SE",452.1,-0.006],["ASSA B","Assa Abloy B","SE",336.8,0.009],["AZN","AstraZeneca","SE",1498.0,-0.003],
 ["ATCO A","Atlas Copco A","SE",171.2,0.005],["ATCO B","Atlas Copco B","SE",151.9,0.004],["BOL","Boliden","SE",388.5,-0.012],["EPI A","Epiroc A","SE",212.3,0.007],
 ["EQT","EQT","SE",297.9,-0.0106],["ERIC B","Ericsson B","SE",82.4,0.002],["ESSITY B","Essity B","SE",268.9,-0.004],["EVO","Evolution","SE",812.0,0.011],
 ["GETI B","Getinge B","SE",214.7,-0.008],["HM B","H&M B","SE",166.2,-0.0107],["SHB A","Handelsbanken A","SE",121.8,0.003],["HEXA B","Hexagon B","SE",118.4,0.006],
 ["INVE B","Investor B","SE",312.5,0.002],["NIBE B","Nibe Industrier B","SE",46.2,-0.015],["NDA SE","Nordea","SE",200.5,-0.0055],["SAAB B","Saab B","SE",489.0,-0.002],
 ["SAND","Sandvik","SE",242.6,0.008],["SCA B","SCA B","SE",141.3,-0.001],["SEB A","SEB A","SE",162.5,0.015],["SKA B","Skanska B","SE",234.1,0.004],
 ["SKF B","SKF B","SE",221.7,-0.003],["SWED A","Swedbank A","SE",268.2,0.006],["TEL2 B","Tele2 B","SE",158.4,0.001],["TELIA","Telia Company","SE",36.8,-0.002],
 ["VOLV B","Volvo B","SE",268.4,-0.006],["SINCH","Sinch","SE",29.6,0.021]
];
/* Real key figures and history from Avanza, 23 Sep 2026.
   kpi: [market cap MSEK, dividend yield, volatility, beta, P/E, P/S, P/B, ROE]
   hist: [1 day, 1 week, 1 month, 3 months, 6 months, YTD, 1 year, 3 years, 5 years] */
const REAL={
 "EQT":{kpi:[389344,.0168,.1855,1.74,30.73,10.88,4.07,.1324],hist:[-.0106,-.0155,-.1155,.1103,.1042,-.1811,-.1176,.3703,-.2111]},
 "HM B":{kpi:[265733,.0427,.2440,0.94,21.73,1.20,7.82,.36],hist:[-.0107,.0079,-.0898,-.0036,-.0157,-.1060,.0902,.0550,-.0751]},
 "NDA SE":{kpi:[682261,.0446,.1301,0.68,13.20,5.28,1.97,.1494],hist:[-.0055,.0075,.0489,.0853,.2107,.1526,.3213,.6280,.8405]}
};
const REPORTS=["2026-10-16","2026-10-21","2026-10-22","2026-10-23","2026-10-24","2026-10-28","2026-10-29"];
/* Hexatronic: price from transfer sheet; LTM figures from reports (Q3 2025–Q2 2026) */
const HX={price:41.00,shares:221.43,ltmSales:7674,ltmEps:0.20,ytdStart:23.04};
const MODELS={HTRO:{name:"Hexatronic Group",country:"SE",price:HX.price,day:0.012,value:31.29,report:"2026-10-22",
  model:"Updated after Q2 2026",wacc:"10.0%",terminal:"7.5x EV/EBITDA",vdate:"30 Jun 2026",
  sales:[7581,7519,8054,8755,9388,10017,10468,10874,11299,11745],
  kpi:[HX.price*HX.shares,null,null,null,HX.price/HX.ltmEps,HX.price*HX.shares/HX.ltmSales,null,null]}};

function hash(s){let h=2166136261;for(const c of s){h^=c.charCodeAt(0);h=Math.imul(h,16777619)}return Math.abs(h)}
function rng(seed){let s=seed%2147483647||1;return()=>(s=s*16807%2147483647)/2147483647}
function placeholderKpi(t,price){const r=rng(hash(t)+7);
  return [Math.round(30000+r()*600000),Math.round(r()*55)/1000,.12+r()*.2,+(0.6+r()*1.1).toFixed(2),+(10+r()*25).toFixed(2),+(0.8+r()*6).toFixed(2),+(1.2+r()*6).toFixed(2),.05+r()*.3]}
function placeholderHist(t,day){const r=rng(hash(t)+11),g=s=>(r()-0.45)*s;
  return [day,g(.06),g(.12),g(.2),g(.3),g(.35),g(.45),g(.9),g(1.2)]}
function demoInfo(t){
  if(MODELS[t]){const m=MODELS[t],h=[m.day,null,null,null,null,m.price/HX.ytdStart-1,null,null,null];
    return Object.assign({ticker:t,hist:h},m)}
  const o=OMX.find(x=>x[0]===t); if(!o) return null;
  const real=REAL[t];
  return {ticker:t,name:o[1],country:o[2],price:o[3],day:o[4],value:null,model:null,report:REPORTS[hash(t)%REPORTS.length],
    kpi:real?real.kpi:placeholderKpi(t,o[3]),hist:real?real.hist:placeholderHist(t,o[4])};
}
const UNIVERSE=[["HTRO","Hexatronic Group"],...OMX.map(o=>[o[0],o[1]])];

/* ---------- live market data: written nightly by the workflow in the private data repo ---------- */
const GH_KEY="mm-github", MKT_KEY="mm-market";
let gh={owner:"Petter-Sjolin-1996",repo:"Stock-watchlist-data",token:""};
try{Object.assign(gh,JSON.parse(localStorage.getItem(GH_KEY)||"{}"))}catch(e){}
let MARKET=null;
try{MARKET=JSON.parse(localStorage.getItem(MKT_KEY)||"null")}catch(e){}
if(!gh.token) MARKET=null;
let marketError="";
const KPI_KEYS=["mcap","dy","vol","beta","pe","ps","pb","roe"], HIST_KEYS=["1d","1w","1m","3m","6m","ytd","1y","3y","5y"];
function info(t){
  const s=demoInfo(t); if(!s) return null;
  if(!MARKET) return s;
  const m=MARKET.stocks&&MARKET.stocks[t];
  Object.assign(s,{price:null,day:null,kpi:KPI_KEYS.map(()=>null),hist:HIST_KEYS.map(()=>null),report:s.value!=null?s.report:null});
  if(!m) return s;
  s.price=m.price??null; s.day=m.day??null;
  s.kpi=KPI_KEYS.map(k=>m.kpi&&m.kpi[k]!=null?m.kpi[k]:null);
  s.hist=HIST_KEYS.map(k=>m.hist&&m.hist[k]!=null?m.hist[k]:null);
  if(m.nextReport) s.report=m.nextReport;
  return s;
}
async function loadMarket(showToast){
  if(!gh.token){MARKET=null;marketError="";renderAll();return false}
  try{
    const r=await fetch(`https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/market.json`,
      {headers:{Authorization:`Bearer ${gh.token}`,Accept:"application/vnd.github.raw+json","X-GitHub-Api-Version":"2022-11-28"},cache:"no-store"});
    if(!r.ok) throw new Error(r.status===401?"GitHub did not accept the token. Check it in Settings.":
      r.status===404?"No market data yet. Run the 'Update market data' workflow in the data repo.":`GitHub returned error ${r.status}.`);
    const d=await r.json();
    if(!d||!d.stocks) throw new Error("market.json has an unexpected format.");
    MARKET=d; marketError="";
    try{localStorage.setItem(MKT_KEY,JSON.stringify(d))}catch(e){}
    renderAll(); if(showToast) toast(`Prices loaded (close ${fmtDate(d.asOf)})`);
    return true;
  }catch(e){
    marketError=e.message||"Could not load market data."; renderAll(); if(showToast) toast(marketError); return false;
  }
}
function renderStatus(){
  const el=$("data-status"); if(!el) return;
  if(MARKET) el.innerHTML=`Prices and key figures: end of day ${esc(fmtDate(MARKET.asOf))}, from Yahoo Finance (updated every weekday evening).${marketError?` <b class="neg">${esc(marketError)}</b>`:""}`;
  else el.innerHTML=marketError?`<b class="neg">${esc(marketError)}</b> Showing demo data.`:"Showing demo data. Connect GitHub under Settings to load real prices.";
}

/* ---------- flags (round, like Avanza) ---------- */
const FLAGS={
 SE:'<rect width="20" height="20" fill="#006AA7"/><rect x="5.5" width="3" height="20" fill="#FECC00"/><rect y="8.5" width="20" height="3" fill="#FECC00"/>',
 FI:'<rect width="20" height="20" fill="#fff"/><rect x="5.5" width="3.4" height="20" fill="#002F6C"/><rect y="8.3" width="20" height="3.4" fill="#002F6C"/>',
 NO:'<rect width="20" height="20" fill="#BA0C2F"/><rect x="4.5" width="5" height="20" fill="#fff"/><rect y="7.5" width="20" height="5" fill="#fff"/><rect x="5.75" width="2.5" height="20" fill="#00205B"/><rect y="8.75" width="20" height="2.5" fill="#00205B"/>',
 DK:'<rect width="20" height="20" fill="#C8102E"/><rect x="5.5" width="3" height="20" fill="#fff"/><rect y="8.5" width="20" height="3" fill="#fff"/>',
 US:'<rect width="20" height="20" fill="#fff"/><g fill="#B22234"><rect width="20" height="1.54"/><rect y="3.08" width="20" height="1.54"/><rect y="6.16" width="20" height="1.54"/><rect y="9.24" width="20" height="1.54"/><rect y="12.32" width="20" height="1.54"/><rect y="15.4" width="20" height="1.54"/><rect y="18.46" width="20" height="1.54"/></g><rect width="9" height="10.8" fill="#3C3B6E"/>'
};
const flag=cc=>`<span class="flag" role="img" aria-label="${cc}"><svg viewBox="0 0 20 20" preserveAspectRatio="none">${FLAGS[cc]||'<rect width="20" height="20" fill="#ccc"/>'}</svg></span>`;

/* ---------- state ---------- */
const KEY="wl-state-v2";
let state=null;
try{state=JSON.parse(localStorage.getItem(KEY)||"null")}catch(e){}
if(!state||!Array.isArray(state.lists)||!state.lists.length){
  state={active:"l1",lists:[{id:"l1",name:"My watchlist",tickers:["HTRO","VOLV B","ATCO A","SEB A"]}]};
}
function save(){try{localStorage.setItem(KEY,JSON.stringify(state))}catch(e){}}
function active(){return state.lists.find(l=>l.id===state.active)||state.lists[0]}
let unit="pct", tab="price", sort={key:null,dir:1};

/* ---------- formatting ---------- */
const fmt=(n,d=2)=>n.toLocaleString("en-GB",{minimumFractionDigits:d,maximumFractionDigits:d});
const pct=(x,d=1)=>{const v=+(x*100).toFixed(d);return (v>0?"+":"")+(v===0?0:v).toFixed(d)+"%"};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const dateOf=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const fmtDate=s=>dateOf(s).toLocaleDateString("en-GB",{day:"numeric",month:"short",year:"numeric"});
const daysTo=s=>Math.round((dateOf(s)-TODAY)/864e5);
const dash='<span class="dim">–</span>';
const signed=v=>v==null?dash:`<span class="${v>=0?'pos':'neg'}">${pct(v,2)}</span>`;

/* ---------- table columns per tab ---------- */
const nameCol={key:"name",label:"Company",sticky:true,val:s=>s.name.toLowerCase(),
  cell:s=>`<div class="name">${flag(s.country)}<div><a href="#" data-open="${esc(s.ticker)}">${esc(s.name)}</a><small>${esc(s.ticker)}</small></div></div>`};
const toolsCol={key:"tools",label:'<span class="vh">Remove</span>',cls:"col-tools",nosort:true,
  cell:s=>`<button class="icon-btn" data-remove="${esc(s.ticker)}" aria-label="Remove ${esc(s.name)} from list"><svg><use href="#i-trash"/></svg></button>`};
const up=s=>s.value!=null&&s.price?s.value/s.price-1:null;
const COLS={
 price:[nameCol,
  {key:"day",label:"Day change",val:s=>s.day==null||s.price==null?-Infinity:unit==="pct"?s.day:s.price-s.price/(1+s.day),
   cell:s=>{if(s.day==null||s.price==null)return dash;const a=s.price-s.price/(1+s.day);return `<span class="${s.day>=0?'pos':'neg'}">${unit==="pct"?pct(s.day,2):(a>0?"+":"")+fmt(a)}</span>`}},
  {key:"price",label:"Last price",val:s=>s.price??-Infinity,cell:s=>s.price==null?dash:fmt(s.price)},
  {key:"value",label:"Your value",cls:"col-val",val:s=>s.value??-Infinity,cell:s=>s.value!=null?fmt(s.value):dash},
  {key:"upside",label:"Upside",val:s=>up(s)??-Infinity,cell:s=>{const u=up(s);if(u==null)return dash;
    const w=Math.min(Math.abs(u),.5)/.5*50;
    return `<span class="up-cell"><b class="${u>=0?'pos':'neg'}" style="font-weight:600">${pct(u)}</b><span class="gap-bar" aria-hidden="true"><span style="${u>=0?`left:50%;width:${w}%`:`right:50%;width:${w}%`};background:${u>=0?'var(--up)':'var(--down)'}"></span></span></span>`}},
  {key:"report",label:"Next report",cls:"col-report",val:s=>s.report||"9999",asc:true,
   cell:s=>{if(!s.report)return dash;const d=daysTo(s.report);if(d<0)return `<span class="dim">${fmtDate(s.report)}</span>`;return `<span class="${d<=30?'soon':''}">${fmtDate(s.report)}</span><br><small class="dim">in ${d} days</small>`}},
  {key:"model",label:"Model",cls:"col-model",left:true,nosort:true,cell:s=>`<span class="status ${s.value!=null?'ok':'none'}">${s.model||'No model yet'}</span>`},
  toolsCol],
 kpi:[nameCol,
  ...[["mcap","Market cap",v=>fmt(v,0)+" MSEK",false],["dy","Dividend yield",v=>fmt(v*100)+"%",true],["vol","Volatility",v=>fmt(v*100)+"%",true],
      ["beta","Beta",v=>fmt(v),true],["pe","P/E",v=>fmt(v),true],["ps","P/S",v=>fmt(v),true],["pb","P/B",v=>fmt(v),true],["roe","ROE",v=>fmt(v*100)+"%",true]]
   .map(([key,label,f,avg],i)=>({key,label,avg,val:s=>s.kpi[i]??-Infinity,raw:s=>s.kpi[i],fmt:f,cell:s=>s.kpi[i]==null?dash:f(s.kpi[i])})),
  toolsCol],
 hist:[nameCol,
  ...["1 day","1 week","1 month","3 months","6 months","YTD","1 year","3 years","5 years"]
   .map((label,i)=>({key:"h"+i,label,avg:true,val:s=>s.hist[i]??-Infinity,raw:s=>s.hist[i],fmt:v=>pct(v,2),signed:true,cell:s=>signed(s.hist[i])})),
  toolsCol]
};

function renderTable(){
  const a=active(), cols=COLS[tab]; let cos=a.tickers.map(info).filter(Boolean);
  const col=cols.find(c=>c.key===sort.key);
  if(col) cos=[...cos].sort((p,q)=>{const x=col.val(p),y=col.val(q);return (x>y?1:x<y?-1:0)*sort.dir});
  const cls=c=>[c.cls||"",c.sticky?"sticky":""].join(" ").trim();
  $("thead").innerHTML="<tr>"+cols.map(c=>{
    const on=c.key===sort.key, ic=on?(sort.dir>0?"#i-asc":"#i-desc"):"#i-sort";
    const inner=c.nosort?c.label:`<button class="sort" data-sort="${c.key}" ${on?`aria-sort="${sort.dir>0?'ascending':'descending'}"`:''}>${c.label}<svg><use href="${ic}"/></svg></button>`;
    return `<th class="${cls(c)}" ${c.left?'style="text-align:left"':''}>${inner}</th>`}).join("")+"</tr>";
  if(!cos.length){$("rows").innerHTML=`<tr style="cursor:default"><td colspan="${cols.length}" class="empty-list">This list is empty. Use the search above or Add company below.</td></tr>`;$("tfoot").innerHTML="";return}
  $("rows").innerHTML=cos.map(s=>`<tr data-open="${esc(s.ticker)}">${cols.map(c=>`<td class="${cls(c)}" ${c.left?'style="text-align:left"':''}>${c.cell(s)}</td>`).join("")}</tr>`).join("");
  if(tab==="price"){$("tfoot").innerHTML="";return}
  $("tfoot").innerHTML="<tr>"+cols.map((c,i)=>{
    if(i===0) return `<td class="sticky">Average, all companies</td>`;
    if(!c.avg) return `<td class="${cls(c)}"></td>`;
    const v=cos.map(c.raw).filter(x=>x!=null); if(!v.length) return `<td>${dash}</td>`;
    const m=v.reduce((p,q)=>p+q,0)/v.length;
    return `<td class="${cls(c)}">${c.signed?signed(m):c.fmt(m)}</td>`}).join("")+"</tr>";
}
function setTab(t){tab=t;sort={key:null,dir:1};
  document.querySelectorAll("[data-tab]").forEach(b=>b.setAttribute("aria-selected",b.dataset.tab===t));
  $("unit-wrap").hidden=t!=="price"; renderTable()}

/* ---------- banner bar ---------- */
function renderBanner(){
  const a=active();
  $("list-name").textContent=a.name;
  $("list-menu").innerHTML=state.lists.map(l=>`<button role="menuitem" data-pick="${l.id}"><span class="${l.id===a.id?'sel':''}">${esc(l.name)}</span><span class="cnt">${l.tickers.length} ${l.tickers.length===1?'company':'companies'}</span></button>`).join("");
}
function toggleMenu(open){const m=$("list-menu");const o=open??!m.classList.contains("open");m.classList.toggle("open",o);$("list-btn").setAttribute("aria-expanded",o)}
function resRow(t,n){
  const s=info(t), inList=active().tickers.includes(t);
  return `<div class="res"><div style="display:flex;gap:10px;align-items:center">${flag(s.country)}<div><b style="font-weight:500">${esc(n)}</b><small>${esc(t)}${s.value!=null?' / your model':''}</small></div></div>
    <span>${s.price!=null?fmt(s.price):"–"}</span>${inList?'<span class="in">In list</span>':`<button class="add-sm" data-add="${esc(t)}">Add</button>`}</div>`;
}
function renderResults(){
  const q=$("search").value.trim(), r=$("results");
  if(!q){r.classList.remove("open");return}
  const hits=UNIVERSE.filter(([t,n])=>(n+" "+t).toLowerCase().includes(q.toLowerCase())).slice(0,12);
  r.innerHTML=hits.length?hits.map(h=>resRow(...h)).join(""):`<div class="res"><span class="dim">No company matches "${esc(q)}". This version covers OMX Stockholm 30 and your models.</span></div>`;
  r.classList.add("open");
}
function renderAddList(){
  const q=$("add-search").value.trim().toLowerCase();
  $("add-list").innerHTML=UNIVERSE.filter(([t,n])=>!q||(n+" "+t).toLowerCase().includes(q)).map(h=>resRow(...h)).join("");
}

/* ---------- dialogs ---------- */
function openDlg(id){closeAll();$(id).classList.add("open");$("scrim").classList.add("open")}
function closeAll(){["dlg-new","dlg-manage","dlg-add","dlg-settings","drawer","scrim"].forEach(i=>$(i).classList.remove("open"));toggleMenu(false)}
function manageView(step){
  const a=active(), n=a.tickers.length, b=$("manage-body");
  if(step===1){
    b.innerHTML=`<div class="warn">Delete <b>${esc(a.name)}</b>? It contains ${n} ${n===1?'company':'companies'}.</div>
      <div class="actions"><button class="pill" data-m="0">Cancel</button><button class="pill danger" data-m="2">Delete list</button></div>`;
  } else if(step===2){
    b.innerHTML=`<div class="warn"><b>This cannot be undone.</b> The list will be removed. Your company models are not affected.</div>
      <div class="actions"><button class="pill" data-m="0">Keep list</button><button class="pill danger-solid" id="del-final">Yes, delete permanently</button></div>`;
  } else {
    b.innerHTML=`<label for="ren">List name</label><input class="field" id="ren" maxlength="40" value="${esc(a.name)}">
      <div class="err" id="ren-err"></div>
      <div class="actions"><button class="pill" data-close>Cancel</button><button class="pill primary" id="ren-ok">Save name</button></div>
      <hr class="divider"><p style="margin:0 0 6px;font-weight:500">Delete list</p>
      <p class="dim" style="margin:0 0 12px;font-size:14px">Removes the list and the companies in it.</p>
      <button class="pill danger" data-m="1"><svg><use href="#i-trash"/></svg>Delete list</button>`;
  }
}
function nameError(name,exceptId){
  if(!name) return "Give the list a name.";
  if(state.lists.some(l=>l.id!==exceptId&&l.name.toLowerCase()===name.toLowerCase())) return "You already have a list with that name.";
  return "";
}

/* ---------- drawer ---------- */
function openDrawer(t){
  const s=info(t); if(!s) return;
  $("d-title").textContent=s.name;
  let h=`<div class="big"><div><small>Last price</small><b>${s.price!=null?fmt(s.price):"–"}</b></div>`;
  if(s.value!=null){const u=up(s);
    h+=`<div><small>Your value</small><b>${fmt(s.value)}</b></div><div><small>Upside</small><b class="${u>=0?'pos':'neg'}">${pct(u)}</b></div></div>
    <dl class="kv"><dt>Model</dt><dd>${s.model}</dd><dt>Valuation date</dt><dd>${s.vdate}</dd><dt>WACC</dt><dd>${s.wacc}</dd><dt>Terminal value</dt><dd>${s.terminal}</dd><dt>Next report</dt><dd>${s.report?fmtDate(s.report):"–"}</dd></dl>
    <p class="minititle">Net sales, MSEK: actual and your forecast</p>${bars(s.sales)}
    <p class="note">The full company page, with actual vs your forecast per business area and drill-downs, is the next step.</p>`;
  } else {
    h+=`</div><dl class="kv"><dt>Day change</dt><dd class="${s.day>=0?'pos':'neg'}">${s.day!=null?pct(s.day,2):"–"}</dd><dt>Next report</dt><dd>${s.report?fmtDate(s.report):"–"}</dd></dl>
    <div class="emptybox"><b style="color:var(--ink)">No model yet</b><br>Upload a transfer sheet for ${esc(s.name)} to see your value, your forecast and how actual results compare.<br><br><button class="pill primary" data-soon>Upload transfer sheet</button></div>`;
  }
  $("d-body").innerHTML=h; $("drawer").classList.add("open"); $("scrim").classList.add("open");
}
function bars(v){
  const W=400,H=150,bw=W/v.length,mx=Math.max(...v);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Net sales actual and forecast">${v.map((x,i)=>{const h=x/mx*(H-28),a=i<2;
    return `<rect x="${i*bw+6}" y="${H-18-h}" width="${bw-12}" height="${h}" rx="3" fill="${a?'var(--ink)':'var(--blue)'}" opacity="${a?1:.5}"/><text x="${i*bw+bw/2}" y="${H-4}" font-size="11" text-anchor="middle" fill="var(--muted)">${24+i}${a?'A':'E'}</text>`}).join("")}</svg>`;
}

/* ---------- toast ---------- */
let undo=null, tt=null;
function toast(msg,undoFn){$("toast-msg").textContent=msg;undo=undoFn||null;$("toast-undo").hidden=!undoFn;$("toast").classList.add("show");clearTimeout(tt);tt=setTimeout(()=>$("toast").classList.remove("show"),5000)}
$("toast-undo").onclick=()=>{if(undo)undo();undo=null;$("toast").classList.remove("show")};

/* ---------- actions ---------- */
function addTicker(t){const a=active();if(!a.tickers.includes(t)){a.tickers.push(t);save();renderAll();toast(`${info(t).name} added to ${a.name}`)}}
function removeTicker(t){const a=active(),i=a.tickers.indexOf(t);if(i<0)return;a.tickers.splice(i,1);save();renderAll();
  toast(`${info(t).name} removed`,()=>{a.tickers.splice(i,0,t);save();renderAll()})}

document.addEventListener("click",e=>{
  if(!e.target.closest(".dd")) toggleMenu(false);
  if(!e.target.closest(".search")) $("results").classList.remove("open");
  const t=e.target.closest("[data-open],[data-close],[data-add],[data-remove],[data-pick],[data-m],[data-sort],[data-soon],[data-tab]");
  if(!t) return;
  if(t.dataset.remove!==undefined){removeTicker(t.dataset.remove)}
  else if(t.dataset.add){addTicker(t.dataset.add);renderResults();renderAddList()}
  else if(t.dataset.tab){setTab(t.dataset.tab)}
  else if(t.dataset.open){e.preventDefault();openDrawer(t.dataset.open)}
  else if(t.hasAttribute("data-close")) closeAll();
  else if(t.dataset.pick){state.active=t.dataset.pick;save();toggleMenu(false);renderAll()}
  else if(t.dataset.m!==undefined) manageView(+t.dataset.m);
  else if(t.dataset.sort){const k=t.dataset.sort,c=COLS[tab].find(x=>x.key===k);
    sort=sort.key===k?(sort.dir>0?{key:k,dir:-1}:{key:null,dir:1}):{key:k,dir:(k==="name"||(c&&c.asc))?1:-1};renderTable()}
  else if(t.hasAttribute("data-soon")){e.preventDefault();toast("Coming in a later version")}
});
$("list-btn").onclick=e=>{e.stopPropagation();toggleMenu()};
$("new-btn").onclick=()=>{openDlg("dlg-new");$("new-name").value="";$("new-err").textContent="";$("new-name").focus()};
$("new-ok").onclick=()=>{const n=$("new-name").value.trim(),err=nameError(n);if(err){$("new-err").textContent=err;return}
  const id="l"+Date.now();state.lists.push({id,name:n,tickers:[]});state.active=id;save();closeAll();renderAll();toast(`Created ${n}`)};
$("new-name").onkeydown=e=>{if(e.key==="Enter")$("new-ok").click()};
$("manage-btn").onclick=()=>{manageView(0);openDlg("dlg-manage")};
$("manage-body").addEventListener("click",e=>{
  const a=active();
  if(e.target.id==="ren-ok"){const n=$("ren").value.trim(),err=nameError(n,a.id);if(err){$("ren-err").textContent=err;return}
    a.name=n;save();closeAll();renderAll();toast(`Renamed to ${n}`)}
  if(e.target.id==="del-final"){const name=a.name;state.lists=state.lists.filter(l=>l.id!==a.id);
    if(!state.lists.length) state.lists.push({id:"l"+Date.now(),name:"My watchlist",tickers:[]});
    state.active=state.lists[0].id;save();closeAll();renderAll();toast(`Deleted ${name}`)}
});
$("manage-body").addEventListener("keydown",e=>{if(e.target.id==="ren"&&e.key==="Enter")$("ren-ok").click()});
$("search").oninput=renderResults; $("search").onfocus=renderResults;
$("add-btn").onclick=()=>{openDlg("dlg-add");$("add-search").value="";renderAddList();$("add-search").focus()};
$("add-search").oninput=renderAddList;
$("scrim").onclick=closeAll;
document.addEventListener("keydown",e=>{if(e.key==="Escape"){closeAll();$("results").classList.remove("open")}});
const setUnit=u=>{unit=u;$("u-pct").setAttribute("aria-pressed",u==="pct");$("u-sek").setAttribute("aria-pressed",u==="sek");renderTable()};
$("u-pct").onclick=()=>setUnit("pct"); $("u-sek").onclick=()=>setUnit("sek");

/* ---------- settings: GitHub connection ---------- */
function openSettings(){
  $("gh-owner").value=gh.owner; $("gh-repo").value=gh.repo; $("gh-token").value="";
  $("gh-token").placeholder=gh.token?"Saved. Paste a new token to replace it":"github_pat_…";
  $("gh-remove").hidden=!gh.token; $("gh-err").textContent=""; openDlg("dlg-settings");
}
$("settings-btn").onclick=openSettings;
$("gh-save").onclick=async()=>{
  const owner=$("gh-owner").value.trim(), repo=$("gh-repo").value.trim(), token=$("gh-token").value.trim()||gh.token;
  if(!owner||!repo||!token){$("gh-err").textContent="Fill in owner, repository and token.";return}
  gh={owner,repo,token}; try{localStorage.setItem(GH_KEY,JSON.stringify(gh))}catch(e){}
  $("gh-save").disabled=true; const ok=await loadMarket(false); $("gh-save").disabled=false;
  if(ok){closeAll();toast(`Connected. Prices from ${fmtDate(MARKET.asOf)}`)} else $("gh-err").textContent=marketError;
};
$("gh-remove").onclick=()=>{gh.token="";try{localStorage.setItem(GH_KEY,JSON.stringify(gh));localStorage.removeItem(MKT_KEY)}catch(e){}
  MARKET=null;marketError="";closeAll();renderAll();toast("Token removed. Showing demo data.")};

function renderAll(){renderBanner();renderTable();renderStatus()}
renderAll();
loadMarket(false);
})();
