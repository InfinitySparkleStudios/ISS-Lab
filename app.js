/* ISS Laboratory — lab book app (GitHub Pages + InfinityCRM Supabase) */
(() => {
"use strict";

/* ================= constants ================= */
const CONSENT_VERSION = "ISS-TI-v1";
const PRIV = "lab-private", PUB = "lab-public";
const STATUS = {received:"Received", testing:"Testing", reported:"Report issued"};
const DEFAULT_SERVICES = [
  {id:"idLoose",   label:"Identification Report — loose stone (up to 15 ct)", price:850},
  {id:"idMounted", label:"Identification Report — mounted stone", price:950},
  {id:"addStone",  label:"Additional stone, same submission", price:350},
  {id:"idVal",     label:"Identification + Insurance Valuation (combined)", price:1350},
  {id:"valSimple", label:"Insurance valuation — simple single item", price:750},
  {id:"valComplex",label:"Insurance valuation — complex or multi-stone piece", price:1450},
  {id:"reval",     label:"Re-valuation of an ISS-certified item", price:450},
  {id:"dup",       label:"Duplicate or reissued certificate", price:250}
];
const DEFAULT_SETTINGS = {
  businessName:"ISS Laboratory", parent:"Infinity Sparkle Studios", gemmologist:"Martha du Plessis",
  credentials:"GIA Gemologist · Accredited Jewellery Professional", phone:"0790400809",
  email:"ISSLaboratory@infinitysstudio.com", address:"", payLink:"", bank:"", verifyUrl:"", logo:"",
  remindMonths:24, services:DEFAULT_SERVICES
};
const VAL_SERVICES = ["idVal","valSimple","valComplex","reval"];

/* ================= state ================= */
const cfg = window.ISS_CONFIG || {};
let sb = null, user = null, role = null;
let jobs = [], settings = {...DEFAULT_SETTINGS};
let view = {tab:"jobs", jobId:null};
let draft = null, jobEdit = null, setDraft = null, jobFilter = "";
let busy = false;
const urlCache = new Map(); // storage path -> {url, at}

/* ================= helpers ================= */
const $ = (s,el=document)=>el.querySelector(s);
const esc = v => String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => "R" + (Math.round(Number(n)||0)).toLocaleString("en-ZA").replace(/[  ]/g," ");
const fmtDate = iso => iso ? new Date(iso).toLocaleDateString("en-ZA",{day:"2-digit",month:"short",year:"numeric"}) : "";
const fmtDT = iso => iso ? new Date(iso).toLocaleString("en-ZA",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}) : "";
const todayISO = () => new Date().toLocaleDateString("en-CA",{timeZone:"Africa/Johannesburg"});
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16)));
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.hidden=false; clearTimeout(toast._t); toast._t=setTimeout(()=>t.hidden=true,3200); }
function errMsg(e){ return (e && (e.message || e.error_description)) || "Something went wrong. Check your connection and try again."; }
function services(){ return (settings.services && settings.services.length ? settings.services : DEFAULT_SERVICES); }
function jobTotal(j){ const sub=(j.services||[]).reduce((s,x)=>s+(Number(x.price)||0)*(Number(x.qty)||1),0); return Math.round(sub*(j.walkIn?1.5:1)); }
function normPhone(p){ const d=String(p||"").replace(/\D/g,""); if(!d) return ""; return d.startsWith("0") ? "27"+d.slice(1) : d; }
function splitName(n){ const p=String(n||"").trim().split(/\s+/); return {first:p.shift()||"", last:p.join(" ")||null}; }
function receiptFor(reportNo){ return "RCPT-" + String(reportNo||"").replace(/^ISSL-/,""); }
async function copyText(text){ try{ await navigator.clipboard.writeText(text); toast("Copied"); }catch(e){ toast("Copy is not available here"); } }
function downloadBlob(blob, filename){
  const a=document.createElement("a"); const u=URL.createObjectURL(blob);
  a.href=u; a.download=filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(u), 4000);
}
async function shareOrDownload(blob, filename, title, text){
  const file = new File([blob], filename, {type: blob.type || "application/pdf"});
  if(navigator.canShare && navigator.canShare({files:[file]})){
    try{ await navigator.share({files:[file], title, text}); return "shared"; }
    catch(e){ if(e && e.name==="AbortError") return "cancelled"; }
  }
  downloadBlob(blob, filename); return "downloaded";
}
function mailto(to,subject,body){ return "mailto:"+encodeURIComponent(to||"")+"?subject="+encodeURIComponent(subject)+"&body="+encodeURIComponent(body); }
function waLink(phone,text){ const n=normPhone(phone); return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : ""; }
function verifyBase(){ if(settings.verifyUrl) return settings.verifyUrl.trim(); const u=new URL("verify.html", location.href); u.search=""; u.hash=""; return u.href; }
function verifyLink(j){ const u=verifyBase(); return u + (u.includes("?")?"&":"?") + "report=" + encodeURIComponent(j.reportNo) + "&code=" + encodeURIComponent(j.verifyCode); }

/* ================= storage ================= */
function isUrl(ref){ return /^(https?:|blob:|data:)/.test(String(ref||"")); }
function src(ref){ if(!ref) return ""; if(isUrl(ref)) return ref; const c=urlCache.get(ref); return c ? c.url : ""; }
async function ensureSigned(paths){
  const need=[...new Set(paths.filter(p=>p && !isUrl(p)))].filter(p=>{ const c=urlCache.get(p); return !c || Date.now()-c.at > 5*3600e3; });
  if(!need.length) return false;
  const {data,error}=await sb.storage.from(PRIV).createSignedUrls(need, 6*3600);
  if(error){ console.warn(error); return false; }
  (data||[]).forEach(d=>{ if(d.signedUrl) urlCache.set(d.path, {url:d.signedUrl, at:Date.now()}); });
  return true;
}
async function resizeImage(file, maxSide){
  const url = URL.createObjectURL(file);
  try{
    const img = await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=url; });
    const scale = Math.min(1, maxSide/Math.max(img.naturalWidth,img.naturalHeight));
    const c=document.createElement("canvas");
    c.width=Math.round(img.naturalWidth*scale); c.height=Math.round(img.naturalHeight*scale);
    c.getContext("2d").drawImage(img,0,0,c.width,c.height);
    return await new Promise(r=>c.toBlob(r,"image/jpeg",0.88));
  } finally { URL.revokeObjectURL(url); }
}
async function uploadPrivate(path, blob, type){
  const {error}=await sb.storage.from(PRIV).upload(path, blob, {contentType:type, upsert:true});
  if(error) throw new Error("The photo could not be saved: " + error.message);
  urlCache.set(path, {url:URL.createObjectURL(blob), at:Date.now()});
  return path;
}
async function uploadPublic(path, blob, type){
  const {error}=await sb.storage.from(PUB).upload(path, blob, {contentType:type, upsert:true});
  if(error) throw new Error("The file could not be published: " + error.message);
  return sb.storage.from(PUB).getPublicUrl(path).data.publicUrl;
}

/* ================= data mapping ================= */
function fromRow(r){
  return {
    id:r.id, reportNo:r.report_no||"", verifyCode:r.verify_code, status:r.status,
    createdAt:r.created_at, updatedAt:r.updated_at, reportIssuedAt:r.report_issued_at,
    clientId:r.client_id, client:{name:r.client_name||"", phone:r.client_phone||"", email:r.client_email||"", ref:r.client_ref||""},
    item:r.item||{}, photos:r.photos||[], services:r.services||[], walkIn:!!r.walk_in, total:Number(r.total)||0,
    consent:r.consent||{}, micrographs:r.micrographs||[], tests:r.tests||{}, result:r.result||{}, valuation:r.valuation||{},
    publicPhoto:r.public_photo||"",
    payment:{paid:!!r.paid, paidAt:r.paid_at, method:r.pay_method||"", ref:r.pay_ref||"", amount:r.amount_paid!=null?Number(r.amount_paid):null, receiptNo:r.receipt_no||""},
    reminderDue:r.reminder_due, reminderSentAt:r.reminder_sent_at, reminderCount:r.reminder_count||0
  };
}
async function loadJobs(){
  const {data,error}=await sb.from("lab_jobs").select("*").order("created_at",{ascending:false}).limit(1000);
  if(error) throw error;
  jobs=(data||[]).map(fromRow);
}
async function loadSettings(){
  const {data,error}=await sb.from("lab_settings").select("data").eq("id",1).maybeSingle();
  if(error) throw error;
  settings={...DEFAULT_SETTINGS, ...((data&&data.data)||{})};
}
async function patchJob(id, patch){
  const {data,error}=await sb.from("lab_jobs").update(patch).eq("id",id).select("*").single();
  if(error) throw error;
  const j=fromRow(data); const i=jobs.findIndex(x=>x.id===id); if(i>=0) jobs[i]=j; else jobs.unshift(j);
  return j;
}
async function saveSettings(next){
  const {error}=await sb.from("lab_settings").update({data:next}).eq("id",1);
  if(error) throw error;
  settings={...DEFAULT_SETTINGS, ...next};
}

/* ================= consent ================= */
function consentParts(name){
  const n=name||"the client", B=settings.businessName;
  return {
    intro:[
      `I, ${n}, confirm that I am the owner of the item(s) described above, or am authorised by the owner to submit them.`,
      `I give ${B} (${settings.parent}) permission to examine and test the item(s) using standard gemmological methods. These are non-destructive and may include magnification, refractometer, polariscope, spectroscope, UV light, specific gravity testing, and photography, including micrographs kept as evidence.`,
      `I understand and agree that:`
    ],
    items:[
      `Results are the professional opinion of ${B}, based on the tests available at the time of examination. They are not a GIA laboratory report.`,
      `The carat weight of a mounted stone is estimated.`,
      `Visible pre-existing damage, wear or weak settings are recorded above. ${B} is not liable for damage that results from a stone's existing fractures, fillings, coatings or weak settings during normal examination and cleaning.`,
      `Stones will not be removed from their settings without my separate written permission.`,
      `Fees are due whatever the result of the tests, and are payable before the report is released.`,
      `Items not collected within 90 days of being notified may incur a storage fee.`,
      `My personal information and photos of the item(s) are kept securely and used only to provide this service, keep the report record and remind me when a re-test or re-valuation is due, in line with POPIA. The report number, the stone's description, photo and results (never my personal details) may be shown to anyone who checks that the report is authentic.`
    ]
  };
}
function consentHTML(name){ const c=consentParts(name); return c.intro.map(p=>`<p>${esc(p)}</p>`).join("")+`<ol>${c.items.map(i=>`<li>${esc(i)}</li>`).join("")}</ol>`; }
function consentPlain(name){ const c=consentParts(name); return c.intro.join("\n\n")+"\n"+c.items.map((x,i)=>`${i+1}. ${x}`).join("\n"); }

/* ================= auth ================= */
let recovering=false;
function showLogin(msg){
  $("#appView").hidden=true; $("#loginView").hidden=false;
  const m=$("#lMsg"); if(msg){ m.textContent=msg; m.hidden=false; } else m.hidden=true;
  $("#lErr").hidden=true;
  $("#lPassWrap").hidden=recovering; $("#lNewWrap").hidden=!recovering; $("#lForgot").hidden=recovering;
  $("#lEmail").closest("label").hidden=recovering;
  $("#lSubmit").textContent=recovering?"Save new password":"Sign in";
}
function loginError(t){ const e=$("#lErr"); e.textContent=t; e.hidden=false; }
$("#loginForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const btn=$("#lSubmit"); btn.disabled=true;
  try{
    if(recovering){
      const np=$("#lNew").value;
      if(np.length<8){ loginError("Use at least 8 characters."); return; }
      const {error}=await sb.auth.updateUser({password:np});
      if(error){ loginError(error.message); return; }
      recovering=false; history.replaceState(null,"",location.pathname); toast("Password saved"); await start();
      return;
    }
    const email=$("#lEmail").value.trim(), pw=$("#lPass").value;
    if(!email||!pw){ loginError("Enter your email and password."); return; }
    const {error}=await sb.auth.signInWithPassword({email,password:pw});
    if(error){ loginError(error.message==="Invalid login credentials" ? "That email and password don't match. Try again or reset your password." : error.message); return; }
    $("#lPass").value=""; await start();
  } finally { btn.disabled=false; }
});
$("#lForgot").onclick=async()=>{
  const email=$("#lEmail").value.trim();
  if(!email){ loginError("Type your email first, then tap Forgot password."); return; }
  const {error}=await sb.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});
  if(error){ loginError(error.message); return; }
  showLogin("Check your email for a link to set a new password.");
};
$("#signOut").onclick=async()=>{ await sb.auth.signOut(); jobs=[]; urlCache.clear(); showLogin(); };

async function start(){
  const {data:{session}}=await sb.auth.getSession();
  if(!session){ showLogin(); return; }
  user=session.user;
  const {data:r}=await sb.from("user_roles").select("role,display_name").eq("user_id",user.id).maybeSingle();
  role=r&&r.role;
  if(!["owner","supervisor"].includes(role)){
    await sb.auth.signOut();
    showLogin("This account doesn't have access to the lab book. Ask the owner to give it the Supervisor role.");
    return;
  }
  $("#whoName").textContent=(r.display_name||user.email);
  $("#loginView").hidden=true; $("#appView").hidden=false;
  try{
    await Promise.all([loadSettings(), loadJobs()]);
  }catch(e){
    $("#app").innerHTML=`<div class="empty"><b>The lab book could not load</b><span>${esc(errMsg(e))}</span><span class="small">If this says a table does not exist, run the setup file supabase/01_iss_lab_module.sql in Supabase once.</span></div>`;
    return;
  }
  render();
}

/* ================= navigation ================= */
document.querySelectorAll("nav.tabs button").forEach(b=>b.addEventListener("click",()=>{
  view={tab:b.dataset.tab, jobId:null}; jobEdit=null; setDraft=null;
  if(view.tab==="new" && !draft) draft=newDraft();
  render(); window.scrollTo(0,0);
}));
async function openJob(id){
  const j=jobs.find(x=>x.id===id); if(!j) return;
  view={tab:"jobs", jobId:id}; jobEdit=null;
  await ensureSigned([...(j.photos||[]), j.consent?.signature, ...(j.micrographs||[]).map(m=>m.path)]);
  render(); window.scrollTo(0,0);
}
document.addEventListener("visibilitychange", async ()=>{
  if(document.visibilityState==="visible" && user && view.tab!=="new" && !(jobEdit&&jobEdit.dirty)){
    try{ await loadJobs(); render(); }catch(e){}
  }
});

function dueReminders(){
  const horizon=new Date(); horizon.setDate(horizon.getDate()+60);
  const h=horizon.toLocaleDateString("en-CA",{timeZone:"Africa/Johannesburg"});
  return jobs.filter(j=>j.status==="reported" && j.reminderDue && j.reminderDue<=h &&
    !(j.reminderSentAt && j.reminderSentAt.slice(0,10) >= addDays(j.reminderDue,-60)))
    .sort((a,b)=>a.reminderDue.localeCompare(b.reminderDue));
}
function addDays(iso,n){ const d=new Date(iso+"T12:00:00"); d.setDate(d.getDate()+n); return d.toISOString().slice(0,10); }

function render(){
  if(busy) return;
  document.querySelectorAll("nav.tabs button").forEach(b=>b.setAttribute("aria-current", b.dataset.tab===view.tab ? "page":"false"));
  const n=dueReminders().length, rb=$("#remBadge"); rb.textContent=n; rb.hidden=!n;
  const app=$("#app");
  if(view.tab==="jobs" && view.jobId){ const j=jobs.find(x=>x.id===view.jobId); if(j){ renderJob(app,j); return; } }
  if(view.tab==="jobs") renderJobs(app);
  else if(view.tab==="new") renderNew(app);
  else if(view.tab==="remind") renderReminders(app);
  else if(view.tab==="ledger") renderLedger(app);
  else if(view.tab==="settings") renderSettings(app);
}

/* ================= jobs list ================= */
function renderJobs(app){
  const q=jobFilter.trim().toLowerCase();
  const list=jobs.filter(j=>!q || [j.reportNo,j.client.name,j.client.ref,j.item.description,j.client.phone,j.client.email].join(" ").toLowerCase().includes(q));
  const open=jobs.filter(j=>j.status!=="reported" || !j.payment.paid).length;
  app.innerHTML=`
  <div class="stack">
    <div class="row" style="justify-content:space-between">
      <h2>Jobs</h2>
      <div class="row"><span class="muted small">${jobs.length} on file · ${open} open</span><button class="btn sm ghost" id="refresh">Refresh</button></div>
    </div>
    <input id="jobSearch" type="search" placeholder="Search report number, LAB ref, client or stone" value="${esc(jobFilter)}" aria-label="Search jobs">
    ${jobs.length===0 ? `<div class="empty"><b>No stones taken in yet</b><span>Each take-in becomes a job file with its own report number, photos, signed waiver and micrographs.</span><button class="btn primary" id="startFirst">Start a take-in</button></div>` :
      `<div class="joblist">${list.map(jobRow).join("") || `<p class="muted">No jobs match “${esc(jobFilter)}”.</p>`}</div>`}
  </div>`;
  const s=$("#jobSearch"); s.addEventListener("input",()=>{ jobFilter=s.value; const pos=s.selectionStart; renderJobs(app); const n=$("#jobSearch"); n.focus(); n.setSelectionRange(pos,pos); });
  const sf=$("#startFirst"); if(sf) sf.onclick=()=>{ view={tab:"new",jobId:null}; draft=newDraft(); render(); };
  $("#refresh").onclick=async()=>{ try{ await loadJobs(); toast("Up to date"); render(); }catch(e){ toast(errMsg(e)); } };
  app.querySelectorAll(".job").forEach(b=>b.onclick=()=>openJob(b.dataset.id));
  const thumbs=list.map(j=>j.photos[0]).filter(Boolean);
  ensureSigned(thumbs).then(changed=>{ if(changed && view.tab==="jobs" && !view.jobId) renderJobs(app); });
}
function jobRow(j){
  const ph=src(j.photos[0]);
  return `<button class="job" data-id="${esc(j.id)}">
    ${ph?`<img src="${esc(ph)}" alt="">`:`<div class="thumbph"></div>`}
    <div class="t"><b>${esc(j.item.description||"Item")}</b><span><span class="mono">${esc(j.reportNo)}</span> · ${esc(j.client.name)}${j.client.ref?` (${esc(j.client.ref)})`:""} · ${fmtDate(j.createdAt)}</span></div>
    <div class="r"><span class="chip ${j.status==="reported"?"ok":""}">${STATUS[j.status]||j.status}</span>
      <span class="chip ${j.payment.paid?"ok":"warn"}">${j.payment.paid?"Paid":"Unpaid"}</span></div>
  </button>`;
}

/* ================= new take-in ================= */
function newDraft(){
  return {jobId:uuid(), clientQuery:"", clientMatches:null, linked:null,
    client:{name:"",phone:"",email:""},
    item:{description:"",setting:"loose",statedId:"",estWeight:"",colour:"",shape:"",measurements:"",condition:""},
    photos:[], services:{}, walkIn:false, agree:false, sigDirty:false, sigData:null};
}
function draftTotal(){ const d=draft; if(!d) return 0; const sub=Object.values(d.services).reduce((s,x)=>s+x.qty*x.price,0); return Math.round(sub*(d.walkIn?1.5:1)); }

async function searchClients(q){
  q=q.trim(); if(q.length<2) return [];
  const like="%"+q.replace(/[%_,()]/g," ")+"%";
  const ph=normPhone(q);
  const ors=[`first_name.ilike.${like}`,`last_name.ilike.${like}`,`email.ilike.${like}`,`client_no.ilike.${like}`,`lab_ref.ilike.${like}`];
  if(ph.length>=4) ors.push(`phone_normalized.ilike.%${ph}%`);
  const {data,error}=await sb.from("clients").select("id,client_no,lab_ref,first_name,last_name,email,phone_whatsapp").or(ors.join(",")).limit(8);
  if(error){ console.warn(error); return []; }
  return data||[];
}
function clientLabel(c){ return [c.first_name,c.last_name].filter(Boolean).join(" "); }

function renderNew(app){
  if(!draft) draft=newDraft();
  const d=draft;
  const svcRows=services().map(s=>{
    const sel=d.services[s.id];
    return `<div class="svc">
      <input type="checkbox" id="svc-${s.id}" data-svc="${s.id}" ${sel?"checked":""} aria-label="${esc(s.label)}">
      <span><label for="svc-${s.id}">${esc(s.label)}</label></span>
      <input type="number" min="1" step="1" id="qty-${s.id}" data-qty="${s.id}" value="${sel?sel.qty:1}" aria-label="Quantity" class="mono">
      <input type="number" min="0" step="10" id="price-${s.id}" data-price="${s.id}" value="${sel?sel.price:s.price}" aria-label="Price" class="mono">
    </div>`;}).join("");
  const L=d.linked;
  app.innerHTML=`
  <form id="takeIn" class="stack" novalidate>
    <div class="row" style="justify-content:space-between"><h2>New take-in</h2><span class="muted small">A report number is assigned when you save</span></div>

    <section class="card"><h3>Client</h3>
      ${L?`<div class="linked"><div><b>${esc(clientLabel(L))}</b><br><span class="small muted"><span class="mono">${esc(L.client_no||"")}</span>${L.lab_ref?` · <span class="mono">${esc(L.lab_ref)}</span>`:" · LAB number given on save"}</span></div>
        <button type="button" class="btn sm ghost" id="unlink">Change client</button></div>`:`
      <label class="f">Find an existing client (name, phone, email, C- or LAB- number)<input id="cFind" value="${esc(d.clientQuery)}" placeholder="Start typing…" autocomplete="off"></label>
      ${d.clientMatches?`<div class="picker">${d.clientMatches.length?d.clientMatches.map((c,i)=>`<button type="button" data-pick="${i}"><span>${esc(clientLabel(c))}<br><span class="small muted">${esc(c.phone_whatsapp||c.email||"")}</span></span><span class="small mono muted">${esc(c.lab_ref||c.client_no||"")}</span></button>`).join(""):`<span class="small muted">No match. Fill in the details below and a new CRM client will be created with a LAB number.</span>`}</div>`:""}`}
      <div class="grid2">
        <label class="f">Full name *<input id="c-name" data-k="client.name" value="${esc(d.client.name)}" autocomplete="off"></label>
        <label class="f">Phone / WhatsApp *<input id="c-phone" data-k="client.phone" type="tel" value="${esc(d.client.phone)}"></label>
        <label class="f">Email (for receipt, report and reminders)<input id="c-email" data-k="client.email" type="email" value="${esc(d.client.email)}"></label>
      </div>
    </section>

    <section class="card"><h3>Item received</h3>
      <div class="grid2">
        <label class="f">Description *<input id="i-desc" data-k="item.description" placeholder="e.g. Violet-blue oval stone" value="${esc(d.item.description)}"></label>
        <label class="f">Loose or mounted<select id="i-setting" data-k="item.setting">
          <option value="loose" ${d.item.setting==="loose"?"selected":""}>Loose stone</option>
          <option value="mounted" ${d.item.setting==="mounted"?"selected":""}>Mounted in jewellery</option></select></label>
        <label class="f">Client says it is<input id="i-stated" data-k="item.statedId" placeholder="e.g. Tanzanite" value="${esc(d.item.statedId)}"></label>
        <label class="f">Weight at take-in (ct)<input id="i-wt" data-k="item.estWeight" inputmode="decimal" class="mono" value="${esc(d.item.estWeight)}"></label>
        <label class="f">Colour<input id="i-colour" data-k="item.colour" value="${esc(d.item.colour)}"></label>
        <label class="f">Shape and cut<input id="i-shape" data-k="item.shape" value="${esc(d.item.shape)}"></label>
        <label class="f">Measurements (mm)<input id="i-meas" data-k="item.measurements" class="mono" placeholder="9.12 x 7.05 x 4.80" value="${esc(d.item.measurements)}"></label>
      </div>
      <label class="f">Condition at take-in: visible damage, wear, loose claws<textarea id="i-cond" data-k="item.condition">${esc(d.item.condition)}</textarea></label>
    </section>

    <section class="card"><h3>Take-in photos *</h3>
      <p class="muted small" style="margin:0">Photograph the stone in front of the client. On a phone or tablet this opens the camera.</p>
      <div class="photos">${d.photos.map((p,i)=>`<figure><img src="${esc(src(p))}" alt="Take-in photo ${i+1}"><button type="button" class="btn sm ghost" data-rmphoto="${i}">Remove</button></figure>`).join("")}</div>
      <div class="row">
        <label class="btn primary" for="tiCam">Take photo</label>
        <input id="tiCam" type="file" accept="image/*" capture="environment" hidden>
        <label class="btn" for="tiFile">Choose from gallery</label>
        <input id="tiFile" type="file" accept="image/*" multiple hidden>
      </div>
    </section>

    <section class="card"><h3>Services</h3>
      <div class="muted" style="font-size:.78rem;display:grid;grid-template-columns:auto 1fr 64px 96px;gap:8px"><span style="width:22px"></span><span>Service</span><span>Qty</span><span>Price</span></div>
      <div>${svcRows}</div>
      <label class="check"><input type="checkbox" id="walkIn" ${d.walkIn?"checked":""}> <span>Walk-in without an appointment (while you wait): +50%</span></label>
      <div class="total"><span>Total</span><span class="mono" id="tiTotal">${money(draftTotal())}</span></div>
    </section>

    <section class="card"><h3>Permission to test and waiver</h3>
      <div class="waiver" id="waiverText">${consentHTML(d.client.name)}</div>
      <label class="check"><input type="checkbox" id="agree" ${d.agree?"checked":""}> <span>The client has read and agrees to the above.</span></label>
      <div class="sigbox"><canvas id="sig" aria-label="Client signature pad"></canvas><span class="lbl">Client signs here</span></div>
      <div class="row"><button type="button" class="btn sm ghost" id="sigClear">Clear signature</button><span class="muted small">Signed ${new Date().toLocaleDateString("en-ZA")}</span></div>
    </section>

    <p id="tiErr" class="err" hidden></p>
    <div class="row"><button type="submit" class="btn primary" id="tiSave" style="flex:1">Save take-in and assign report number</button>
      <button type="button" class="btn ghost" id="tiReset">Clear form</button></div>
  </form>`;

  const form=$("#takeIn");
  let findT;
  const cf=$("#cFind");
  if(cf) cf.addEventListener("input",()=>{
    d.clientQuery=cf.value; clearTimeout(findT);
    findT=setTimeout(async()=>{
      const pos=cf.selectionStart;
      d.clientMatches = d.clientQuery.trim().length>=2 ? await searchClients(d.clientQuery) : null;
      if(view.tab!=="new") return;
      renderNew(app); const n=$("#cFind"); if(n){ n.focus(); n.setSelectionRange(pos,pos); }
    },350);
  });
  app.querySelectorAll("[data-pick]").forEach(b=>b.onclick=()=>{
    const c=d.clientMatches[Number(b.dataset.pick)];
    d.linked=c; d.clientMatches=null; d.clientQuery="";
    d.client.name=clientLabel(c); d.client.phone=c.phone_whatsapp||d.client.phone; d.client.email=c.email||d.client.email;
    renderNew(app);
  });
  const ul=$("#unlink"); if(ul) ul.onclick=()=>{ d.linked=null; renderNew(app); };
  form.addEventListener("input",e=>{
    const k=e.target.dataset.k;
    if(k){ const [a,b]=k.split("."); d[a][b]=e.target.value; if(k==="client.name") $("#waiverText").innerHTML=consentHTML(d.client.name); }
    if(e.target.dataset.qty||e.target.dataset.price) syncSvc(e.target.dataset.qty||e.target.dataset.price);
  });
  form.addEventListener("change",e=>{
    if(e.target.dataset.svc) syncSvc(e.target.dataset.svc);
    if(e.target.id==="walkIn"){ d.walkIn=e.target.checked; $("#tiTotal").textContent=money(draftTotal()); }
    if(e.target.id==="agree") d.agree=e.target.checked;
    if(e.target.dataset.k){ const [a,b]=e.target.dataset.k.split("."); d[a][b]=e.target.value; }
  });
  function syncSvc(id){
    const on=$("#svc-"+id).checked;
    if(on) d.services[id]={qty:Math.max(1,Number($("#qty-"+id).value)||1), price:Number($("#price-"+id).value)||0};
    else delete d.services[id];
    $("#tiTotal").textContent=money(draftTotal());
  }
  const addPhotos=async files=>{
    for(const f of files){
      try{ toast("Saving photo…"); const blob=await resizeImage(f,2000);
        const path=`jobs/${d.jobId}/take-in-${Date.now()}.jpg`; await uploadPrivate(path,blob,"image/jpeg"); d.photos.push(path); }
      catch(err){ toast(errMsg(err)); }
    }
    if(view.tab==="new") renderNew(app);
  };
  $("#tiCam").onchange=e=>addPhotos([...e.target.files]);
  $("#tiFile").onchange=e=>addPhotos([...e.target.files]);
  app.querySelectorAll("[data-rmphoto]").forEach(b=>b.onclick=()=>{ d.photos.splice(Number(b.dataset.rmphoto),1); renderNew(app); });
  const pad=signaturePad($("#sig"), url=>{ d.sigDirty=true; d.sigData=url; }, d.sigData);
  $("#sigClear").onclick=()=>{ pad.clear(); d.sigDirty=false; d.sigData=null; };
  $("#tiReset").onclick=()=>{ draft=newDraft(); renderNew(app); };
  form.addEventListener("submit", async e=>{
    e.preventDefault();
    const err=$("#tiErr"); const missing=[];
    if(!d.client.name.trim()) missing.push("client name");
    if(!d.client.phone.trim()) missing.push("phone");
    if(!d.item.description.trim()) missing.push("item description");
    if(!d.photos.length) missing.push("at least one take-in photo");
    if(!Object.keys(d.services).length) missing.push("a service");
    if(!d.agree) missing.push("the client's agreement tick");
    if(!d.sigDirty) missing.push("the client's signature");
    if(missing.length){ err.textContent="Still needed: "+missing.join(", ")+"."; err.hidden=false; return; }
    err.hidden=true;
    const btn=$("#tiSave"); btn.disabled=true; btn.textContent="Saving…"; busy=true;
    try{
      const client=await linkOrCreateClient(d);
      const sigPath=`jobs/${d.jobId}/signature.png`;
      await uploadPrivate(sigPath, await pad.toBlob(), "image/png");
      const svcList=services().filter(s=>d.services[s.id]).map(s=>({id:s.id,label:s.label,qty:d.services[s.id].qty,price:d.services[s.id].price}));
      const now=new Date().toISOString();
      const row={
        id:d.jobId, client_id:client.id, client_name:d.client.name.trim(), client_phone:d.client.phone.trim(),
        client_email:d.client.email.trim()||null, client_ref:client.lab_ref||null,
        status:"received", item:{...d.item}, photos:[...d.photos], services:svcList, walk_in:d.walkIn,
        total:jobTotal({services:svcList, walkIn:d.walkIn}),
        consent:{version:CONSENT_VERSION, signedName:d.client.name.trim(), signedAt:now, signature:sigPath, text:consentPlain(d.client.name.trim())}
      };
      const {data,error}=await sb.from("lab_jobs").insert(row).select("*").single();
      if(error) throw error;
      const j=fromRow(data); jobs.unshift(j);
      draft=null; busy=false;
      toast(`Saved as ${j.reportNo}`);
      await openJob(j.id);
    }catch(ex){
      busy=false; btn.disabled=false; btn.textContent="Save take-in and assign report number";
      err.textContent=errMsg(ex); err.hidden=false;
    }
  });
}

async function linkOrCreateClient(d){
  let c=d.linked;
  if(!c){
    // avoid duplicates: exact phone or email match
    const ph=normPhone(d.client.phone), em=d.client.email.trim().toLowerCase();
    const ors=[]; if(ph) ors.push(`phone_normalized.eq.${ph}`); if(em) ors.push(`email.ilike.${em.replace(/[%_,()]/g,"")}`);
    if(ors.length){
      const {data}=await sb.from("clients").select("id,client_no,lab_ref,first_name,last_name,email,phone_whatsapp").or(ors.join(",")).limit(1);
      if(data && data[0]) c=data[0];
    }
  }
  if(!c){
    const nm=splitName(d.client.name);
    const {data,error}=await sb.from("clients").insert({
      first_name:nm.first, last_name:nm.last, email:d.client.email.trim()||null, phone_whatsapp:d.client.phone.trim()||null,
      preferred_channel:d.client.email.trim()?"email":"whatsapp", source:"iss_lab", status:"active",
      popia_consent:true, popia_consent_at:new Date().toISOString(), client_type:"retail",
      notes:"Created from an ISS Laboratory take-in."
    }).select("id,client_no,lab_ref,first_name,last_name,email,phone_whatsapp").single();
    if(error) throw new Error("The client could not be added to the CRM: "+error.message);
    c=data;
  }
  if(!c.lab_ref){
    const {data:ref,error}=await sb.rpc("lab_client_ref",{p_client_id:c.id});
    if(error) throw new Error("The LAB number could not be assigned: "+error.message);
    c.lab_ref=ref;
  }
  return c;
}

/* signature pad */
function signaturePad(canvas, onInk, initial){
  const ctx=canvas.getContext("2d");
  let drawing=false, last=null, inked=false;
  function size(){
    const r=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
    canvas.width=Math.round(r.width*dpr); canvas.height=Math.round(r.height*dpr);
    ctx.setTransform(dpr,0,0,dpr,0,0); ctx.fillStyle="#ffffff"; ctx.fillRect(0,0,r.width,r.height);
    ctx.lineWidth=2.2; ctx.lineCap="round"; ctx.lineJoin="round"; ctx.strokeStyle="#151640";
  }
  size();
  if(initial){ const im=new Image(); im.onload=()=>{ const r=canvas.getBoundingClientRect(); ctx.drawImage(im,0,0,r.width,r.height); inked=true; }; im.src=initial; }
  const pos=e=>{ const r=canvas.getBoundingClientRect(); return {x:e.clientX-r.left, y:e.clientY-r.top}; };
  canvas.addEventListener("pointerdown",e=>{ drawing=true; last=pos(e); canvas.setPointerCapture(e.pointerId); e.preventDefault(); });
  canvas.addEventListener("pointermove",e=>{ if(!drawing) return; const p=pos(e); ctx.beginPath(); ctx.moveTo(last.x,last.y); ctx.lineTo(p.x,p.y); ctx.stroke(); last=p; inked=true; e.preventDefault(); });
  const end=()=>{ if(drawing && inked) onInk(canvas.toDataURL("image/png")); drawing=false; };
  canvas.addEventListener("pointerup",end); canvas.addEventListener("pointercancel",end);
  return { clear(){ inked=false; size(); }, toBlob(){ return new Promise(r=>canvas.toBlob(r,"image/png")); } };
}

/* ================= job detail ================= */
function renderJob(app,j){
  if(!jobEdit) jobEdit={tests:{...j.tests}, result:{...j.result}, valuation:{...j.valuation}, dirty:false,
    confirmPaid:false, pay:{method:"Pay Now link",ref:""}, confirmDelete:false, renumber:false, remindDate:j.reminderDue||""};
  const e=jobEdit;
  const hasVal=(j.services||[]).some(s=>VAL_SERVICES.includes(s.id));
  const total=j.total||jobTotal(j);
  const T=(k,label,ph="")=>`<label class="f">${label}<input data-g="tests" data-f="${k}" id="t-${k}" value="${esc(e.tests[k]||"")}" placeholder="${esc(ph)}" class="${["ri","biref","sg","weight"].includes(k)?"mono":""}"></label>`;
  const R=(k,label,ph="")=>`<label class="f">${label}<input data-g="result" data-f="${k}" id="r-${k}" value="${esc(e.result[k]||"")}" placeholder="${esc(ph)}"></label>`;
  const supervisor=["owner","supervisor"].includes(role);
  app.innerHTML=`
  <div class="stack">
    <div class="row"><button class="btn sm ghost" id="back">← All jobs</button></div>
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div style="display:grid;gap:4px;min-width:0"><span class="reportno">${esc(j.reportNo)}</span><h2>${esc(j.item.description||"Item")}</h2>
      <span class="muted small">${esc(j.client.name)}${j.client.ref?` · <span class="mono">${esc(j.client.ref)}</span>`:""} · taken in ${fmtDT(j.createdAt)}</span></div>
      <div class="row"><span class="chip ${j.status==="reported"?"ok":""}">${STATUS[j.status]}</span><span class="chip ${j.payment.paid?"ok":"warn"}">${j.payment.paid?"Paid":"Unpaid"}</span></div>
    </div>

    <section class="card"><h3>Take-in record</h3>
      <dl class="kv">
        <dt>Client</dt><dd>${esc(j.client.name)}${j.client.ref?` · <span class="mono">${esc(j.client.ref)}</span>`:""}</dd>
        <dt>Phone</dt><dd class="mono">${esc(j.client.phone)}</dd>
        <dt>Email</dt><dd>${esc(j.client.email||"—")}</dd>
        <dt>Item</dt><dd>${esc(j.item.setting==="mounted"?"Mounted":"Loose")} · client says: ${esc(j.item.statedId||"—")}</dd>
        <dt>Condition</dt><dd>${esc(j.item.condition||"—")}</dd>
        <dt>Services</dt><dd>${(j.services||[]).map(s=>`${esc(s.label)} × ${s.qty} — ${money(s.price*s.qty)}`).join("<br>")}${j.walkIn?"<br>Walk-in surcharge +50%":""}<br><b>Total ${money(total)}</b></dd>
        <dt>Consent</dt><dd>Signed by ${esc(j.consent.signedName)} on ${fmtDT(j.consent.signedAt)} (${esc(j.consent.version)})</dd>
      </dl>
      <div class="photos">${j.photos.map((p,i)=>`<figure><img src="${esc(src(p))}" alt="Take-in photo ${i+1}"><figcaption>Take-in ${i+1}</figcaption></figure>`).join("")}
        ${j.consent.signature?`<figure><img src="${esc(src(j.consent.signature))}" alt="Client signature" style="object-fit:contain;background:#fff"><figcaption>Signature</figcaption></figure>`:""}</div>
      <div class="row"><button class="btn primary" id="pdfTakeIn">Take-in receipt PDF</button>
        ${j.client.email?`<a class="btn ghost" href="${esc(mailto(j.client.email,`Take-in receipt ${j.reportNo} — ${settings.businessName}`,takeInEmail(j)))}">Email client</a>`:""}</div>
      <span class="muted small">The PDF button opens your share menu. Pick Gmail or WhatsApp and the PDF is attached.</span>
    </section>

    <section class="card"><h3>Micrographs and evidence</h3>
      <div class="photos">${(j.micrographs||[]).map((m,i)=>`<figure><img src="${esc(src(m.path))}" alt="${esc(m.caption||"Micrograph")}"><figcaption>${esc(m.caption||"Micrograph "+(i+1))} · ${fmtDate(m.at)}</figcaption></figure>`).join("") || `<p class="muted small" style="margin:0">No micrographs yet. Add photos taken through the microscope or loupe.</p>`}</div>
      <label class="f">Caption for next photo<input id="mCap" placeholder="e.g. Fingerprint inclusion, 40x"></label>
      <div class="row">
        <label class="btn primary" for="mCam">Take micrograph</label><input id="mCam" type="file" accept="image/*" capture="environment" hidden>
        <label class="btn" for="mFile">Add from gallery</label><input id="mFile" type="file" accept="image/*" multiple hidden>
      </div>
    </section>

    <section class="card"><h3>Test results</h3>
      <div class="grid2">
        ${T("weight","Weight (ct), measured","3.12")}
        ${T("measurements","Measurements (mm)")}
        ${T("ri","Refractive index","1.691 – 1.700")}
        ${T("biref","Birefringence","0.009")}
        ${T("optic","Optic character","Biaxial positive")}
        ${T("sg","Specific gravity","3.35")}
        ${T("pleo","Pleochroism","Strong trichroic: blue / violet / bronze")}
        ${T("polariscope","Polariscope","DR")}
        ${T("uv","UV fluorescence (LW / SW)","Inert / inert")}
        ${T("spectro","Spectroscope")}
        ${T("filter","Chelsea filter")}
        ${T("other","Other tests")}
      </div>
      <label class="f">Magnification observations<textarea data-g="tests" data-f="magnification" id="t-magnification">${esc(e.tests.magnification||"")}</textarea></label>
    </section>

    <section class="card"><h3>Conclusion</h3>
      <div class="grid2">
        ${R("species","Species","Zoisite")}
        ${R("variety","Variety","Tanzanite")}
        <label class="f">Natural, synthetic or simulant<select data-g="result" data-f="origin" id="r-origin">
          ${["","Natural","Laboratory-grown (synthetic)","Simulant","Composite / assembled"].map(o=>`<option ${e.result.origin===o?"selected":""}>${o}</option>`).join("")}</select></label>
        ${R("treatment","Treatment","Heated (typical for this gem)")}
        ${R("colour","Colour","Violetish blue")}
        ${R("shapeCut","Shape and cut","Oval mixed cut")}
      </div>
      <label class="f">Comments for the report<textarea data-g="result" data-f="comments" id="r-comments">${esc(e.result.comments||"")}</textarea></label>
      ${hasVal?`<div class="grid2">
        <label class="f">Replacement value (ZAR)<input data-g="valuation" data-f="amount" id="v-amount" inputmode="decimal" class="mono" value="${esc(e.valuation.amount||"")}"></label>
        <label class="f">Basis of valuation<input data-g="valuation" data-f="basis" id="v-basis" placeholder="Retail replacement, USD/ZAR 17.80, wholesale price guide" value="${esc(e.valuation.basis||"")}"></label>
      </div>`:""}
      <div class="row"><button class="btn primary" id="saveNotes" ${e.dirty?"":"disabled"}>Save results</button>
        ${j.status==="received"?`<button class="btn" id="toTesting">Mark as testing</button>`:""}
        ${j.status!=="reported"?`<button class="btn ok" id="issue">Issue report</button>`:`<span class="muted small">Report issued ${fmtDate(j.reportIssuedAt)}</span>`}
      </div>
    </section>

    <section class="card" id="paySec"><h3>Payment</h3>
      <div class="total"><span>Amount due</span><span class="mono">${money(total)}</span></div>
      ${j.payment.paid ? `<p style="margin:0">Paid ${fmtDT(j.payment.paidAt)} by ${esc(j.payment.method)}${j.payment.ref?` · ref <span class="mono">${esc(j.payment.ref)}</span>`:""}. Receipt <span class="mono">${esc(j.payment.receiptNo)}</span>.</p>` : `
        ${settings.payLink?`<div class="row"><a class="btn primary" href="${esc(settings.payLink)}" target="_blank" rel="noopener">Open Pay Now link</a><span class="muted small">Show the client, or send the message below.</span></div><div id="payQr"></div>`:`<p class="muted small" style="margin:0">Add your Yoco, PayFast or SnapScan payment link under Settings to show a Pay Now button and QR code here.</p>`}
        <div class="copybox">${esc(payMessage(j,total))}</div>
        <div class="row"><button class="btn sm" id="copyPay">Copy payment message</button>
          ${j.client.phone?`<a class="btn sm ghost" target="_blank" rel="noopener" href="${esc(waLink(j.client.phone,payMessage(j,total)))}">WhatsApp</a>`:""}
          ${j.client.email?`<a class="btn sm ghost" href="${esc(mailto(j.client.email,`Payment request ${j.reportNo}`,payMessage(j,total)))}">Email</a>`:""}</div>
        ${e.confirmPaid?`<div class="confirm">
          <b>Record payment of ${money(total)}?</b>
          <div class="grid2"><label class="f">Method<select id="pMethod">${["Pay Now link","EFT","Card","Cash","SnapScan"].map(m=>`<option ${e.pay.method===m?"selected":""}>${m}</option>`).join("")}</select></label>
          <label class="f">Payment reference<input id="pRef" value="${esc(e.pay.ref)}" class="mono"></label></div>
          <div class="row"><button class="btn ok" id="pConfirm">Yes, record payment</button><button class="btn ghost" id="pCancel">Cancel</button></div>
        </div>`:`<div class="row"><button class="btn ok" id="markPaid">Mark as paid</button></div>`}`}
    </section>

    ${j.payment.paid?`<section class="card"><h3>Receipt</h3>
      <div class="copybox">${esc(receiptText(j,total))}</div>
      <div class="row"><button class="btn sm" id="copyRcpt">Copy receipt</button>
        ${j.client.email?`<a class="btn sm primary" href="${esc(mailto(j.client.email,`Receipt ${j.payment.receiptNo} — ${settings.businessName}`,receiptText(j,total)))}">Email receipt</a>`:""}
        ${j.client.phone?`<a class="btn sm ghost" target="_blank" rel="noopener" href="${esc(waLink(j.client.phone,receiptText(j,total)))}">WhatsApp receipt</a>`:""}</div>
    </section>`:""}

    <section class="card"><h3>Report</h3>
      ${reportPreview(j)}
      <div class="row"><button class="btn primary" id="dlReport" ${j.status==="reported"?"":"disabled"}>Report PDF</button>
        ${j.status==="reported" && j.client.email?`<a class="btn ghost" href="${esc(mailto(j.client.email,`Your gemstone report ${j.reportNo} — ${settings.businessName}`,reportEmail(j)))}">Email client</a>`:""}
        <span class="muted small">${j.status==="reported"?"Share it to email or WhatsApp, or save and print.":"Issue the report first."}</span></div>
      ${j.status==="reported"?`<div class="row small"><span class="muted">Public check:</span><a href="${esc(verifyLink(j))}" target="_blank" rel="noopener">${esc(verifyLink(j))}</a></div>`:""}
    </section>

    ${j.status==="reported"?`<section class="card"><h3>Re-test / re-valuation reminder</h3>
      <div class="row"><label class="f" style="max-width:220px">Reminder due<input type="date" id="remDate" value="${esc(e.remindDate)}"></label>
        <button class="btn sm" id="remSave">Save date</button><button class="btn sm ghost" id="remClear">No reminder</button></div>
      <span class="muted small">${j.reminderSentAt?`Last reminded ${fmtDate(j.reminderSentAt)} (${j.reminderCount}×).`:"Not reminded yet."} Due reminders appear under the Reminders tab 60 days ahead.</span>
    </section>`:""}

    ${supervisor?`<section class="card"><h3>Supervisor</h3>
      ${e.renumber?`<div class="confirm">
        <div class="grid2"><label class="f">New report number<input id="rnNo" class="mono" value="${esc(j.reportNo)}"></label>
        <label class="f">Reason (kept in the override log)<input id="rnWhy"></label></div>
        <div class="row"><button class="btn primary" id="rnGo">Change number</button><button class="btn ghost" id="rnCancel">Cancel</button></div></div>`:
      e.confirmDelete?`<div class="confirm danger"><b>Delete ${esc(j.reportNo)} and all its photos? This cannot be undone.</b>
        <div class="row"><button class="btn danger" id="delGo">Yes, delete this job</button><button class="btn ghost" id="delCancel">Cancel</button></div></div>`:
      `<div class="row"><button class="btn sm" id="rnOpen">Change report number</button><button class="btn sm danger" id="delOpen">Delete job</button></div>`}
    </section>`:""}
  </div>`;

  $("#back").onclick=()=>{ view={tab:"jobs",jobId:null}; jobEdit=null; render(); };
  app.querySelectorAll("[data-g]").forEach(el=>{
    const h=()=>{ e[el.dataset.g][el.dataset.f]=el.value; if(!e.dirty){ e.dirty=true; $("#saveNotes").disabled=false; } };
    el.addEventListener("input",h); el.addEventListener("change",h);
  });
  const saveResults=async(extra={})=>{ await patchJob(j.id,{tests:e.tests, result:e.result, valuation:e.valuation, ...extra}); e.dirty=false; };
  $("#saveNotes").onclick=async()=>{ try{ await saveResults(); toast("Results saved"); jobEdit=null; render(); }catch(x){ toast(errMsg(x)); } };
  const tt=$("#toTesting"); if(tt) tt.onclick=async()=>{ try{ await saveResults({status:"testing"}); jobEdit=null; toast("Marked as testing"); render(); }catch(x){ toast(errMsg(x)); } };
  const is=$("#issue"); if(is) is.onclick=async()=>{
    if(!e.result.variety && !e.result.species){ toast("Add the species or variety before issuing the report."); return; }
    is.disabled=true;
    try{
      let nj=await patchJob(j.id,{tests:e.tests, result:e.result, valuation:e.valuation, status:"reported"});
      if(nj.photos[0]){
        try{
          await ensureSigned([nj.photos[0]]);
          const b=await (await fetch(src(nj.photos[0]))).blob();
          const url=await uploadPublic(`reports/${nj.reportNo}-${nj.verifyCode}.jpg`, b, "image/jpeg");
          nj=await patchJob(j.id,{public_photo:url});
        }catch(px){ console.warn(px); }
      }
      jobEdit=null; toast("Report issued"); render();
    }catch(x){ is.disabled=false; toast(errMsg(x)); }
  };
  const addMicro=async files=>{
    const cap=$("#mCap").value.trim(); const list=[...(j.micrographs||[])];
    for(const f of files){
      try{ toast("Saving micrograph…"); const blob=await resizeImage(f,2600);
        const path=`jobs/${j.id}/micro-${Date.now()}.jpg`; await uploadPrivate(path,blob,"image/jpeg");
        list.push({path, caption:cap, at:new Date().toISOString()}); }
      catch(err){ toast(errMsg(err)); }
    }
    try{ await patchJob(j.id,{micrographs:list}); toast("Micrograph saved to this job"); render(); }catch(x){ toast(errMsg(x)); }
  };
  $("#mCam").onchange=ev=>addMicro([...ev.target.files]);
  $("#mFile").onchange=ev=>addMicro([...ev.target.files]);
  const cp=$("#copyPay"); if(cp) cp.onclick=()=>copyText(payMessage(j,total));
  const cr=$("#copyRcpt"); if(cr) cr.onclick=()=>copyText(receiptText(j,total));
  const mp=$("#markPaid"); if(mp) mp.onclick=()=>{ e.confirmPaid=true; renderJob(app,j); $("#paySec").scrollIntoView({block:"nearest"}); };
  const pc=$("#pCancel"); if(pc) pc.onclick=()=>{ e.confirmPaid=false; renderJob(app,j); };
  const pm=$("#pMethod"); if(pm) pm.onchange=()=>e.pay.method=pm.value;
  const pr=$("#pRef"); if(pr) pr.oninput=()=>e.pay.ref=pr.value;
  const pk=$("#pConfirm"); if(pk) pk.onclick=async()=>{
    pk.disabled=true;
    try{ await patchJob(j.id,{paid:true, paid_at:new Date().toISOString(), pay_method:e.pay.method, pay_ref:e.pay.ref.trim()||null, amount_paid:total, receipt_no:receiptFor(j.reportNo)});
      jobEdit=null; toast("Payment recorded in the ledger"); render(); }
    catch(x){ pk.disabled=false; toast(errMsg(x)); }
  };
  if(settings.payLink && !j.payment.paid && window.QRCode && $("#payQr")){ try{ new QRCode($("#payQr"),{text:settings.payLink,width:132,height:132,colorDark:"#1c1d2b",colorLight:"#ffffff"}); }catch(x){} }
  const rq=$("#rQr"); if(rq && window.QRCode && j.status==="reported"){ try{ new QRCode(rq,{text:verifyLink(j),width:84,height:84,colorDark:"#1c1d2b",colorLight:"#ffffff"}); }catch(x){} }
  $("#dlReport").onclick=ev=>makePdf(ev.target, ()=>reportPdf(j), `${j.reportNo} Identification Report.pdf`, `Gemstone report ${j.reportNo}`, reportEmail(j));
  $("#pdfTakeIn").onclick=ev=>makePdf(ev.target, ()=>takeInPdf(j), `${j.reportNo} Take-in Receipt.pdf`, `Take-in receipt ${j.reportNo}`, takeInEmail(j));
  const rd=$("#remDate"); if(rd) rd.onchange=()=>e.remindDate=rd.value;
  const rs=$("#remSave"); if(rs) rs.onclick=async()=>{ try{ await patchJob(j.id,{reminder_due:e.remindDate||null}); jobEdit=null; toast("Reminder date saved"); render(); }catch(x){ toast(errMsg(x)); } };
  const rc=$("#remClear"); if(rc) rc.onclick=async()=>{ try{ await patchJob(j.id,{reminder_due:null}); jobEdit=null; toast("Reminder removed"); render(); }catch(x){ toast(errMsg(x)); } };
  const ro=$("#rnOpen"); if(ro) ro.onclick=()=>{ e.renumber=true; renderJob(app,j); };
  const rcn=$("#rnCancel"); if(rcn) rcn.onclick=()=>{ e.renumber=false; renderJob(app,j); };
  const rg=$("#rnGo"); if(rg) rg.onclick=async()=>{
    const nn=$("#rnNo").value.trim(), why=$("#rnWhy").value.trim();
    if(why.length<5){ toast("Give a reason of at least 5 characters."); return; }
    try{ const {error}=await sb.rpc("supervisor_renumber",{p_table:"lab_jobs",p_record_id:j.id,p_new_number:nn,p_reason:why}); if(error) throw error;
      await loadJobs(); jobEdit=null; toast("Report number changed"); render(); }
    catch(x){ toast(errMsg(x)); }
  };
  const dop=$("#delOpen"); if(dop) dop.onclick=()=>{ e.confirmDelete=true; renderJob(app,j); };
  const dc=$("#delCancel"); if(dc) dc.onclick=()=>{ e.confirmDelete=false; renderJob(app,j); };
  const dg=$("#delGo"); if(dg) dg.onclick=async()=>{
    dg.disabled=true;
    try{
      const {error}=await sb.from("lab_jobs").delete().eq("id",j.id); if(error) throw error;
      const paths=[...j.photos, j.consent.signature, ...(j.micrographs||[]).map(m=>m.path)].filter(Boolean);
      if(paths.length) await sb.storage.from(PRIV).remove(paths);
      if(j.publicPhoto) await sb.storage.from(PUB).remove([`reports/${j.reportNo}-${j.verifyCode}.jpg`]);
      jobs=jobs.filter(x=>x.id!==j.id); view={tab:"jobs",jobId:null}; jobEdit=null; toast(`${j.reportNo} deleted`); render();
    }catch(x){ dg.disabled=false; toast(errMsg(x)); }
  };
}

function payMessage(j,total){
  return `Hi ${j.client.name},

Thank you for bringing your ${j.item.description||"item"} to ${settings.businessName}.
Report number: ${j.reportNo}
Amount due: ${money(total)}
${settings.payLink?`\nPay now: ${settings.payLink}\nPlease use ${j.reportNo} as your payment reference.\n`:""}${settings.bank?`\nEFT details:\n${settings.bank}\nReference: ${j.reportNo}\n`:""}
Your report is released once payment is received.

${settings.gemmologist}
${settings.businessName} · ${settings.phone} · ${settings.email}`;
}
function receiptText(j,total){
  const p=j.payment;
  const lines=(j.services||[]).map(s=>`  ${s.label} x${s.qty}  ${money(s.price*s.qty)}`).join("\n");
  return `RECEIPT ${p.receiptNo}
${settings.businessName} (${settings.parent})
Date paid: ${fmtDT(p.paidAt)}

Client: ${j.client.name}${j.client.ref?` (${j.client.ref})`:""}
Report number: ${j.reportNo}
Item: ${j.item.description||""}

${lines}${j.walkIn?"\n  Walk-in surcharge +50%":""}
  ------------------------------
  TOTAL PAID  ${money(total)}
  Method: ${p.method}${p.ref?`  Ref: ${p.ref}`:""}

${settings.businessName} is not VAT registered; no VAT is charged.
Thank you. ${settings.gemmologist} · ${settings.phone} · ${settings.email}`;
}
function takeInEmail(j){
  return `Dear ${j.client.name},

Thank you for bringing your ${j.item.description||"item"} to ${settings.businessName}.

Attached is your take-in receipt and signed consent. Your report number is ${j.reportNo}${j.client.ref?` and your client reference is ${j.client.ref}`:""}. Please quote it when you contact us about your item.

Amount due: ${money(j.total||jobTotal(j))}${settings.payLink?`\nPay now: ${settings.payLink} (reference ${j.reportNo})`:""}

Kind regards
${settings.gemmologist}
${settings.credentials}
${settings.businessName} · ${settings.phone} · ${settings.email}`;
}
function reportEmail(j){
  return `Dear ${j.client.name},

Your gemmological report is ready. Attached is report ${j.reportNo} for your ${j.item.description||"item"}.

Conclusion: ${conclusionLine(j)}

Anyone can check this report is authentic here:
${verifyLink(j)}
(report number ${j.reportNo}, verification code ${j.verifyCode})
${j.payment.paid?"":`\nAmount due before collection: ${money(j.total||jobTotal(j))}${settings.payLink?`\nPay now: ${settings.payLink}`:""}\n`}
Kind regards
${settings.gemmologist}
${settings.credentials}
${settings.businessName} · ${settings.phone} · ${settings.email}`;
}
function reminderText(j){
  const val=(j.services||[]).some(s=>VAL_SERVICES.includes(s.id));
  return `Dear ${j.client.name},

On ${fmtDate(j.reportIssuedAt)} ${settings.businessName} ${val?"identified and valued":"identified"} your ${j.item.description||"gemstone"} (report ${j.reportNo}).

Gemstone and precious-metal prices change over time${val?", so your insurance value may now be out of date":""}. We recommend a re-${val?"valuation":"test"} every ${settings.remindMonths||24} months to keep your records and insurance cover accurate.

Reply to this message to book a time that suits you.

Kind regards
${settings.gemmologist}
${settings.businessName} · ${settings.phone} · ${settings.email}`;
}

/* ================= report pieces ================= */
function reportRows(j){
  const r=j.result||{}, t=j.tests||{}, it=j.item||{};
  return [
    ["Item", it.setting==="mounted"?"Mounted stone":"Loose stone"],
    ["Weight", t.weight ? `${t.weight} ct${it.setting==="mounted"?" (estimated)":""}` : (it.estWeight?`${it.estWeight} ct (at take-in)`:"")],
    ["Measurements", t.measurements || (it.measurements?it.measurements+" mm":"")],
    ["Shape and cut", r.shapeCut || it.shape],
    ["Colour", r.colour || it.colour],
    ["Species", r.species],
    ["Variety", r.variety],
    ["Treatment", r.treatment],
    ["Refractive index", t.ri],
    ["Birefringence", t.biref],
    ["Optic character", t.optic],
    ["Specific gravity", t.sg],
    ["Pleochroism", t.pleo],
    ["Polariscope", t.polariscope],
    ["UV fluorescence", t.uv],
    ["Spectroscope", t.spectro],
    ["Chelsea filter", t.filter],
    ["Other tests", t.other],
    ["Magnification", t.magnification],
    ["Comments", r.comments]
  ].filter(x=>x[1]);
}
function conclusionLine(j){
  const r=j.result||{};
  const parts=[r.origin, r.variety||r.species].filter(Boolean);
  return parts.length ? parts.join(" ") + (r.species&&r.variety?` (${r.species})`:"") : "Pending";
}
function reportPreview(j){
  const ph=src(j.photos[0]);
  return `<div class="report">
    <div class="rh"><div class="row" style="gap:10px">${settings.logo?`<img src="${esc(settings.logo)}" alt="">`:""}<div><div class="bn">${esc(settings.businessName)}</div><div class="sub">Gemmological Identification Report</div></div></div>
      <div style="text-align:right"><div class="mono" style="font-size:1rem;font-weight:500">${esc(j.reportNo)}</div><div class="mono" style="font-size:.75rem;color:#5f6178">Verification code ${esc(j.verifyCode)}</div></div></div>
    <div class="concl"><b>Conclusion:</b> ${esc(conclusionLine(j))}</div>
    <div class="body"><dl>${reportRows(j).map(([k,v])=>`<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}
      ${j.valuation.amount?`<dt>Replacement value</dt><dd>${money(j.valuation.amount)}</dd>`:""}</dl>
      ${ph?`<img src="${esc(ph)}" alt="Photo of the stone">`:""}</div>
    <div class="foot"><div style="color:#1c1d2b"><b>${esc(settings.gemmologist)}</b><br>${esc(settings.credentials)}</div>
      <div id="rQr"></div>
      <div style="max-width:320px">This report is the professional opinion of ${esc(settings.businessName)} based on the tests available at the time of examination. It is not a GIA laboratory report.</div></div>
  </div>`;
}

/* ================= branded PDFs ================= */
const INK=[28,29,43], MUTE=[95,97,120], BR=[75,63,176], LAV=[235,233,250], HAIR=[220,222,234];
async function loadImg(ref){
  if(!ref) return null;
  try{
    if(!isUrl(ref)) await ensureSigned([ref]);
    const u=src(ref); if(!u) return null;
    const r=await fetch(u); if(!r.ok) return null;
    const b=await r.blob();
    const data=await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(b); });
    const im=await new Promise((res,rej)=>{ const i=new Image(); i.onload=()=>res(i); i.onerror=rej; i.src=data; });
    return {data, w:im.naturalWidth, h:im.naturalHeight, fmt:/png/i.test(b.type)?"PNG":"JPEG"};
  }catch(e){ return null; }
}
function fitImg(d,img,x,y,bw,bh,border=true){
  if(!img) return;
  const s=Math.min(bw/img.w,bh/img.h), w=img.w*s, h=img.h*s, ox=x+(bw-w)/2, oy=y+(bh-h)/2;
  d.addImage(img.data,img.fmt,ox,oy,w,h);
  if(border){ d.setDrawColor(...HAIR); d.setLineWidth(0.25); d.rect(ox,oy,w,h); }
}
async function pdfBase(title,j,dateLine){
  if(!window.jspdf) throw new Error("The PDF tool did not load. Check your connection and reload the app.");
  const doc=new window.jspdf.jsPDF({unit:"mm",format:"a4"});
  const ctx={doc,W:210,M:16,y:0,title,j,dateLine,logo:await loadImg(settings.logo)};
  pdfHeader(ctx); return ctx;
}
function pdfHeader(ctx){
  const {doc:d,W,M}=ctx;
  d.setFillColor(...BR); d.rect(0,0,W,32,"F");
  d.setFillColor(169,156,255); d.rect(0,32,W,1.2,"F");
  let tx=M;
  if(ctx.logo){ d.setFillColor(255,255,255); d.roundedRect(M,6,21,21,2,2,"F"); fitImg(d,ctx.logo,M+1.5,7.5,18,18,false); tx=M+26; }
  d.setTextColor(255,255,255);
  d.setFont("times","bold"); d.setFontSize(21); d.text(settings.businessName,tx,15.5);
  d.setFont("helvetica","bold"); d.setFontSize(7.5); d.text(ctx.title.toUpperCase(),tx,21.5,{charSpace:0.7});
  d.setFont("helvetica","normal"); d.setFontSize(7.5); d.text(`${settings.parent}  ·  ${settings.credentials}`,tx,26.5);
  d.setFont("courier","bold"); d.setFontSize(12.5); d.text(ctx.j.reportNo,W-M,15.5,{align:"right"});
  d.setFont("helvetica","normal"); d.setFontSize(8); d.text(ctx.dateLine||"",W-M,21.5,{align:"right"});
  d.setFont("courier","normal"); d.setFontSize(7.5); d.text(`Verification code ${ctx.j.verifyCode}`,W-M,26.5,{align:"right"});
  d.setTextColor(...INK); ctx.y=43;
}
function pdfFooters(ctx){
  const {doc:d,W,M}=ctx, n=d.getNumberOfPages();
  for(let i=1;i<=n;i++){
    d.setPage(i);
    d.setDrawColor(...BR); d.setLineWidth(0.4); d.line(M,283,W-M,283);
    d.setFont("helvetica","normal"); d.setFontSize(7.5); d.setTextColor(...MUTE);
    d.text(`${settings.businessName}  ·  ${settings.gemmologist}  ·  ${settings.phone}  ·  ${settings.email}${settings.address?"  ·  "+settings.address:""}`,M,288);
    d.text(`Page ${i} of ${n}`,W-M,288,{align:"right"});
  }
}
function need(ctx,h){ if(ctx.y+h>277){ ctx.doc.addPage(); pdfHeader(ctx); } }
function secTitle(ctx,t){
  need(ctx,16); const d=ctx.doc;
  d.setFont("helvetica","bold"); d.setFontSize(8); d.setTextColor(...BR); d.text(t.toUpperCase(),ctx.M,ctx.y,{charSpace:0.6});
  d.setDrawColor(...HAIR); d.setLineWidth(0.25); d.line(ctx.M,ctx.y+2,ctx.W-ctx.M,ctx.y+2);
  d.setTextColor(...INK); ctx.y+=8;
}
function kv(ctx,rows,x,w,lw=42){
  const d=ctx.doc;
  for(const [k,v] of rows){
    d.setFont("helvetica","bold"); d.setFontSize(9.5);
    const lines=d.splitTextToSize(String(v),w-lw), h=lines.length*4.2+1.3;
    need(ctx,h);
    d.setFont("helvetica","normal"); d.setFontSize(8.5); d.setTextColor(...MUTE); d.text(String(k),x,ctx.y);
    d.setFont("helvetica","bold"); d.setFontSize(9.5); d.setTextColor(...INK); d.text(lines,x+lw,ctx.y);
    ctx.y+=h;
  }
}
function para(ctx,text,{size=8.8,color=INK,indent=0,bold=false}={}){
  const d=ctx.doc; d.setFont("helvetica",bold?"bold":"normal"); d.setFontSize(size); d.setTextColor(...color);
  const lines=d.splitTextToSize(text,ctx.W-2*ctx.M-indent), lh=size*0.43;
  for(const ln of lines){ need(ctx,lh); d.text(ln,ctx.M+indent,ctx.y); ctx.y+=lh; }
  ctx.y+=1.6; d.setTextColor(...INK);
}
function svcTable(ctx,j){
  const d=ctx.doc, {M,W}=ctx, xr=W-M;
  d.setFont("helvetica","bold"); d.setFontSize(7.5); d.setTextColor(...MUTE);
  d.text("SERVICE",M,ctx.y); d.text("QTY",xr-38,ctx.y,{align:"right"}); d.text("AMOUNT",xr,ctx.y,{align:"right"}); ctx.y+=5;
  d.setFont("helvetica","normal"); d.setFontSize(9.5); d.setTextColor(...INK);
  for(const s of (j.services||[])){
    need(ctx,7);
    d.text(d.splitTextToSize(s.label,W-2*M-50)[0],M,ctx.y); d.text(String(s.qty),xr-38,ctx.y,{align:"right"}); d.text(money(s.price*s.qty),xr,ctx.y,{align:"right"});
    d.setDrawColor(...HAIR); d.setLineWidth(0.2); d.line(M,ctx.y+2,xr,ctx.y+2); ctx.y+=6.5;
  }
  if(j.walkIn){ d.setTextColor(...MUTE); d.text("Walk-in without appointment (+50%)",M,ctx.y); ctx.y+=6.5; d.setTextColor(...INK); }
  need(ctx,10);
  d.setFillColor(...LAV); d.rect(M,ctx.y-4.5,W-2*M,9,"F");
  d.setFont("helvetica","bold"); d.setFontSize(10.5); d.text("Total",M+3,ctx.y+1.3); d.text(money(j.total||jobTotal(j)),xr-3,ctx.y+1.3,{align:"right"});
  ctx.y+=8;
  d.setFont("helvetica","normal"); d.setFontSize(7.5); d.setTextColor(...MUTE);
  d.text(`${settings.businessName} is not VAT registered; no VAT is charged.  Payment: ${j.payment.paid?"received "+fmtDate(j.payment.paidAt)+" ("+j.payment.method+")":"due before the report is released"}.`,M,ctx.y);
  ctx.y+=7; d.setTextColor(...INK);
}
function qrData(j){
  if(!window.QRCode) return "";
  const tmp=document.createElement("div");
  try{ new QRCode(tmp,{text:verifyLink(j),width:240,height:240,correctLevel:QRCode.CorrectLevel.M}); const c=tmp.querySelector("canvas"); return c?c.toDataURL("image/png"):""; }catch(e){ return ""; }
}
async function takeInPdf(j){
  const ctx=await pdfBase("Take-in receipt and consent",j,"Received "+fmtDT(j.createdAt));
  const d=ctx.doc, {M,W}=ctx, it=j.item||{}, c=j.client;
  secTitle(ctx,"Client");
  kv(ctx,[["Name",c.name],["Client reference",c.ref],["Phone",c.phone],["Email",c.email]].filter(r=>r[1]),M,W-2*M);
  ctx.y+=3;
  secTitle(ctx,"Item received");
  const imgs=[]; for(const p of (j.photos||[]).slice(0,3)) imgs.push(await loadImg(p));
  const shown=imgs.filter(Boolean);
  if(shown.length){ need(ctx,56); shown.forEach((im,i)=>fitImg(d,im,M+i*58,ctx.y-2,54,54)); ctx.y+=57; }
  kv(ctx,[["Description",it.description],["Loose or mounted",it.setting==="mounted"?"Mounted in jewellery":"Loose stone"],["Client says it is",it.statedId],
    ["Weight at take-in",it.estWeight?it.estWeight+" ct":""],["Colour",it.colour],["Shape and cut",it.shape],["Measurements",it.measurements?it.measurements+" mm":""],
    ["Condition at take-in",it.condition||"No visible damage recorded"]].filter(r=>r[1]),M,W-2*M);
  ctx.y+=3;
  secTitle(ctx,"Services requested");
  svcTable(ctx,j);
  secTitle(ctx,"Permission to test and waiver");
  const cp=consentParts(j.consent.signedName||c.name);
  cp.intro.forEach(p=>para(ctx,p));
  cp.items.forEach((x,i)=>{ need(ctx,8); d.setFont("helvetica","bold"); d.setFontSize(8.8); d.setTextColor(...BR); d.text(`${i+1}.`,M,ctx.y); para(ctx,x,{indent:6}); });
  ctx.y+=2;
  need(ctx,44);
  secTitle(ctx,"Signatures");
  const sig=await loadImg(j.consent.signature);
  const y0=ctx.y;
  d.setDrawColor(...HAIR); d.setLineWidth(0.25); d.rect(M,y0,80,26);
  if(sig) fitImg(d,sig,M+1,y0+1,78,24,false);
  d.setFont("helvetica","bold"); d.setFontSize(9.5); d.setTextColor(...INK); d.text(j.consent.signedName||c.name||"",M,y0+31);
  d.setFont("helvetica","normal"); d.setFontSize(8); d.setTextColor(...MUTE); d.text(`Client · signed ${fmtDT(j.consent.signedAt)} · ${j.consent.version||""}`,M,y0+35.5);
  d.setTextColor(...INK); d.setDrawColor(...INK); d.line(W-M-70,y0+24,W-M,y0+24);
  d.setFont("helvetica","bold"); d.setFontSize(9.5); d.text(settings.gemmologist,W-M-70,y0+31);
  d.setFont("helvetica","normal"); d.setFontSize(8); d.setTextColor(...MUTE); d.text(`Received for ${settings.businessName}`,W-M-70,y0+35.5);
  ctx.y=y0+43;
  para(ctx,`Keep this receipt. Quote report number ${j.reportNo} when you enquire about or collect your item.`,{size:8,color:MUTE});
  pdfFooters(ctx); return d;
}
async function reportPdf(j){
  const ctx=await pdfBase("Gemmological identification report",j,"Issued "+fmtDate(j.reportIssuedAt||j.updatedAt));
  const d=ctx.doc, {M,W}=ctx;
  d.setFillColor(...LAV); d.roundedRect(M,ctx.y-5,W-2*M,19,1.5,1.5,"F");
  d.setFont("helvetica","bold"); d.setFontSize(7.5); d.setTextColor(...BR); d.text("CONCLUSION",M+5,ctx.y+0.5,{charSpace:0.6});
  d.setFont("times","bold"); d.setFontSize(16); d.setTextColor(...INK); d.text(d.splitTextToSize(conclusionLine(j),W-2*M-10)[0],M+5,ctx.y+8.5);
  ctx.y+=22;
  const rows=reportRows(j);
  const photo=await loadImg(j.photos[0]);
  const top=ctx.y, pw=60;
  secTitle(ctx,"Results");
  const colW=photo ? W-2*M-pw-8 : W-2*M;
  const qr=qrData(j);
  let signed=false;
  if(photo){
    const x=W-M-pw; fitImg(d,photo,x,top+6,pw,pw);
    let sy=top+pw+14;
    if(qr){ d.addImage(qr,"PNG",x,sy,24,24);
      d.setFont("helvetica","normal"); d.setFontSize(7); d.setTextColor(...MUTE);
      d.text(["Scan to verify","this report.","",`Code ${j.verifyCode}`],x+27,sy+5); sy+=32; }
    d.setDrawColor(...INK); d.setLineWidth(0.3); d.line(x,sy+12,x+pw,sy+12);
    d.setFont("helvetica","bold"); d.setFontSize(9.5); d.setTextColor(...INK); d.text(settings.gemmologist,x,sy+17);
    d.setFont("helvetica","normal"); d.setFontSize(7.5); d.setTextColor(...MUTE);
    const cl=d.splitTextToSize(settings.credentials.replace(" · ","\n"),pw); d.text(cl,x,sy+21);
    d.setTextColor(...INK);
    signed=sy+21+cl.length*3.3;
  }
  kv(ctx,rows,M,colW,40);
  if(j.valuation.amount){
    ctx.y+=3; need(ctx,24);
    d.setFont("helvetica","bold"); d.setFontSize(8); d.setTextColor(...BR); d.text("INSURANCE VALUATION",M,ctx.y,{charSpace:0.6});
    d.setDrawColor(...HAIR); d.setLineWidth(0.25); d.line(M,ctx.y+2,M+colW,ctx.y+2); d.setTextColor(...INK); ctx.y+=8;
    kv(ctx,[["Replacement value",money(j.valuation.amount)],["Basis of valuation",j.valuation.basis||"Current retail replacement value"],["Valuation date",fmtDate(j.reportIssuedAt||j.updatedAt)]],M,colW,40);
  }
  if(signed && d.getNumberOfPages()===1) ctx.y=Math.max(ctx.y,signed+6);
  const micros=[]; for(const m of (j.micrographs||[]).slice(0,4)){ const im=await loadImg(m.path); if(im) micros.push({im,cap:m.caption}); }
  if(micros.length){
    ctx.y+=3; secTitle(ctx,"Micrographs"); need(ctx,48);
    const bw=34;
    micros.forEach((m,i)=>{ const x=M+i*(bw+4); fitImg(d,m.im,x,ctx.y-2,bw,bw);
      d.setFont("helvetica","normal"); d.setFontSize(7); d.setTextColor(...MUTE); d.text(d.splitTextToSize(m.cap||"",bw).slice(0,2),x,ctx.y+bw+2); });
    d.setTextColor(...INK); ctx.y+=bw+9;
  }
  if(!signed){
    ctx.y+=4; need(ctx,46);
    const y0=ctx.y;
    d.setDrawColor(...INK); d.setLineWidth(0.3); d.line(M,y0+16,M+72,y0+16);
    d.setFont("helvetica","bold"); d.setFontSize(10); d.setTextColor(...INK); d.text(settings.gemmologist,M,y0+22);
    d.setFont("helvetica","normal"); d.setFontSize(8); d.setTextColor(...MUTE); d.text(d.splitTextToSize(settings.credentials,90),M,y0+26.5);
    if(qr){ d.addImage(qr,"PNG",W-M-30,y0,30,30); d.setFontSize(7); d.text("Scan to verify",W-M-15,y0+34,{align:"center"}); }
    ctx.y=y0+40;
  } else ctx.y+=2;
  para(ctx,`This report is the professional opinion of ${settings.businessName}, based on the tests available at the time of examination. It describes the item as submitted and is not a GIA laboratory report or a guarantee. The carat weight of a mounted stone is estimated.${j.valuation.amount?" Re-valuation is recommended every "+(settings.remindMonths||24)+" months, or sooner if metal prices or exchange rates change sharply.":""} Verify this report at ${verifyLink(j)}`,{size:7.6,color:MUTE});
  pdfFooters(ctx); return d;
}
async function makePdf(btn, build, filename, title, text){
  const label=btn.textContent; btn.disabled=true; btn.textContent="Preparing PDF…";
  try{
    const doc=await build();
    const how=await shareOrDownload(doc.output("blob"), filename, title, text);
    if(how==="downloaded") toast("PDF saved to Downloads. Attach it to your email.");
  }catch(e){ toast(errMsg(e)); }
  finally{ btn.disabled=false; btn.textContent=label; }
}

/* ================= reminders ================= */
function renderReminders(app){
  const list=dueReminders(), today=todayISO();
  const upcoming=jobs.filter(j=>j.status==="reported" && j.reminderDue && !list.includes(j)).sort((a,b)=>a.reminderDue.localeCompare(b.reminderDue)).slice(0,10);
  app.innerHTML=`<div class="stack">
    <div class="row" style="justify-content:space-between"><h2>Reminders</h2><span class="muted small">Re-test / re-valuation every ${esc(settings.remindMonths||24)} months</span></div>
    ${list.length?list.map(j=>{
      const over=j.reminderDue<today;
      return `<div class="remind">
        <div class="row" style="justify-content:space-between"><div><b>${esc(j.client.name)}</b>${j.client.ref?` <span class="mono small muted">${esc(j.client.ref)}</span>`:""}<br>
          <span class="small muted">${esc(j.item.description||"")} · <span class="mono">${esc(j.reportNo)}</span> · issued ${fmtDate(j.reportIssuedAt)}</span></div>
          <span class="chip ${over?"bad":"warn"}">${over?"Overdue":"Due"} ${fmtDate(j.reminderDue)}</span></div>
        <div class="row">
          ${j.client.phone?`<a class="btn sm primary" target="_blank" rel="noopener" href="${esc(waLink(j.client.phone,reminderText(j)))}" data-sent="${esc(j.id)}">WhatsApp</a>`:""}
          ${j.client.email?`<a class="btn sm" href="${esc(mailto(j.client.email,`Time to re-check your gemstone — ${settings.businessName}`,reminderText(j)))}" data-sent="${esc(j.id)}">Email</a>`:""}
          <button class="btn sm ghost" data-done="${esc(j.id)}">Mark reminded</button>
          <button class="btn sm ghost" data-open="${esc(j.id)}">Open job</button>
        </div></div>`;}).join(""):`<div class="empty"><b>No reminders due</b><span>Clients appear here 60 days before their re-test or re-valuation date. Dates are set automatically when you issue a report.</span></div>`}
    ${upcoming.length?`<section class="card"><h3>Coming up</h3><div class="tablewrap"><table><thead><tr><th>Due</th><th>Client</th><th>Report</th></tr></thead><tbody>
      ${upcoming.map(j=>`<tr data-open="${esc(j.id)}" style="cursor:pointer"><td>${fmtDate(j.reminderDue)}</td><td>${esc(j.client.name)}</td><td class="mono">${esc(j.reportNo)}</td></tr>`).join("")}</tbody></table></div></section>`:""}
  </div>`;
  const mark=async id=>{ const j=jobs.find(x=>x.id===id); if(!j) return;
    try{ await patchJob(id,{reminder_sent_at:new Date().toISOString(), reminder_count:(j.reminderCount||0)+1}); toast("Marked as reminded"); render(); }catch(x){ toast(errMsg(x)); } };
  app.querySelectorAll("[data-done]").forEach(b=>b.onclick=()=>mark(b.dataset.done));
  app.querySelectorAll("[data-sent]").forEach(a=>a.addEventListener("click",()=>setTimeout(()=>mark(a.dataset.sent),800)));
  app.querySelectorAll("[data-open]").forEach(b=>b.onclick=()=>openJob(b.dataset.open));
}

/* ================= ledger ================= */
function renderLedger(app){
  const paid=jobs.filter(j=>j.payment.paid).sort((a,b)=>String(b.payment.paidAt).localeCompare(String(a.payment.paidAt)));
  const unpaid=jobs.filter(j=>!j.payment.paid);
  const ym=todayISO().slice(0,7);
  const month=paid.filter(j=>new Date(j.payment.paidAt).toLocaleDateString("en-CA",{timeZone:"Africa/Johannesburg"}).slice(0,7)===ym).reduce((s,j)=>s+(j.payment.amount??j.total??0),0);
  const owed=unpaid.reduce((s,j)=>s+(j.total||jobTotal(j)),0);
  app.innerHTML=`<div class="stack">
    <div class="row" style="justify-content:space-between"><h2>ISS ledger</h2><button class="btn sm" id="exportCsv" ${jobs.length?"":"disabled"}>Export ISS_Ledger.csv</button></div>
    <div class="grid2">
      <section class="card"><h3>Received this month</h3><span class="mono" style="font-size:1.5rem">${money(month)}</span></section>
      <section class="card"><h3>Outstanding</h3><span class="mono" style="font-size:1.5rem">${money(owed)}</span><span class="muted small">${unpaid.length} unpaid job${unpaid.length===1?"":"s"}</span></section>
    </div>
    <section class="card"><h3>Payments received</h3>
      ${paid.length?`<div class="tablewrap"><table><thead><tr><th>Date</th><th>Receipt</th><th>Report</th><th>Client</th><th>Method</th><th class="n">Amount</th></tr></thead><tbody>
      ${paid.map(j=>`<tr data-id="${esc(j.id)}" style="cursor:pointer"><td>${fmtDate(j.payment.paidAt)}</td><td class="mono">${esc(j.payment.receiptNo)}</td><td class="mono">${esc(j.reportNo)}</td><td>${esc(j.client.name)}</td><td>${esc(j.payment.method)}</td><td class="n">${money(j.payment.amount??j.total)}</td></tr>`).join("")}
      </tbody></table></div>`:`<p class="muted" style="margin:0">Payments appear here as soon as you mark a job as paid.</p>`}
    </section>
    ${unpaid.length?`<section class="card"><h3>Awaiting payment</h3><div class="tablewrap"><table><thead><tr><th>Taken in</th><th>Report</th><th>Client</th><th class="n">Due</th></tr></thead><tbody>
      ${unpaid.map(j=>`<tr data-id="${esc(j.id)}" style="cursor:pointer"><td>${fmtDate(j.createdAt)}</td><td class="mono">${esc(j.reportNo)}</td><td>${esc(j.client.name)}</td><td class="n">${money(j.total||jobTotal(j))}</td></tr>`).join("")}
    </tbody></table></div></section>`:""}
    <p class="muted small" style="margin:0">The CSV opens in LibreOffice Calc. Amounts carry no VAT, as ISS is not VAT registered.</p>
  </div>`;
  app.querySelectorAll("tr[data-id]").forEach(tr=>tr.onclick=()=>openJob(tr.dataset.id));
  $("#exportCsv").onclick=()=>{
    const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const head=["Date taken in","Report number","LAB ref","Client","Phone","Email","Item","Services","Walk-in","Amount (ZAR)","Paid","Date paid","Method","Payment reference","Receipt number","Report status","Reminder due"];
    const rows=[...jobs].sort((a,b)=>String(a.createdAt).localeCompare(String(b.createdAt))).map(j=>[
      (j.createdAt||"").slice(0,10), j.reportNo, j.client.ref, j.client.name, j.client.phone, j.client.email, j.item.description,
      (j.services||[]).map(s=>`${s.label} x${s.qty}`).join("; "), j.walkIn?"Yes":"No", j.total||jobTotal(j),
      j.payment.paid?"Yes":"No", (j.payment.paidAt||"").slice(0,10), j.payment.method, j.payment.ref, j.payment.receiptNo, STATUS[j.status]||j.status, j.reminderDue||""]);
    const csv=[head,...rows].map(r=>r.map(q).join(",")).join("\r\n");
    downloadBlob(new Blob(["﻿"+csv],{type:"text/csv"}),"ISS_Ledger.csv"); toast("ISS_Ledger.csv saved");
  };
}

/* ================= settings ================= */
function renderSettings(app){
  if(!setDraft) setDraft=JSON.parse(JSON.stringify(settings));
  const s=setDraft;
  if(!s.services || !s.services.length) s.services=JSON.parse(JSON.stringify(DEFAULT_SERVICES));
  const F=(k,label,ph="",type="text")=>`<label class="f">${label}<input id="s-${k}" data-s="${k}" type="${type}" value="${esc(s[k]??"")}" placeholder="${esc(ph)}"></label>`;
  app.innerHTML=`<form id="setForm" class="stack" novalidate>
    <h2>Settings</h2>
    <section class="card"><h3>Logo on reports</h3>
      <div class="row">${s.logo?`<img src="${esc(s.logo)}" alt="Your logo" style="width:72px;height:72px;object-fit:contain;background:#fff;border:1px solid var(--line);border-radius:8px">`:`<span class="muted small">No logo yet. Reports use the laboratory name on its own.</span>`}
        <label class="btn" for="logoFile">${s.logo?"Replace logo":"Upload logo"}</label><input id="logoFile" type="file" accept="image/png,image/jpeg" hidden>
        ${s.logo?`<button type="button" class="btn ghost sm" id="logoRm">Remove</button>`:""}</div>
      <p class="muted small" style="margin:0">A square PNG or JPG works best. It appears on every PDF and on the public verification page.</p>
    </section>
    <section class="card"><h3>Business details on reports and receipts</h3>
      <div class="grid2">
        ${F("businessName","Laboratory name")}${F("parent","Company")}
        ${F("gemmologist","Gemmologist")}${F("credentials","Credentials")}
        ${F("phone","Phone","","tel")}${F("email","Email","","email")}
      </div>${F("address","Address (optional)")}
    </section>
    <section class="card"><h3>Payments</h3>
      ${F("payLink","Pay Now link","https://pay.yoco.com/your-business","url")}
      <p class="muted small" style="margin:0">Paste a payment link from Yoco, PayFast, SnapScan or your bank. It appears as a Pay Now button and QR code on unpaid jobs.</p>
      <label class="f">EFT banking details (optional, shown in payment messages)<textarea id="s-bank" data-s="bank">${esc(s.bank||"")}</textarea></label>
    </section>
    <section class="card"><h3>Reminders and verification</h3>
      <div class="grid2">
        <label class="f">Re-test / re-valuation every (months)<input id="s-remindMonths" data-s="remindMonths" type="number" min="1" max="120" class="mono" value="${esc(s.remindMonths??24)}"></label>
        ${F("verifyUrl","Verification page address (leave empty to use this app's)",verifyBase(),"url")}
      </div>
    </section>
    <section class="card"><h3>Service prices</h3>
      ${s.services.map((x,i)=>`<div class="svc" style="grid-template-columns:1fr 110px"><span>${esc(x.label)}</span><input type="number" min="0" step="10" class="mono" id="sp-${x.id}" data-sp="${i}" value="${esc(x.price)}" aria-label="Price for ${esc(x.label)}"></div>`).join("")}
    </section>
    <div class="row"><button type="submit" class="btn primary" id="setSave">Save settings</button><button type="button" class="btn ghost" id="setReset">Discard changes</button></div>
    <section class="card"><h3>Supervisor: report numbering</h3>
      <p class="muted small" style="margin:0">Use this only to correct the counter, for example after deleting test jobs. Every change is kept in the CRM's override log.</p>
      <div class="grid2"><label class="f">Next report number for ${new Date().getFullYear()} (e.g. 1 gives ISSL-${new Date().getFullYear()}-0001)<input id="ctrNext" type="number" min="1" class="mono"></label>
      <label class="f">Reason<input id="ctrWhy"></label></div>
      <div class="row"><button type="button" class="btn sm" id="ctrGo">Set counter</button></div>
    </section>
  </form>`;
  const form=$("#setForm");
  form.addEventListener("input",e=>{ if(e.target.dataset.s) s[e.target.dataset.s]=e.target.dataset.s==="remindMonths"?Number(e.target.value)||24:e.target.value; if(e.target.dataset.sp) s.services[Number(e.target.dataset.sp)].price=Number(e.target.value)||0; });
  $("#setReset").onclick=()=>{ setDraft=null; renderSettings(app); };
  form.addEventListener("submit",async e=>{ e.preventDefault(); try{ await saveSettings(JSON.parse(JSON.stringify(s))); setDraft=null; toast("Settings saved"); renderSettings(app); }catch(x){ toast(errMsg(x)); } });
  $("#logoFile").onchange=async e=>{
    const f=e.target.files[0]; if(!f) return;
    try{ toast("Saving logo…");
      const isPng=/png/i.test(f.type); const blob=isPng?f:await resizeImage(f,800);
      const url=await uploadPublic(`branding/logo-${Date.now()}.${isPng?"png":"jpg"}`, blob, isPng?"image/png":"image/jpeg");
      await saveSettings({...settings, logo:url}); s.logo=url; toast("Logo saved"); renderSettings(app);
    }catch(x){ toast(errMsg(x)); }
  };
  const lr=$("#logoRm"); if(lr) lr.onclick=async()=>{ try{ await saveSettings({...settings, logo:""}); s.logo=""; toast("Logo removed"); renderSettings(app); }catch(x){ toast(errMsg(x)); } };
  $("#ctrGo").onclick=async()=>{
    const n=Number($("#ctrNext").value), why=$("#ctrWhy").value.trim();
    if(!n||n<1){ toast("Enter the next number, for example 1."); return; }
    if(why.length<5){ toast("Give a reason of at least 5 characters."); return; }
    try{ const {error}=await sb.rpc("supervisor_set_counter",{p_type:"lab_report",p_next_value:n,p_reason:why}); if(error) throw error;
      toast(`Next report will be ISSL-${new Date().getFullYear()}-${String(n).padStart(4,"0")}`); $("#ctrNext").value=""; $("#ctrWhy").value=""; }
    catch(x){ toast(errMsg(x)); }
  };
}

/* ================= boot ================= */
async function boot(){
  if(!window.supabase || !cfg.supabaseUrl){
    document.body.innerHTML='<p style="padding:24px;font-family:sans-serif">The app could not load. Check your internet connection and reload.</p>'; return;
  }
  sb=window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {auth:{persistSession:true, autoRefreshToken:true, detectSessionInUrl:true}});
  sb.auth.onAuthStateChange((event)=>{
    if(event==="PASSWORD_RECOVERY"){ recovering=true; showLogin("Choose a new password for your account."); }
  });
  if(/type=recovery/.test(location.hash)){ recovering=true; }
  if(recovering){ showLogin("Choose a new password for your account."); return; }
  await start();
}
boot();
})();
