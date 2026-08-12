
const firebaseConfig = {
  apiKey: "AIzaSyCUT5f-IYbJxY7Hmxz4VAI4pDvoF-7WaKM",
  authDomain: "update-app-b7418.firebaseapp.com",
  databaseURL: "https://update-app-b7418-default-rtdb.firebaseio.com",
  projectId: "update-app-b7418",
  storageBucket: "update-app-b7418.firebasestorage.app",
  messagingSenderId: "645859577514",
  appId: "1:645859577514:web:fdf234ac8d6a745b86cad3",
  measurementId: "G-ZXYPX4F1DY"
};
firebase.initializeApp(firebaseConfig);


/* ===== separated inventory script ===== */

/* ===================== STORAGE HELPERS ===================== */
/* بيانات الجلسة (المستخدم الحالي) فقط تُحفظ محليًا. بيانات الفروع/الليستات/النواقص/الريبورتات
   بقت تتخزن وتتزامن مباشرة مع Firebase Realtime Database تحت المسار app_data، بحيث أي تعديل
   يظهر فورًا فى فايربيز ويوصل لأي جهاز/متصفح تاني مسجل دخول بنفس القاعدة. */
const LS = {
  get(k, fallback){ try{ const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; }catch(e){ return fallback; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch(e){ console.error(e); } },
  del(k){ localStorage.removeItem(k); }
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2,7);
const now = () => Date.now();
const TWO_DAYS = 1000*60*60*24*2;

/* نسخة محلية (كاش) من بيانات فايربيز، تتحدث تلقائيًا لحظة أي تغيير عن طريق on('value') */
let cache = { branches: [], main: {}, shortage: {}, reports: {}, instashopReports: {}, settings: {}, catalogs: {}, appAvailable: {}, unavailableReports: {} };
let dataListenerAttached = false;
/* الفرع المفتوح حاليًا (لو فيه) — بنحتفظ بيه عشان لو وصل تحديث من فايربيز (مثلاً بسبب حفظ صنف نواقص)
   ما يقفلش كل الفروع ويرجّع الشاشة فاضية؛ بدل كده نعيد فتح نفس الفرع اللي كان مفتوح. */
let currentOpenBranchId = null;

function normalizeBranchesValue(value){
  if(!value) return [];
  if(Array.isArray(value)){
    return value.filter(Boolean).map((branch,index)=>{
      const b = (branch && typeof branch === 'object') ? {...branch} : {name:String(branch ?? '')};
      if(!b.id) b.id = String(index);
      return b;
    }).filter(b=>String(b.name||'').trim());
  }
  if(typeof value === 'object'){
    // دعم تخزين Firebase كـ object keyed by the branch id.
    if(value.name){
      const b = {...value};
      if(!b.id) b.id = uid();
      return [b];
    }
    return Object.entries(value).map(([key,branch])=>{
      const b = (branch && typeof branch === 'object') ? {...branch} : {name:String(branch ?? '')};
      if(!b.id) b.id = key;
      return b;
    }).filter(b=>String(b.name||'').trim());
  }
  return [];
}

function normalizeCache(v){
  const val = v || {};
  return {
    branches: normalizeBranchesValue(val.branches),
    main: val.main || {},
    shortage: val.shortage || {},
    reports: val.reports || {},
    instashopReports: val.instashopReports || {},
    settings: val.settings || {},
    catalogs: val.catalogs || {},
    appAvailable: val.appAvailable || {},
    unavailableReports: val.unavailableReports || {}
  };
}

/* Overlay للعمليات التي لم يؤكدها Firebase بعد. هذا يمنع الـsnapshot القديمة
   التي تصل عند فتح/Refresh الصفحة من استبدال آخر ليستة رفعها المستخدم. */
function setNestedValue(root, path, value){
  const parts = String(path||'').split('/').filter(Boolean);
  if(!parts.length) return value;
  let cur = root;
  for(let i=0;i<parts.length-1;i++){
    const k = parts[i];
    if(!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length-1]] = value;
  return root;
}
function deleteNestedValue(root, path){
  const parts = String(path||'').split('/').filter(Boolean);
  if(!parts.length) return {};
  let cur = root;
  for(let i=0;i<parts.length-1;i++){
    cur = cur && cur[parts[i]];
    if(!cur || typeof cur !== 'object') return root;
  }
  if(cur && typeof cur === 'object') delete cur[parts[parts.length-1]];
  return root;
}
function applyPendingOutboxOverlay(raw){
  const base = raw && typeof raw === 'object' ? JSON.parse(JSON.stringify(raw)) : {};
  const q = loadOutbox();
  for(const op of Array.isArray(q) ? q : []){
    try{
      if(op.type === 'set'){
        setNestedValue(base, op.path, op.value);
      }else if(op.type === 'remove'){
        deleteNestedValue(base, op.path);
      }else if(op.type === 'update' && op.value && typeof op.value === 'object'){
        Object.entries(op.value).forEach(([path,value])=>{
          if(value === null) deleteNestedValue(base, path);
          else setNestedValue(base, path, value);
        });
      }
    }catch(e){ console.warn('Pending Firebase overlay failed:', e); }
  }
  return base;
}

let firstDataReceived = false;
let firstLoadTimeoutTimer = null;

async function attachDataListener(){
  if(dataListenerAttached) return;
  await waitForOutboxReady();
  dataListenerAttached = true;

  firstLoadTimeoutTimer = setTimeout(()=>{
    if(firstDataReceived) return;
    const list = document.getElementById('branches-list');
    if(list) list.innerHTML = `<div class="empty"><b>تعذّر تحميل البيانات</b>الاتصال بقاعدة البيانات بطيء أو متعطل — تأكد من اتصالك بالإنترنت<div style="margin-top:14px"><button class="btn btn-accent btn-sm" onclick="location.reload()">🔄 إعادة تحميل الصفحة</button></div></div>`;
  }, 12000);

  let renderDebounceTimer = null;
  function scheduleBranchesRender(){
    clearTimeout(renderDebounceTimer);
    renderDebounceTimer = setTimeout(()=>{
      const scrollY = window.scrollY || window.pageYOffset || 0;
      rebuildChainSearchIndex();
      renderBranches(currentOpenBranchId);
      populateChainBranchFilter();
      const chainInput = document.getElementById('chainSearchInput');
      if(chainInput && chainInput.value) runSearchChain(chainInput.value);
      if(Math.abs((window.scrollY||window.pageYOffset||0) - scrollY) > 2) window.scrollTo(0, scrollY);
    }, 120);
  }

  /* IMPORTANT: do NOT listen to all of app_data. A value listener on the whole
     tree downloads/reprocesses the entire inventory every time any shortage/report
     changes. Keep each top-level dataset on its own listener so a single edit only
     transfers and redraws the affected dataset. */
  const topLevel = ['branches','main','shortage','reports','instashopReports','settings','catalogs','appAvailable','unavailableReports'];
  const listeners = [];
  const setSection = (key, value) => {
    if(key === 'branches') cache.branches = normalizeBranchesValue(value);
    else if(key === 'main') cache.main = value && typeof value === 'object' ? value : {};
    else if(key === 'shortage') cache.shortage = value && typeof value === 'object' ? value : {};
    else if(key === 'reports') cache.reports = value && typeof value === 'object' ? value : {};
    else if(key === 'instashopReports') cache.instashopReports = value && typeof value === 'object' ? value : {};
    else if(key === 'settings') cache.settings = value && typeof value === 'object' ? value : {};
    else if(key === 'catalogs') cache.catalogs = value && typeof value === 'object' ? value : {};
    else if(key === 'appAvailable') cache.appAvailable = value && typeof value === 'object' ? value : {};
    else if(key === 'unavailableReports') cache.unavailableReports = value && typeof value === 'object' ? value : {};
  };
  topLevel.forEach(key=>{
    const ref = firebase.database().ref('app_data/'+key);
    const cb = snapshot=>{
      firstDataReceived = true;
      clearTimeout(firstLoadTimeoutTimer);
      const raw = snapshot.val();
      setSection(key, raw);
      /* Apply only pending operations that belong to this section. This keeps a
         refresh consistent without cloning the entire app_data tree. */
      const pending = loadOutbox();
      for(const op of Array.isArray(pending)?pending:[]){
        try{
          const p=String(op.path||'');
          if(!p.startsWith('app_data/'+key)) continue;
          if(op.type==='set') setNestedValue(cache, p, op.value);
          else if(op.type==='remove') deleteNestedValue(cache, p);
        }catch(e){}
      }
      scheduleBranchesRender();
    };
    const errCb = err=>{
      console.error('Firebase sync error at app_data/'+key+':', err);
      updateFirebaseStatus(false, (err && (err.code || err.message)) ? String(err.code || err.message) : 'Firebase read error');
      if(!firstDataReceived){
        const list=document.getElementById('branches-list');
        if(list) list.innerHTML='<div class="empty"><b>تعذّر تحميل البيانات</b>الاتصال بقاعدة البيانات بطيء أو متعطل — تأكد من اتصالك بالإنترنت</div>';
      }
    };
    ref.on('value', cb, errCb);
    listeners.push({ref,cb});
  });

  // Compatibility fallback: some older versions stored the branch list at /branches.
  // If /app_data/branches is empty, read the legacy location without overwriting it.
  firebase.database().ref('app_data/branches').once('value').then(snap=>{
    if(normalizeBranchesValue(snap.val()).length) return;
    return firebase.database().ref('branches').once('value').then(legacy=>{
      const legacyBranches=normalizeBranchesValue(legacy.val());
      if(legacyBranches.length && !(cache.branches||[]).length){
        cache.branches=legacyBranches;
        scheduleBranchesRender();
      }
    });
  }).catch(err=>console.warn('Legacy branches fallback:',err));

  window.__inventoryDataListeners = listeners;
  watchConnectionState();
}

/* مراقبة حالة الاتصال بفايربيز (مسار خاص .info/connected بيوفره فايربيز نفسه) —
   بيوضح للمستخدم فورًا لو النت اتقطع أو رجع تاني، بدل ما الصفحة تفضل واقفة بصمت */
let connectionWatcherAttached = false;
let wasConnected = null;
function updateFirebaseStatus(connected, errorText=''){
  const el=document.getElementById('firebaseStatus');
  if(!el) return;
  el.className='firebase-status '+(connected ? 'online' : 'offline');
  el.textContent=connected ? '● Firebase متصل' : '● Firebase غير متصل';
  if(errorText){
    el.title=errorText;
    el.dataset.error=errorText;
  } else {
    el.title='Realtime Database: update-app-b7418';
    el.dataset.error='';
  }
}

function watchConnectionState(){
  if(connectionWatcherAttached) return;
  connectionWatcherAttached = true;
  firebase.database().ref('.info/connected').on('value', snap=>{
    const connected = snap.val() === true;
    updateFirebaseStatus(connected);
    if(wasConnected === false && connected){
      toast('✅ تم استعادة الاتصال بقاعدة Firebase');
    } else if(wasConnected === true && !connected){
      toast('⚠️ تم فقد الاتصال بقاعدة Firebase — جارٍ إعادة الاتصال...');
    }
    wasConnected = connected;
  });
}
function detachDataListener(){
  if(!dataListenerAttached) return;
  dataListenerAttached = false;
  try{
    (window.__inventoryDataListeners||[]).forEach(({ref,cb})=>ref.off('value',cb));
  }catch(e){}
  window.__inventoryDataListeners = [];
  cache = { branches: [], main: {}, shortage: {}, reports: {}, instashopReports: {}, settings: {}, catalogs: {}, appAvailable: {}, unavailableReports: {} };
  clearTimeout(firstLoadTimeoutTimer);
  firstDataReceived = false;
  currentOpenBranchId = null;
  if(connectionWatcherAttached){
    connectionWatcherAttached = false;
    wasConnected = true;
    firebase.database().ref('.info/connected').off();
  }
}

/* ===================== PERSISTENT FIREBASE OUTBOX ===================== */
/* ملحوظة: كان الطابور بيتخزن قديمًا في localStorage، لكن مساحة localStorage
   محدودة جدًا (وأصغر بكتير جوه iframe بـ srcdoc)، فكانت عمليات الكتابة الكبيرة
   (زي مزامنة تقارير كل الفروع) بتفشل بخطأ QuotaExceededError وتتفقد بالكامل
   من غير ما توصل لـ Firebase. الحل: نخزن الطابور في IndexedDB (مساحته أكبر
   بمئات المرات) مع الاحتفاظ بنسخة في الذاكرة عشان باقي الكود يفضل يشتغل
   بنفس الطريقة (بدون الحاجة لتحويل كل الدوال إلى async). */
const OUTBOX_KEY = 'ibs_firebase_outbox_v1'; /* مفتاح localStorage القديم - يُستخدم فقط للترحيل مرة واحدة */
const OUTBOX_DB = 'ibs_outbox_db';
const OUTBOX_STORE = 'outbox';
let outboxBusy = false;
let __outboxMem = [];      /* نسخة الطابور الحالية في الذاكرة */
let __outboxMemReady = false;

function openOutboxDB(){
  return new Promise((resolve, reject)=>{
    try{
      const req = indexedDB.open(OUTBOX_DB, 1);
      req.onupgradeneeded = () => { if(!req.result.objectStoreNames.contains(OUTBOX_STORE)) req.result.createObjectStore(OUTBOX_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }catch(e){ reject(e); }
  });
}
async function outboxDBGetAll(){
  try{
    const db = await openOutboxDB();
    const fromDB = await new Promise((resolve,reject)=>{
      const tx = db.transaction(OUTBOX_STORE,'readonly');
      const req = tx.objectStore(OUTBOX_STORE).get('queue');
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : null);
      req.onerror = () => reject(req.error);
    });
    if(fromDB) return fromDB;
  }catch(e){ console.warn('IndexedDB outbox read failed, falling back:', e); }
  /* ترحيل تلقائي مرة واحدة من localStorage القديم (لو موجود) */
  try{ const v = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); return Array.isArray(v) ? v : []; }catch(e2){ return []; }
}
async function outboxDBSetAll(q){
  try{
    const db = await openOutboxDB();
    await new Promise((resolve,reject)=>{
      const tx = db.transaction(OUTBOX_STORE,'readwrite');
      tx.objectStore(OUTBOX_STORE).put(q, 'queue');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    /* بعد أول حفظ ناجح في IndexedDB، نفضّي مفتاح localStorage القديم حتى لا يظل يشغل مساحة */
    try{ localStorage.removeItem(OUTBOX_KEY); }catch(e){}
  }catch(e){
    console.error('Outbox storage error (IndexedDB)', e);
  }
}

function loadOutbox(){ return __outboxMem; }
function saveOutbox(q){
  __outboxMem = Array.isArray(q) ? q : [];
  outboxDBSetAll(__outboxMem);
}

async function waitForOutboxReady(){
  if(__outboxMemReady) return;
  /* initOutbox is started immediately below; this prevents a click that
     happens during startup from overwriting the IndexedDB queue. */
  const started = Date.now();
  while(!__outboxMemReady && Date.now() - started < 10000){
    await new Promise(r=>setTimeout(r,50));
  }
}

(async function initOutbox(){
  try{
    __outboxMem = await outboxDBGetAll();
  }catch(e){
    console.warn('Outbox initialization failed:', e);
    __outboxMem = [];
  }
  __outboxMemReady = true;
  processFirebaseOutbox();
})();

const OUTBOX_MAX_ATTEMPTS = 5;
function enqueueFirebaseOp(op){
  const q=loadOutbox();
  const item={id:uid()+'_'+Date.now(), type:op.type, path:op.path, value:op.value, createdAt:Date.now(), attempts:0};
  q.push(item);
  saveOutbox(q);
  processFirebaseOutbox();
  return item.id;
}
function removeOutboxId(id){ saveOutbox(loadOutbox().filter(x=>x.id!==id)); }
function updateOutboxItem(item){ const q=loadOutbox(); const idx=q.findIndex(x=>x.id===item.id); if(idx>-1){ q[idx]=item; saveOutbox(q); } }

async function runFirebaseOp(op){
  return new Promise((resolve,reject)=>{
    let settled=false;
    const finish=(ok,err)=>{
      if(settled)return; settled=true; clearTimeout(timer);
      if(ok) resolve();
      else { const e=err instanceof Error?err:new Error(String(err||'Firebase timeout')); if(err&&err.code)e.code=err.code; reject(e); }
    };
    const timer=setTimeout(()=>finish(false,Object.assign(new Error('Firebase operation timeout'),{code:'TIMEOUT'})),12000);
    try{
      let p;
      if(op.type==='set') p=firebase.database().ref(op.path).set(op.value);
      else if(op.type==='remove') p=firebase.database().ref(op.path).remove();
      else return finish(false,new Error('Unsupported Firebase operation: '+op.type));
      Promise.resolve(p).then(()=>finish(true)).catch(e=>finish(false,e));
    }catch(e){ finish(false,e); }
  });
}

/* Convert any old root/multi-location update left by previous versions into
   small path operations. This is critical: an old queued update at / can keep
   retrying forever and make the whole site slow even after the new code is loaded. */
function normalizeLegacyOutbox(){
  const q=loadOutbox(); if(!Array.isArray(q)||!q.length) return;
  const next=[];
  for(const op of q){
    if(op.type==='update' && op.value && typeof op.value==='object'){
      Object.entries(op.value).forEach(([path,value])=>{
        const p=String(path||'').replace(/^\/+/, '');
        if(!p) return;
        next.push({id:uid()+'_'+Date.now(),type:value===null?'remove':'set',path:p,value:value===null?undefined:value,createdAt:op.createdAt||Date.now(),attempts:0});
      });
    }else if(op.type==='set'||op.type==='remove') next.push(op);
    /* unknown operations are intentionally discarded */
  }
  saveOutbox(next);
}

async function processFirebaseOutbox(){
  if(outboxBusy) return;
  await waitForOutboxReady();
  normalizeLegacyOutbox();
  const q=loadOutbox(); if(!q.length) return;
  outboxBusy=true;
  try{
    /* Send a few independent paths in parallel. Never use update('/') here. */
    const batch=q.slice(0,4);
    await Promise.all(batch.map(async op=>{
      try{
        await runFirebaseOp(op);
        removeOutboxId(op.id);
      }catch(e){
        const attempts=(op.attempts||0)+1;
        console.warn('Firebase op failed:',op.path,e);
        if(attempts>=OUTBOX_MAX_ATTEMPTS){
          const code=e&&e.code?String(e.code):''; const raw=String(e&&e.message||'');
          const detail=/write_too_big|too.?big/i.test(code+' '+raw)?'حجم عملية الحفظ كبير جدًا':(/PERMISSION_DENIED|permission/i.test(code+' '+raw)?'صلاحيات Firebase Rules تمنع الكتابة':(code||'خطأ Firebase'));
          toast('⚠️ فشل حفظ التعديل: '+detail+' — المسار: '+op.path);
          removeOutboxId(op.id);
        }else{ op.attempts=attempts; updateOutboxItem(op); }
      }
    }));
  }finally{ outboxBusy=false; }
  if(loadOutbox().length) setTimeout(processFirebaseOutbox,250);
}
setInterval(processFirebaseOutbox,2000);
window.addEventListener('online',processFirebaseOutbox);

/* Direct writes are always path-scoped. This prevents the previous root update
   from becoming the bottleneck and keeps each request small. */
async function firebaseBatchWriteNow(updates){
  if(!updates||typeof updates!=='object') return;
  await waitForOutboxReady();
  const entries=Object.entries(updates);
  const MAX_SINGLE_BYTES=450*1024;
  const CONCURRENCY=4;
  const work=[];
  for(const [path,value] of entries){
    let size=0; try{size=new Blob([JSON.stringify(value)]).size;}catch(e){size=JSON.stringify(value).length*2;}
    if(size>MAX_SINGLE_BYTES){
      throw Object.assign(new Error('Single Firebase path payload is too large'),{code:'write_too_big',path});
    }
    work.push({path,value,type:value===null?'remove':'set'});
  }
  let idx=0;
  async function worker(){
    while(idx<work.length){ const item=work[idx++]; await runFirebaseOp(item); }
  }
  await Promise.all(Array.from({length:Math.min(CONCURRENCY,work.length)},worker));
}

function firebaseWrite(path, value){
  cachePathValue(path,value);
  enqueueFirebaseOp({type:'set',path,value});
}
function firebaseBatchWrite(updates){
  if(!updates||typeof updates!=='object') return;
  for(const [path,value] of Object.entries(updates)){
    if(value===null) enqueueFirebaseOp({type:'remove',path});
    else enqueueFirebaseOp({type:'set',path,value});
  }
}
function firebaseRemove(path){
  cachePathValue(path,null);
  enqueueFirebaseOp({type:'remove',path});
}
function cachePathValue(path,value){ /* local UI cache is already updated by callers */ }


function getBranches(){ return cache.branches || []; }
function saveBranches(b){ cache.branches = b; firebaseWrite('app_data/branches', b); }
function getMain(id){ return (cache.main && cache.main[id]) || null; }
function saveMain(id, d){ cache.main[id] = d; firebaseWrite('app_data/main/'+id, d); rebuildChainSearchIndex(); }
function clearMainCore(id){
  delete cache.main[id];
  firebaseRemove('app_data/main/'+id);
  rebuildChainSearchIndex();
}
function clearMain(id){
  if(!confirm('هل تريد حذف الشيت المرفوع لهذا الفرع؟ سيتم حذف الليستة اليومية بالكامل.')) return;
  clearMainCore(id);
  toast('تم حذف الشيت');
  renderBranches(id);
}
/* حذف الشيت الموحد بشكل فوري وآمن حتى لو كانت البيانات ضخمة.
   Firebase Realtime Database ترفض DELETE/PATCH واحدًا إذا كانت كمية البيانات
   التي ستتغير كبيرة. لذلك نقرأ app_data/main مرة واحدة ثم نحذف الـleaves
   على دفعات صغيرة، مع انتظار نجاح كل دفعة قبل الانتقال للتالية. */
let unifiedMainOperationBusy = false;

function collectFirebaseDeleteLeaves(value, path, out){
  if(value === null || value === undefined) return;
  if(Array.isArray(value)){
    if(value.length === 0){ out.push([path,null]); return; }
    value.forEach((v,i)=>collectFirebaseDeleteLeaves(v, path+'/'+i, out));
    return;
  }
  if(typeof value === 'object'){
    const keys = Object.keys(value);
    if(!keys.length){ out.push([path,null]); return; }
    keys.forEach(k=>collectFirebaseDeleteLeaves(value[k], path+'/'+encodeURIComponent(k).replace(/%2F/g,'_'), out));
    return;
  }
  out.push([path,null]);
}

async function deleteLargeFirebasePath(path){
  const snap = await firebase.database().ref(path).once('value');
  if(!snap.exists()) return {deleted:0,batches:0};

  const leaves=[];
  collectFirebaseDeleteLeaves(snap.val(), path, leaves);
  if(!leaves.length){
    await firebase.database().ref(path).remove();
    return {deleted:1,batches:1};
  }

  const MAX_DELETE_BYTES = 450 * 1024;
  let batch={}; let bytes=0; let deleted=0; let batches=0;
  const send=async()=>{
    if(!Object.keys(batch).length) return;
    const payload=batch;
    batch={}; bytes=0;
    await firebase.database().ref().update(payload);
    batches++;
  };

  for(const [leafPath,nullValue] of leaves){
    const entry = {[leafPath]:nullValue};
    let size;
    try { size = new Blob([JSON.stringify(entry)]).size; }
    catch(e){ size = JSON.stringify(entry).length * 2; }
    if(size > MAX_DELETE_BYTES){
      /* This is an extremely unusual single scalar; remove its parent instead. */
      await send();
      await firebase.database().ref(leafPath).remove();
      deleted++;
      continue;
    }
    if(Object.keys(batch).length && bytes + size > MAX_DELETE_BYTES) await send();
    batch[leafPath]=null;
    bytes += size;
    deleted++;
  }
  await send();
  return {deleted,batches};
}

async function clearAllMain(){
  if(unifiedMainOperationBusy) return;
  const branches = getBranches();
  const withMain = branches.filter(b => getMain(b.id));
  if(!withMain.length){ toast('لا توجد ليستة يومية مرفوعة لأي فرع'); return; }
  if(!confirm(`هل تريد حذف الليستة اليومية من كل الفروع (${withMain.length} فرع)؟ لا يمكن التراجع عن هذا الإجراء.`)) return;

  unifiedMainOperationBusy = true;
  const statusEl = document.getElementById('unifiedMainStatus');
  const checklistEl = document.getElementById('unifiedMainChecklist');
  const uploadInput = document.querySelector('input[type="file"][onchange="handleUnifiedMainUpload(this)"]');
  if(uploadInput) uploadInput.disabled = true;
  if(statusEl) statusEl.innerHTML = '⏳ جارٍ حذف الشيت من Firebase على دفعات آمنة...';

  /* لا تسمح لأي عملية قديمة من Unified Main أن تعود بعد الحذف. */
  removePendingMainOutboxOps();

  try{
    const result = await deleteLargeFirebasePath('app_data/main');

    /* تأكيد فعلي من Firebase بعد انتهاء كل دفعات الحذف. */
    const verify = await firebase.database().ref('app_data/main').once('value');
    if(verify.exists()) throw Object.assign(new Error('DELETE_VERIFY_FAILED'),{code:'DELETE_VERIFY_FAILED'});

    branches.forEach(b => { delete cache.main[b.id]; });
    rebuildChainSearchIndex();
    if(checklistEl) checklistEl.innerHTML = '';
    renderBranches();
    if(statusEl) statusEl.innerHTML = `✅ تم حذف الشيت فعليًا من كل الفروع — ${result.batches} دفعة حذف — وتم التأكد من Firebase`;
    toast('✅ تم حذف الشيت فعليًا من Firebase من كل الفروع');
  }catch(err){
    console.error('clearAllMain chunked Firebase delete failed:', err);
    /* لا نضع remove على parent في الـoutbox، لأنه سيكرر write_too_big. */
    if(statusEl) statusEl.innerHTML = `❌ فشل الحذف الفعلي: ${err.code || err.message || 'خطأ غير معروف'}`;
    toast('❌ فشل حذف الشيت من Firebase — لم يتم وضع عملية كبيرة في المزامنة', true);
  }finally{
    unifiedMainOperationBusy = false;
    if(uploadInput) uploadInput.disabled = false;
  }
}

function getShortage(id){ return (cache.shortage && cache.shortage[id]) || {updatedAt:null, items:[]}; }
async function firebaseWriteNow(path, value){
  await initInventoryFirebaseAuth();
  if(!firebase || !firebase.database) throw new Error('Firebase database is not initialized');
  const ref = firebase.database().ref(path);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const timer=setTimeout(()=>{ if(!settled){ settled=true; reject(Object.assign(new Error('Firebase operation timeout'),{code:'TIMEOUT'})); } },12000);
    ref.set(value).then(()=>{ if(settled)return; settled=true; clearTimeout(timer); resolve(); })
      .catch(err=>{ if(settled)return; settled=true; clearTimeout(timer); reject(err); });
  });
}

async function saveShortageImmediate(id, d){
  cache.shortage[id] = d;
  rebuildChainSearchIndex();
  try{
    await firebaseWriteNow('app_data/shortage/'+id, d);
    return true;
  }catch(err){
    console.error('Immediate shortage save failed:', {branchId:id, code:err&&err.code, message:err&&err.message});
    /* Fallback only if direct Firebase write fails. */
    firebaseWrite('app_data/shortage/'+id, d);
    return false;
  }
}

function saveShortage(id, d){
  cache.shortage[id] = d;
  firebaseWrite('app_data/shortage/'+id, d);
  rebuildChainSearchIndex();
}
function getReports(id){ const r=(cache.reports&&cache.reports[id])||null; return r ? {...r, items:filterReportItemsByCurrentShortage(id,r.items,false)} : null; }
function saveReports(id, d){ cache.reports[id] = d; firebaseWrite('app_data/reports/'+id, d); rebuildChainSearchIndex(); }
function clearReports(id){ delete cache.reports[id]; firebaseRemove('app_data/reports/'+id); rebuildChainSearchIndex(); }

/* ريبورت Instashop منفصل (نفس تفاصيل Vezeeta، لكن مع استثناء أصناف الألبان من الحذف بسبب النواقص) */
function getInstashopReport(id){ const r=(cache.instashopReports&&cache.instashopReports[id])||null; return r ? {...r, items:filterReportItemsByCurrentShortage(id,r.items,true)} : null; }
function saveInstashopReport(id, d){ cache.instashopReports[id] = d; firebaseWrite('app_data/instashopReports/'+id, d); rebuildChainSearchIndex(); }
function clearInstashopReport(id){ delete cache.instashopReports[id]; firebaseRemove('app_data/instashopReports/'+id); rebuildChainSearchIndex(); }

function norm(v){ return (v===undefined||v===null) ? '' : String(v).trim(); }
function codeKey(v){ return norm(v).toLowerCase(); }
function shortageCodeSet(branchId){ const s=getShortage(branchId); return new Set((s.items||[]).map(x=>codeKey(x.code)).filter(Boolean)); }
function filterReportItemsByCurrentShortage(branchId, items, allowMilk){ const set=shortageCodeSet(branchId); if(!set.size) return Array.isArray(items)?items.slice():[]; return (Array.isArray(items)?items:[]).filter(it=>!set.has(codeKey(it.code)) || (allowMilk && !!it.milk)); }
function toNum(v){ const n = parseFloat(v); return isNaN(n) ? 0 : n; }
/* يحوّل كود الصنف لرقم فعلى (Number) لو الكود أرقام فقط، عشان يتخزن فى الإكسل كـ Number مش نص
   (لو الكود فيه حروف أو رموز بيسيبه نص زي ما هو عشان متتلخبطش القيمة) */
function codeToNumber(code){
  const s = norm(code);
  if(s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function fmtDate(ts){ if(!ts) return '—'; const d = new Date(ts); return d.toLocaleDateString('ar-EG',{day:'2-digit',month:'2-digit',year:'numeric'}) + ' ' + d.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'}); }
/* مزامنة الريبورت المحفوظ مع النواقص الحالية بعد Refresh */
function reconcileReportsWithShortages(){
  const updates={};
  getBranches().forEach(b=>{
    const main=getMain(b.id); if(!main||!main.items||!main.items.length) return;
    const shortSet=new Set((getShortage(b.id).items||[]).map(s=>codeKey(s.code)).filter(Boolean));
    const stored=cache.reports&&cache.reports[b.id];
    if(stored&&Array.isArray(stored.items)){
      const expected=main.items.filter(it=>!shortSet.has(codeKey(it.code))).map(it=>({code:it.code,name:it.name,price:it.price,balance:Math.floor(it.qty)})).filter(it=>it.balance>=1);
      const same=stored.items.length===expected.length&&stored.items.every((x,i)=>codeKey(x.code)===codeKey(expected[i].code)&&Number(x.balance)===Number(expected[i].balance));
      if(!same){const data={...stored,items:expected,matchedCount:main.items.length-expected.length,generatedAt:now()};cache.reports[b.id]=data;updates['app_data/reports/'+b.id]=data;}
    }
    const inst=cache.instashopReports&&cache.instashopReports[b.id];
    if(inst&&Array.isArray(inst.items)){
      const expected=main.items.filter(it=>{const milk=isMilkCategory(it.category);return !shortSet.has(codeKey(it.code))||milk;}).map(it=>({code:it.code,name:it.name,price:it.price,balance:Math.floor(it.qty),milk:isMilkCategory(it.category)})).filter(it=>it.milk||it.balance>=1);
      const same=inst.items.length===expected.length&&inst.items.every((x,i)=>codeKey(x.code)===codeKey(expected[i].code)&&Number(x.balance)===Number(expected[i].balance));
      if(!same){const removed=main.items.filter(it=>shortSet.has(codeKey(it.code))&&!isMilkCategory(it.category)).length;const milkKept=main.items.filter(it=>shortSet.has(codeKey(it.code))&&isMilkCategory(it.category)).length;const data={...inst,items:expected,matchedCount:removed,milkKept,generatedAt:now()};cache.instashopReports[b.id]=data;updates['app_data/instashopReports/'+b.id]=data;}
    }
  });
  if(Object.keys(updates).length) firebaseBatchWrite(updates);
}

/* ===================== EXPIRE OLD REPORTS ===================== */
function expireOldReports(){
  getBranches().forEach(b=>{
    const r = getReports(b.id);
    if(r && r.generatedAt && (now() - r.generatedAt > TWO_DAYS)){
      clearReports(b.id);
    }
    const ir = getInstashopReport(b.id);
    if(ir && ir.generatedAt && (now() - ir.generatedAt > TWO_DAYS)){
      clearInstashopReport(b.id);
    }
  });
}

/* ===================== AUTH ===================== */
/* الدخول من البوابة الرئيسية: نفس حساب Call Center، والصلاحيات الحساسة تأتي من البوابة الرئيسية */
let appInitialized = false;
let sharedPermissions = { inventoryAccess:false, inventoryBulkAddShortage:false, inventorySingleAddShortage:false, inventoryBulkRemoveShortage:false, inventorySearchChain:false, inventoryUnavailable:false };
let currentUser = LS.get('ibs_current_user', null);

function hasSharedPermission(key){
  return !!(sharedPermissions && sharedPermissions[key]);
}

function requireSharedPermission(key, message){
  if(hasSharedPermission(key)) return true;
  toast(message || 'ليس لديك صلاحية لتنفيذ هذه العملية');
  return false;
}

// إبلاغ البوابة الرئيسية أن نظام المخزون جاهز لاستقبال جلسة الدخول
try { window.parent.postMessage({type:'inventoryReady'}, '*'); } catch(e) {}
window.addEventListener('message', function(event){
  if(!event || !event.data || event.data.type !== 'sharedInventoryLogin') return;
  const user = event.data.user || {};
  const perms = event.data.permissions || (user.permissions || {});
  if(!perms.inventoryAccess){
    toast('ليس لديك صلاحية الدخول إلى نظام إدارة المخزون');
    return;
  }
  sharedPermissions = {
    inventoryAccess: !!perms.inventoryAccess,
    inventoryBulkAddShortage: !!perms.inventoryBulkAddShortage,
    inventorySingleAddShortage: !!perms.inventorySingleAddShortage,
    inventoryBulkRemoveShortage: !!perms.inventoryBulkRemoveShortage,
    inventorySearchChain: !!perms.inventorySearchChain,
  };
  currentUser = { id:user.id || '', name:user.name || '', role:user.role || 'employee', permissions:sharedPermissions, sharedLogin:true };
  LS.set('ibs_current_user', currentUser);
  showApp(currentUser);
  renderBranches();
});

function updateBulkPermissionUI(){
  const addBtn = document.getElementById('bulkAddAllShortageBtn');
  const removeBtn = document.getElementById('bulkRemoveAllShortageBtn');
  if(addBtn) addBtn.style.display = hasSharedPermission('inventoryBulkAddShortage') ? '' : 'none';
  if(removeBtn) removeBtn.style.display = hasSharedPermission('inventoryBulkRemoveShortage') ? '' : 'none';
  const searchTab = document.getElementById('tab-searchchain');
  if(searchTab) searchTab.style.display = hasSharedPermission('inventorySearchChain') ? '' : 'none';
  // لو التبويب الحالي اتقفل بسبب الصلاحية، ارجع تلقائيًا للفروع.
  const active = document.querySelector('nav.tabs button.active');
  if(active && active.style.display === 'none'){
    const branchesTab = document.querySelector('nav.tabs button[data-view="branches"]');
    if(branchesTab) branchesTab.click();
  }
}

function showApp(user){
  if(user && user.permissions) sharedPermissions = { ...sharedPermissions, ...user.permissions };
  const branchesTab = document.querySelector('nav.tabs button[data-view="branches"]');
  const branchesView = document.getElementById('view-branches');
  if(branchesTab){ document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active')); branchesTab.classList.add('active'); }
  if(branchesView){ document.querySelectorAll('.view').forEach(v=>v.classList.remove('active')); branchesView.classList.add('active'); }
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('appRoot').style.display = '';
  updateBulkPermissionUI();
  document.getElementById('userEmailLabel').textContent = user.name || user.email || '';
  document.getElementById('loginError').textContent = '';
  document.getElementById('loginPassword').value = '';
  if(!appInitialized){
    appInitialized = true;
    /* مؤشر تحميل فورى، عشان الشاشة متبانش فاضية وانت مستني اتصال فايربيز */
    const list = document.getElementById('branches-list');
    if(list) list.innerHTML = '<div class="empty"><b>جارٍ تحميل البيانات...</b>لو استمرت الشاشة فاضية لفترة طويلة، تأكد من اتصالك بالإنترنت</div>';
    attachDataListener(); // يحمّل البيانات من Firebase أول مرة، ثم يعيد الرسم تلقائيًا مع أي تحديث
    requestAnimationFrame(() => renderBranches());
    setTimeout(() => renderBranches(), 150);
    watchConnectionState();
    setInterval(expireOldReports, 1000*60*30); // recheck every 30 min
  }
}

function showLogin(){
  document.getElementById('loginScreen').classList.remove('hidden');
  document.getElementById('appRoot').style.display = 'none';
}

function doLogin(){ toast('يتم تسجيل الدخول من الواجهة الرئيسية فقط'); }

function doLogout(){
  if(!confirm('هل تريد تسجيل الخروج؟')) return;
  currentUser = null;
  appInitialized = false;
  detachDataListener();
  LS.del('ibs_current_user');
  try { window.parent.postMessage({type:'inventoryLogout'}, '*'); } catch(e) {}
  showLogin();
}

if(currentUser && currentUser.sharedLogin){ showApp(currentUser); } else { document.getElementById('loginScreen').classList.add('hidden'); document.getElementById('appRoot').style.display='none'; }

/* ===================== TOAST ===================== */
var toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}

function openRequestForm(url){ window.open(url, '_blank', 'noopener,noreferrer'); }

/* ===================== TABS ===================== */
document.querySelectorAll('nav.tabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    // قسم واحد فقط ظاهر في كل لحظة، مع إغلاق أي مودال/نافذة معلقة.
    document.querySelectorAll('.modal-bg.open').forEach(m=>m.classList.remove('open'));
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    const targetView = document.getElementById('view-'+btn.dataset.view);
    if(targetView) targetView.classList.add('active');
    if(btn.dataset.view==='searchchain'){
      const inp = document.getElementById('chainSearchInput');
      if(inp) inp.focus();
    }
  });
});

/* ===================== ESC: إغلاق أي مودال مفتوح ===================== */
document.addEventListener('keydown', (e)=>{
  if(e.key !== 'Escape') return;
  const openModal = document.querySelector('.modal-bg.open');
  if(!openModal) return;
  if(openModal.id === 'addBranchModal') closeAddBranch();
  else if(openModal.id === 'bulkAddModal') closeBulkAddShortage();
  else if(openModal.id === 'singleAddShortageModal') closeSingleAddShortage();
  else if(openModal.id === 'changePassModal') closeChangePassword();
  else openModal.classList.remove('open');
});

/* ===================== ADD / DELETE BRANCH ===================== */
function openAddBranch(){
  document.getElementById('addBranchModal').classList.add('open');
  document.getElementById('newBranchName').value='';
  document.getElementById('newBranchName').focus();
}
function closeAddBranch(){ document.getElementById('addBranchModal').classList.remove('open'); }
function confirmAddBranch(){
  const name = document.getElementById('newBranchName').value.trim();
  if(!name){ toast('اكتب اسم الفرع'); return; }
  const branches = getBranches();
  branches.push({id: uid(), name});
  saveBranches(branches);
  closeAddBranch();
  renderBranches();
  toast('تم إضافة الفرع: '+name);
}
/* كلمة سر حذف الفرع مخزّنة فى فايربيز تحت app_data/settings/deleteBranchPassword
   (مش مكتوبة نهائيًا فى كود الصفحة) — القيمة الافتراضية أول مرة فقط، وبعدها بتتقرأ من فايربيز */
const DELETE_BRANCH_PASSWORD_DEFAULT = '526933';
function deleteBranch(id){
  const b = getBranches().find(x=>x.id===id);
  if(!confirm('حذف فرع "'+(b?b.name:'')+'" نهائيًا مع كل بياناته (الليستة اليومية، النواقص، الريبورتات)؟')) return;
  const pass = prompt('أدخل كلمة السر لتأكيد حذف الفرع:');
  if(pass === null) return; // المستخدم لغى
  const correctPass = (cache.settings && cache.settings.deleteBranchPassword) || DELETE_BRANCH_PASSWORD_DEFAULT;
  if(String(pass) !== String(correctPass)){ toast('كلمة السر غير صحيحة — تم إلغاء الحذف'); return; }
  saveBranches(getBranches().filter(x=>x.id!==id));
  delete cache.main[id]; firebaseRemove('app_data/main/'+id);
  delete cache.shortage[id]; firebaseRemove('app_data/shortage/'+id);
  delete cache.reports[id]; firebaseRemove('app_data/reports/'+id);
  renderBranches();
  toast('تم حذف الفرع');
}

/* خريطة اسم الفرع -> حرف عمود الرصيد فى شيت الليستة اليومية الموحدة (شيت واحد لكل الفروع) */
const BRANCH_BALANCE_COLUMN = {
  "dar el yosr": "BT",
  "dar elyosr": "BT",
  "watanya": "BR",
  "midtown": "AH",
  "midtwon": "AH",
  "abaasya": "X",
  "j. tito": "BP",
  "j.tito": "BP",
  "j tito": "BP",
  "awl gamal": "AD"
};
function branchKeyClean(name){
  return String(name ?? "")
    .trim()
    .toLowerCase()
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}
/* نسخة بأسماء منظّفة (مفيش نقط/شرط) عشان تلاقي الفرع حتى لو كُتب بشكل مختلف شوية */
const BRANCH_BALANCE_COLUMN_CLEAN = {
  "dar el yosr": "BT",
  "dar el yossr": "BT",
  "dar el yousr": "BT",
  "dar elyosr": "BT",
  "dar elyossr": "BT",
  "watanya": "BR",
  "mid town": "AH",
  "midtown": "AH",
  "midtwon": "AH",
  "abaasya": "X",
  "abasiya": "X",
  "abaassia": "X",
  "j tito": "BP",
  "jtito": "BP",
  "awl gamal": "AD",
  "awl jamal": "AD"
};
function getBranchBalanceColumn(branchName){
  const exact = BRANCH_BALANCE_COLUMN[norm(branchName).toLowerCase()];
  if(exact) return exact;
  return BRANCH_BALANCE_COLUMN_CLEAN[branchKeyClean(branchName)] || null;
}
/* تحويل حرف عمود إكسل (زى A أو AH أو BT) إلى رقم عمود (index) يبدأ من صفر */
function colToIndex(letters){
  letters = String(letters || '').trim().toUpperCase();
  let idx = 0;
  for(let i = 0; i < letters.length; i++){
    const code = letters.charCodeAt(i) - 64; /* 'A' = 1 */
    if(code < 1 || code > 26) return -1;
    idx = idx * 26 + code;
  }
  return idx - 1;
}

/* قارئ ملفات موحّد وآمن لملفات Excel/CSV — يستخدم XLSX الموجود فى الصفحة */
async function readWorkbookRows(file){
  if(!file) throw new Error('NO_FILE');
  const name=String(file.name||'').toLowerCase();
  const ext=name.split('.').pop();
  if(!['xlsx','xls','csv'].includes(ext)) throw new Error('UNSUPPORTED_FILE');
  const buffer=await file.arrayBuffer();
  const wb=XLSX.read(buffer,{type:'array',cellDates:false,raw:true});
  if(!wb.SheetNames || !wb.SheetNames.length) throw new Error('EMPTY_WORKBOOK');
  const ws=wb.Sheets[wb.SheetNames[0]];
  if(!ws) throw new Error('EMPTY_SHEET');
  const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:'',raw:true,blankrows:false});
  if(!Array.isArray(rows) || !rows.length) throw new Error('EMPTY_SHEET');
  return rows.map(row=>Array.isArray(row)?row:[]);
}

/* رفع شيت واحد موحد لكل الفروع: A=كود الصنف، B=اسم الصنف، M=سعر الصنف، ورصيد كل فرع فى عموده الخاص */
async function handleUnifiedMainUpload(input){
  const file = input.files[0];
  if(!file) return;
  if(unifiedMainOperationBusy){ toast('انتظر انتهاء عملية حذف/رفع الليستة الموحدة'); input.value=''; return; }
  unifiedMainOperationBusy = true;
  const hasHeader = document.getElementById('unifiedMainHeader').checked;
  const statusEl = document.getElementById('unifiedMainStatus');
  const checklistEl = document.getElementById('unifiedMainChecklist');
  try{
    const rows = await readWorkbookRows(file);
    const dataRows = hasHeader ? rows.slice(1) : rows;

    const branches = getBranches();
    const matched = [], unmatched = [];
    const updates = {};

    branches.forEach(b=>{
      const colLetter = getBranchBalanceColumn(b.name);
      if(!colLetter){ unmatched.push(b.name); return; }
      const balCol = colToIndex(colLetter);
      const items = dataRows
        .filter(r => norm(r[0]) !== '')
        .map(r => ({
          code: norm(r[0]),
          name: norm(r[1]),
          category: norm(r[3]),
          relatedTo: norm(r[11]), /* عمود L: كود بديل/مرتبط بالصنف (Related to) */
          price: toNum(r[12]),
          qty: toNum(r[balCol])
        }));
      const data = {uploadedAt: now(), fileName: file.name, items};
      cache.main[b.id] = data;
      updates['app_data/main/'+b.id] = data;
      const withBalance = items.filter(it => it.qty > 0).length;
      matched.push({name: b.name, col: colLetter, count: items.length, withBalance});
    });

    /* Unified replacement: delete the old parent first, wait for Firebase, then write the new sheet immediately. */
    removePendingMainOutboxOps();
    try{
      await firebase.database().ref('app_data/main').remove();
      await firebaseBatchWriteNow(updates);
    }catch(writeErr){
      console.error('Unified main immediate Firebase write failed:', writeErr);
      firebaseBatchWrite(updates); /* guaranteed eventual fallback */
      throw writeErr;
    }

    renderBranches();
    if(statusEl) statusEl.innerHTML = `✅ تم رفع الليستة الموحدة ومزامنتها فورًا مع Firebase — ${matched.length} فرع`;

    if(checklistEl){
      const rowsHtml = matched.map(m => `
        <tr>
          <td>✅ ${escHtml(m.name)}</td>
          <td class="mono">${escHtml(m.col)}</td>
          <td>${m.count}</td>
          <td>${m.withBalance ? m.withBalance : `<span style="color:var(--red)">0 — تأكد من العمود</span>`}</td>
        </tr>`).join('');
      const unmatchedHtml = unmatched.map(n => `
        <tr>
          <td>⚠️ ${escHtml(n)}</td>
          <td colspan="3" style="color:var(--amber)">لا يوجد عمود رصيد محدد لهذا الفرع — لم يُحدَّث</td>
        </tr>`).join('');
      checklistEl.innerHTML = `
        <div class="table-wrap" style="margin-top:10px">
          <table class="rep-table">
            <thead><tr><th>الفرع</th><th>العمود</th><th>عدد الأصناف</th><th>أصناف برصيد &gt; 0</th></tr></thead>
            <tbody>${rowsHtml}${unmatchedHtml}</tbody>
          </table>
        </div>`;
    }

    let msg = 'تم رفع الليستة الموحدة: تحديث '+matched.length+' فرع';
    if(unmatched.length) msg += ' — بدون عمود رصيد محدد: '+unmatched.join('، ');
    toast(msg);
  }catch(err){
    console.error(err);
    const isWrite = err && (err.code || /Firebase|timeout|permission/i.test(String(err.message||'')));
    toast(isWrite ? 'حدث خطأ أثناء مزامنة الليستة مع Firebase' : 'حدث خطأ أثناء قراءة الملف');
  }finally{
    unifiedMainOperationBusy = false;
    input.value='';
  }
}

/* Column indices: A=0,B=1,C=2 ... M=12, P=15 */
async function handleMainUpload(branchId, input){
  const file = input.files[0];
  if(!file) return;
  const hasHeader = document.getElementById('mainHeader-'+branchId).checked;
  try{
    const rows = await readWorkbookRows(file);
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const items = dataRows
      .filter(r => norm(r[0]) !== '')
      .map(r => ({
        code: norm(r[0]),
        name: norm(r[1]),
        category: norm(r[3]),
        relatedTo: norm(r[11]), /* عمود L: كود بديل/مرتبط بالصنف (Related to) */
        price: toNum(r[12]),
        qty: toNum(r[15])
      }));
    saveMain(branchId, {uploadedAt: now(), fileName: file.name, items});
    toast('تم رفع الليستة اليومية: '+items.length+' صنف');
    renderBranches();
  }catch(err){
    console.error(err);
    toast('حدث خطأ أثناء قراءة الملف');
  }
  input.value='';
}

/* ليستة النواقص: عمود A فقط = كود الصنف. أي كود موجود هنا يتم حذف صنفه بالكامل من الريبورتات */
async function handleShortageUpload(branchId, input){
  const file = input.files[0];
  if(!file) return;
  const hasHeader = document.getElementById('shortHeader-'+branchId).checked;
  try{
    const rows = await readWorkbookRows(file);
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const items = dataRows
      .filter(r => norm(r[0]) !== '')
      .map(r => ({ code: norm(r[0]) }));
    saveShortage(branchId, {updatedAt: now(), items});
    toast('تم تحديث ليستة النواقص: '+items.length+' صنف');
    renderBranches();
  }catch(err){
    console.error(err);
    toast('حدث خطأ أثناء قراءة الملف');
  }
  input.value='';
}

/* ===================== SHORTAGE MANUAL EDIT ===================== */
function addShortageRow(branchId){
  const s = getShortage(branchId);
  s.items.push({code:''});
  s.updatedAt = now();
  saveShortage(branchId, s);
  renderBranches(branchId);
}
function updateShortageCell(branchId, idx, field, value){
  const s = getShortage(branchId);
  if(!s.items[idx]) return;
  s.items[idx][field] = field === 'code' ? norm(value) : value;
  s.updatedAt = now();
  saveShortage(branchId, s);
}
function removeShortageRow(branchId, idx){
  const s = getShortage(branchId);
  s.items.splice(idx,1);
  s.updatedAt = now();
  saveShortage(branchId, s);
  renderBranches(branchId);
}

/* تنقل بلوحة المفاتيح بين صفوف كود ليستة النواقص: Enter/سهم لأسفل للانتقال (أو إضافة صف جديد لو آخر صف)، سهم لأعلى للرجوع */
function handleShortageKeydown(e, branchId, idx){
  if(e.key === 'ArrowDown'){
    e.preventDefault();
    focusShortageRow(branchId, idx+1);
  } else if(e.key === 'ArrowUp'){
    e.preventDefault();
    focusShortageRow(branchId, idx-1);
  } else if(e.key === 'Enter'){
    e.preventDefault();
    const s = getShortage(branchId);
    if(idx === s.items.length - 1){
      addShortageRow(branchId);
      setTimeout(()=>focusShortageRow(branchId, idx+1), 0);
    } else {
      focusShortageRow(branchId, idx+1);
    }
  }
}
function focusShortageRow(branchId, idx){
  const table = document.getElementById('short-table-'+branchId);
  if(!table) return;
  const rows = table.querySelectorAll('tbody tr');
  if(idx < 0 || idx >= rows.length) return;
  const input = rows[idx].querySelector('.cell-input');
  if(input){ input.focus(); input.select(); }
}

/* ===================== SHORTAGE: SELECT & DELETE ===================== */
function toggleSelectAllShortage(branchId, checked){
  document.querySelectorAll('.short-check[data-branch="'+branchId+'"]').forEach(cb=>{ cb.checked = checked; });
}
function deleteSelectedShortage(branchId){
  const checked = document.querySelectorAll('.short-check[data-branch="'+branchId+'"]:checked');
  if(!checked.length){ toast('حدد صنف واحد على الأقل للحذف'); return; }
  if(!confirm('حذف '+checked.length+' صنف محدد من ليستة النواقص؟')) return;
  const idxs = Array.from(checked).map(cb => parseInt(cb.dataset.idx, 10)).sort((a,b)=>b-a);
  const s = getShortage(branchId);
  idxs.forEach(i => s.items.splice(i,1));
  s.updatedAt = now();
  saveShortage(branchId, s);
  renderBranches(branchId);
  toast('تم حذف '+idxs.length+' صنف');
}

/* حذف كل أصناف ليستة النواقص التي ليس لها رصيد (أو غير موجودة) فى الليستة اليومية */
function deleteNoBalanceShortage(branchId){
  const main = getMain(branchId);
  const s = getShortage(branchId);
  const idxs = s.items
    .map((it, idx) => idx)
    .filter(idx => {
      const code = s.items[idx].code;
      const found = main && main.items.find(m => m.code === code);
      return !found || found.qty <= 0;
    })
    .sort((a,b)=>b-a);
  if(!idxs.length){ toast('لا توجد أصناف بدون رصيد للحذف'); return; }
  if(!confirm('حذف '+idxs.length+' صنف بدون رصيد من ليستة النواقص؟')) return;
  idxs.forEach(i => s.items.splice(i,1));
  s.updatedAt = now();
  saveShortage(branchId, s);
  renderBranches(branchId);
  toast('تم حذف '+idxs.length+' صنف بدون رصيد');
}

/* حذف الأكواد المكررة فى ليستة النواقص، وترك أول ظهور لكل كود فقط (سواء اتكرر مرتين أو أكتر) */
function dedupeShortage(branchId){
  const s = getShortage(branchId);
  const seen = new Set();
  const deduped = [];
  let removed = 0;
  s.items.forEach(it=>{
    const code = norm(it.code);
    if(code !== '' && seen.has(code)){ removed++; return; }
    if(code !== '') seen.add(code);
    deduped.push(it);
  });
  if(!removed){ toast('لا توجد أكواد مكررة فى ليستة النواقص'); return; }
  if(!confirm('حذف '+removed+' كود مكرر من ليستة النواقص، وترك كود واحد فقط لكل صنف؟')) return;
  s.items = deduped;
  s.updatedAt = now();
  saveShortage(branchId, s);
  renderBranches(branchId);
  toast('تم حذف '+removed+' كود مكرر');
}

/* ===================== SHORTAGE: SINGLE ADD ===================== */
let singleAddShortageBranchId = null;
function openSingleAddShortage(branchId){
  if(!requireSharedPermission('inventorySingleAddShortage','ليس لديك صلاحية إضافة صنف واحد لفرع محدد')) return;
  singleAddShortageBranchId = branchId;
  const modal = document.getElementById('singleAddShortageModal');
  const label = document.getElementById('singleAddShortageBranchLabel');
  const input = document.getElementById('singleAddShortageCode');
  if(label) label.textContent = 'الفرع: ' + branchName(branchId);
  if(input){ input.value=''; setTimeout(()=>input.focus(),50); }
  if(modal) modal.classList.add('open');
}
function closeSingleAddShortage(){
  const modal = document.getElementById('singleAddShortageModal');
  if(modal) modal.classList.remove('open');
  singleAddShortageBranchId = null;
}
function confirmSingleAddShortage(){
  if(!requireSharedPermission('inventorySingleAddShortage','ليس لديك صلاحية إضافة صنف واحد لفرع محدد')) return;
  const branchId = singleAddShortageBranchId;
  const input = document.getElementById('singleAddShortageCode');
  const code = norm(input ? input.value : '');
  if(!branchId){ closeSingleAddShortage(); return; }
  if(!code){ toast('اكتب كود الصنف'); if(input) input.focus(); return; }
  const s = getShortage(branchId);
  if(s.items.some(it => norm(it.code) === code)){
    toast('هذا الصنف موجود بالفعل فى ليستة نواقص الفرع');
    return;
  }
  s.items.push({code});
  s.updatedAt = now();
  closeSingleAddShortage();
  renderBranches(branchId);
  toast('⏳ جارٍ حفظ الصنف في Firebase...');
  saveShortageImmediate(branchId, s).then(ok=>{
    if(ok) toast('✅ تم إضافة الصنف وحفظه فورًا في Firebase: ' + branchName(branchId));
    else toast('⚠️ تمت الإضافة محليًا وسيتم مزامنتها تلقائيًا', true);
    renderBranches(branchId);
  });
}

/* ===================== SHORTAGE: BULK ADD / REMOVE ===================== */
/* نفس المودال يُستخدم للإضافة وللحذف بالجملة معًا، بالتحكم عن طريق bulkOpMode */
let bulkAddBranchId = null;
let bulkOpMode = 'add'; // 'add' | 'remove'

function openBulkAddShortage(branchId){
  if(branchId === 'ALL' && !requireSharedPermission('inventoryBulkAddShortage','ليس لديك صلاحية إضافة أصناف بالجملة لكل الفروع')) return;
  openBulkShortageModal(branchId, 'add');
}
function openBulkRemoveShortage(branchId){
  if(branchId === 'ALL' && !requireSharedPermission('inventoryBulkRemoveShortage','ليس لديك صلاحية حذف أصناف بالجملة لكل الفروع')) return;
  openBulkShortageModal(branchId, 'remove');
}
function openBulkShortageModal(branchId, mode){
  bulkAddBranchId = branchId;
  bulkOpMode = mode;
  document.getElementById('bulkAddCodes').value = '';
  const isAll = branchId === 'ALL';
  const titleEl = document.getElementById('bulkAddModalTitle');
  const confirmBtn = document.getElementById('bulkAddConfirmBtn');
  if(mode === 'remove'){
    if(titleEl) titleEl.textContent = isAll ? 'حذف أصناف بالجملة من ليستة النواقص (كل الفروع)' : 'حذف أصناف بالجملة من ليستة النواقص';
    if(confirmBtn){ confirmBtn.textContent = 'حذف'; confirmBtn.className = 'btn btn-danger'; }
  }else{
    if(titleEl) titleEl.textContent = isAll ? 'إضافة أصناف بالجملة لليستة النواقص (كل الفروع)' : 'إضافة أصناف بالجملة';
    if(confirmBtn){ confirmBtn.textContent = 'إضافة'; confirmBtn.className = 'btn btn-accent'; }
  }
  document.getElementById('bulkAddModal').classList.add('open');
  setTimeout(()=>document.getElementById('bulkAddCodes').focus(), 100);
}
function closeBulkAddShortage(){
  document.getElementById('bulkAddModal').classList.remove('open');
  bulkAddBranchId = null;
}
function confirmBulkAddShortage(){
  if(!bulkAddBranchId) return;
  const raw = document.getElementById('bulkAddCodes').value;
  const codes = [...new Set(raw.split(/[\n,،\t]+/).map(c=>norm(c)).filter(Boolean))];
  if(!codes.length){ toast('اكتب أو الصق كودًا واحدًا على الأقل'); return; }
  const codeSet = new Set(codes.map(codeKey));
  const isRemove = bulkOpMode === 'remove';

  if(bulkAddBranchId === 'ALL'){
    if(isRemove && !requireSharedPermission('inventoryBulkRemoveShortage','ليس لديك صلاحية حذف أصناف بالجملة لكل الفروع')) return;
    if(!isRemove && !requireSharedPermission('inventoryBulkAddShortage','ليس لديك صلاحية إضافة أصناف بالجملة لكل الفروع')) return;
    const branches = getBranches();
    if(!branches.length){ toast('لا توجد فروع مضافة'); return; }

    const changedBranches = [];
    branches.forEach(b=>{
      const oldS = getShortage(b.id);
      const s = { updatedAt: oldS.updatedAt || null, items: Array.isArray(oldS.items) ? oldS.items.map(x=>({...x})) : [] };
      let changed = 0;
      if(isRemove){
        const before = s.items.length;
        s.items = s.items.filter(it => !codeSet.has(codeKey(it && it.code)));
        changed = before - s.items.length;
      }else{
        const existing = new Set(s.items.map(it=>codeKey(it && it.code)).filter(Boolean));
        codes.forEach(code=>{
          const k = codeKey(code);
          if(k && !existing.has(k)){ s.items.push({code}); existing.add(k); changed++; }
        });
      }
      if(changed > 0){
        s.updatedAt = now();
        cache.shortage[b.id] = s;
        changedBranches.push({branchId:b.id, data:s, changed});
      }
    });

    closeBulkAddShortage();
    rebuildChainSearchIndex();
    renderBranches();
    if(!changedBranches.length){
      toast(isRemove ? 'لا توجد أصناف مطلوبة للحذف' : 'كل الأصناف موجودة بالفعل في ليستة النواقص');
      return;
    }

    toast('⏳ حفظ مباشر في Firebase لكل الفروع...');
    const startedAt = Date.now();
    Promise.allSettled(changedBranches.map(x => firebaseWriteNow('app_data/shortage/'+x.branchId, x.data)))
      .then(results=>{
        const failed=[];
        results.forEach((r,i)=>{ if(r.status==='rejected') failed.push({...changedBranches[i], err:r.reason}); });
        if(failed.length){
          // Fallback only for failed branches; successful direct writes are not queued again.
          failed.forEach(x=>firebaseWrite('app_data/shortage/'+x.branchId, x.data));
          toast('⚠️ تم الحفظ مباشرة لـ '+(changedBranches.length-failed.length)+' فرع، وتعذر '+failed.length+' فرع وسيتم إعادة المحاولة');
        }else{
          toast((isRemove ? '✅ تم الحذف المباشر' : '✅ تمت الإضافة المباشرة')+' في '+changedBranches.length+' فرع خلال '+((Date.now()-startedAt)/1000).toFixed(1)+' ث');
        }
        rebuildChainSearchIndex();
        renderBranches();
      });
    return;
  }

  const s0 = getShortage(bulkAddBranchId);
  const s = { updatedAt:s0.updatedAt || null, items:Array.isArray(s0.items) ? s0.items.map(x=>({...x})) : [] };
  let changed = 0;
  if(isRemove){
    const before=s.items.length;
    s.items=s.items.filter(it=>!codeSet.has(codeKey(it&&it.code)));
    changed=before-s.items.length;
  }else{
    const existing=new Set(s.items.map(it=>codeKey(it&&it.code)).filter(Boolean));
    codes.forEach(code=>{ const k=codeKey(code); if(k&&!existing.has(k)){s.items.push({code});existing.add(k);changed++;} });
  }
  if(!changed){ toast(isRemove ? 'الصنف غير موجود في ليستة النواقص' : 'كل الأصناف موجودة بالفعل في ليستة النواقص'); return; }
  s.updatedAt=now();
  const branchId=bulkAddBranchId;
  cache.shortage[branchId]=s;
  closeBulkAddShortage();
  rebuildChainSearchIndex();
  renderBranches(branchId);
  toast('⏳ حفظ مباشر في Firebase...');
  saveShortageImmediate(branchId,s).then(ok=>{
    toast(ok ? (isRemove ? '✅ تم الحذف المباشر وحفظه في Firebase' : '✅ تمت الإضافة المباشرة وحفظها في Firebase') : '⚠️ تعذر الحفظ المباشر وسيتم إعادة المزامنة');
    renderBranches(branchId);
  });
}
/* ===================== CODE PREVIEW / SEARCH ===================== */
/* يبحث عن كود صنف في الليستة اليومية ويرجع HTML لعرض اسمه، لاستخدامه فى المعاينة والبحث */
function codePreviewHtml(main, code){
  const c = norm(code);
  if(!c) return {html:'', cls:''};
  const found = main && main.items.find(it => it.code === c);
  if(!found) return {html: '⚠ الكود غير موجود فى الليستة اليومية', cls:'warn'};
  if(found.qty <= 0) return {html: '⚠ ' + escHtml(found.name || '(بدون اسم)') + ' — بدون رصيد (0)', cls:'warn'};
  return {html: '✓ ' + escHtml(found.name || '(بدون اسم)') + ' — رصيد: ' + found.qty, cls:'ok'};
}

/* معاينة حية لاسم الصنف أثناء كتابة الكود فى ليستة النواقص، وتحديث بيانات البحث لحظيًا */
function previewShortageCode(branchId, idx, value){
  const el = document.getElementById('short-preview-'+branchId+'-'+idx);
  if(!el) return;
  const main = getMain(branchId);
  const p = codePreviewHtml(main, value);
  el.textContent = '';
  el.innerHTML = p.html;
  el.className = 'mini-preview ' + p.cls;

  // تحديث خصائص البحث على الصف نفسه أولًا بأول، بحيث تظهر الأصناف المضافة/المعدّلة يدويًا فى البحث فورًا
  const row = el.closest('tr');
  if(row){
    const c = norm(value);
    const found = main && main.items.find(m => m.code === c);
    row.dataset.code = c.toLowerCase();
    row.dataset.name = (found ? (found.name||'') : '').toLowerCase();
  }
}

/* بحث بالكود أو الاسم داخل الليستة اليومية للفرع */
function searchMainCode(branchId, value){
  const el = document.getElementById('main-search-result-'+branchId);
  if(!el) return;
  const q = norm(value).toLowerCase();
  if(!q){ el.innerHTML = ''; return; }
  const main = getMain(branchId);
  if(!main || !main.items.length){
    el.innerHTML = '<div class="mini-preview warn">لا توجد ليستة يومية مرفوعة لهذا الفرع</div>';
    return;
  }
  const matches = main.items.filter(it =>
    it.code.toLowerCase().includes(q) || (it.name||'').toLowerCase().includes(q)
  ).slice(0, 8);
  if(!matches.length){
    el.innerHTML = '<div class="mini-preview warn">⚠ لا يوجد صنف بهذا الكود أو الاسم</div>';
    return;
  }
  el.innerHTML = matches.map(it =>
    `<div class="mini-preview ok mono">✓ ${escHtml(it.code)} — ${escHtml(it.name || '(بدون اسم)')} (رصيد: ${it.qty})</div>`
  ).join('');
}

/* بحث بالكود أو الاسم داخل جدول ليستة النواقص (فلترة الصفوف المعروضة) */
function filterShortageTable(branchId, value){
  const q = norm(value).toLowerCase();
  document.querySelectorAll('#short-table-'+branchId+' tbody tr').forEach(tr=>{
    if(!q){ tr.style.display=''; return; }
    const code = (tr.dataset.code||'');
    const name = (tr.dataset.name||'');
    tr.style.display = (code.includes(q) || name.includes(q)) ? '' : 'none';
  });
}


/* بحث بالكود أو الاسم داخل جدول الريبورت الناتج (فلترة الصفوف المعروضة) — تُستخدم فى تاب الريبورتات وداخل كارت الفرع */
function filterReportRows(tableId, countId, value){
  const q = norm(value).toLowerCase();
  const rows = document.querySelectorAll('#'+tableId+' tbody tr');
  let visible = 0;
  rows.forEach(tr=>{
    const code = (tr.dataset.code||'');
    const name = (tr.dataset.name||'');
    const match = !q || code.includes(q) || name.includes(q);
    tr.style.display = match ? '' : 'none';
    if(match) visible++;
  });
  const countEl = document.getElementById(countId);
  if(countEl) countEl.textContent = q ? (visible+' صنف مطابق من إجمالي '+rows.length) : (rows.length+' صنف');
}
function filterBranchReportTable(branchId, value){
  filterReportRows('rep-table-branch-'+branchId, 'rep-count-branch-'+branchId, value);
}

/* ===================== GENERATE REPORTS ===================== */
function generateReportsCore(branchId, updates){
  const main = getMain(branchId);
  const shortage = getShortage(branchId);
  if(!main || !main.items.length) return null;

  const shortSet = new Set(shortage.items.map(s=>codeKey(s.code)).filter(Boolean));

  let removed = 0;
  const processed = main.items
    .filter(it=>{
      if(shortSet.has(codeKey(it.code))){ removed++; return false; }
      return true;
    })
    .map(it=>({code: it.code, name: it.name, price: it.price, balance: Math.floor(it.qty)}))
    .filter(it => it.balance >= 1); // نشيل أي صنف رصيده أقل من 1

  const data = {generatedAt: now(), items: processed, matchedCount: removed};
  cache.reports[branchId] = data;
  if(updates){ updates['app_data/reports/'+branchId] = data; }
  else { firebaseWrite('app_data/reports/'+branchId, data); }
  return {removed, count: processed.length};
}

/* أصناف الألبان: أي صنف تصنيفه (عمود D فى شيت الرفع) يحتوي على أحد هذه الكلمات
   يُستثنى من الحذف بسبب النواقص فى ريبورت Instashop فقط، ويظهر برصيده الفعلي من الليستة اليومية */
const MILK_CATEGORY_KEYWORDS = ['milk', 'baby milk powder and other babies & adults food'];
function isMilkCategory(category){
  const c = norm(category).toLowerCase();
  if(!c) return false;
  return MILK_CATEGORY_KEYWORDS.some(k => c.includes(k));
}

/* ريبورت Instashop: نفس منطق Vezeeta بالظبط، فيما عدا أصناف الألبان — لا تُحذف حتى لو كانت
   فى ليستة النواقص، وتظهر بالرصيد الفعلي من الليستة اليومية (حتى لو أقل من 1) بدلاً من إخفائها */
function generateInstashopReportCore(branchId, updates){
  const main = getMain(branchId);
  const shortage = getShortage(branchId);
  if(!main || !main.items.length) return null;

  const shortSet = new Set(shortage.items.map(s=>codeKey(s.code)).filter(Boolean));

  let removed = 0, milkKept = 0;
  const processed = main.items
    .filter(it=>{
      const milk = isMilkCategory(it.category);
      if(shortSet.has(codeKey(it.code))){
        if(milk){ milkKept++; return true; } // استثناء صنف الألبان من الحذف رغم وجوده فى النواقص
        removed++;
        return false;
      }
      return true;
    })
    .map(it=>({code: it.code, name: it.name, price: it.price, balance: Math.floor(it.qty), milk: isMilkCategory(it.category)}))
    .filter(it => it.milk || it.balance >= 1); // غير الألبان: نفس شرط الرصيد ≥ 1، الألبان: تظهر دائمًا برصيدها الفعلي

  const data = {generatedAt: now(), items: processed, matchedCount: removed, milkKept};
  cache.instashopReports[branchId] = data;
  if(updates){ updates['app_data/instashopReports/'+branchId] = data; }
  else { firebaseWrite('app_data/instashopReports/'+branchId, data); }
  return {removed, milkKept, count: processed.length};
}

function generateReports(branchId){
  const updates = {};
  const res = generateReportsCore(branchId, updates);
  if(!res){ toast('ارفع الليستة اليومية أولاً'); return; }
  generateInstashopReportCore(branchId, updates);
  firebaseBatchWrite(updates);
  renderBranches(branchId);
  toast('تم إنشاء الريبورتات — تم حذف '+res.removed+' صنف من ليستة النواقص بالكامل');
}

/* إنشاء/تحديث الريبورتات لكل الفروع دفعة واحدة */
function generateAllReports(){
  const branches = getBranches();
  const updates = {};
  let done = 0, skipped = 0;
  branches.forEach(b=>{
    const res = generateReportsCore(b.id, updates);
    if(res){ done++; generateInstashopReportCore(b.id, updates); }
    else skipped++;
  });
  firebaseBatchWrite(updates);
  renderBranches();
  toast(`تم إنشاء/تحديث الريبورتات لـ ${done} فرع` + (skipped ? ' — تم تخطي '+skipped+' فرع بدون ليستة يومية' : ''));
}

/* ===================== EXPORT XLSX ===================== */
function branchName(id){ const b = getBranches().find(x=>x.id===id); return b ? b.name : 'فرع'; }

/* أسماء ملفات طلبات Talabat الثابتة لكل فرع (كود الفرع كما هو متفق عليه) */
const TALABAT_CODE_MAP = {
  'dar elyosr': 'dar elyosr_761230',
  'watanya': 'watanya_764155',
  'j. tito': 'j. tito_761461',
  'awl gamal': 'awl gamal_1111859',
  'awl galam': 'awl gamal_1111859', /* تحسبًا لاختلاف كتابة الاسم */
  'midtwon': 'midtown_761462',
  'midtown': 'midtown_761462', /* تحسبًا لاختلاف كتابة الاسم */
  'abaasya': 'Abaasya_796706'
};
function talabatFileName(branchId){
  const rawName = branchName(branchId);
  const name = dedupeRepeatedBranchName(rawName);
  const mapped = TALABAT_CODE_MAP[name.trim().toLowerCase()];
  return mapped || name;
}

/* أسماء الفروع الثابتة لشيتات Vezeeta و Instashop (نفس التسمية للاثنين) */
const BRANCH_SHEET_NAME_MAP = {
  'dar elyosr': 'obour',
  'awl galam': 'gamal',
  'awl gamal': 'gamal',
  'midtown': 'midtown',
  'midtwon': 'midtown', /* تحسبًا لاختلاف كتابة الاسم */
  'j. tito': 'nozha',
  'watanya': 'watanya',
  'abaasya': 'abaasya'
};
/* لو اسم الفرع اتكتب أو اتخزن غلط بتكرار (مثلاً "midtown to midtown")
   بترجع الاسم مرة واحدة بس، عشان اسم الشيت والملف يطلع "midtown" مش "midtown to midtown" */
function dedupeRepeatedBranchName(rawName){
  const name = String(rawName || '').trim();
  const parts = name.split(/\s+to\s+/i).map(p => p.trim().toLowerCase()).filter(Boolean);
  if(parts.length > 1 && new Set(parts).every(p => p === parts[0])) return parts[0];
  return name;
}
function branchSheetFileName(branchId){
  const rawName = branchName(branchId);
  const name = dedupeRepeatedBranchName(rawName);
  const mapped = BRANCH_SHEET_NAME_MAP[name.trim().toLowerCase()];
  return mapped || name;
}

/* Excel لا يسمح بهذه الرموز في اسم الشيت: \ / ? * [ ] : */
function safeSheetName(name){
  return String(name).replace(/[\\/?*\[\]:]/g,'-').slice(0,31);
}

async function downloadVezeeta(branchId){
  const f = await buildVezeetaFile(branchId);
  if(!f){ toast('أنشئ الريبورتات أولاً'); return; }
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* يبني ملف Vezeeta لفرع معين بنفس الفورمات بالظبط اللى بيجي من فيزيتا نفسها:
   هيدر (كود / إسم الصنف / سعر البيع / الرصيد) كـ Excel Table حقيقي بستايل أزرق،
   خط الهيدر أبيض بولد وإيطاليك، عرض أعمدة مطابق، وصفوف متبادلة اللون.
   يرجّع الـ workbook + الـ blob + اسم الملف */
async function buildVezeetaFile(branchId){
  const r = getReports(branchId);
  if(!r) return null;

  const wb = new ExcelJS.Workbook();
  const name = branchSheetFileName(branchId);
  const sheetName = safeSheetName(name);
  const ws = wb.addWorksheet(sheetName);

  /* عرض الأعمدة بالظبط زي شيت فيزيتا الأصلي (بدون أي تنسيق إضافي - شيت عادي فاضي من الستايل) */
  ws.getColumn(1).width = 14.83203125;
  ws.getColumn(2).width = 34.83203125;
  ws.getColumn(3).width = 12.83203125;
  ws.getColumn(4).width = 10.83203125;

  ws.addRow(['كود الصنف', 'إسم الصنف', 'سعر البيع', 'الرصيد']);
  r.items.forEach(it => {
    ws.addRow([codeToNumber(it.code), it.name, it.price, it.balance]);
  });

  /* نفس الخط بالظبط لكل الصفوف (هيدر وبيانات) - بدون بولد ولا إيطاليك ولا تلوين */
  ws.eachRow(row => {
    row.eachCell(cell => { cell.font = { name:'Calibri', size:12 }; });
  });

  const buffer = await wb.xlsx.writeBuffer();
  const filename = sheetName + '.xlsx';
  return {
    workbook: wb,
    filename,
    blob: new Blob([buffer], {type:'application/octet-stream'})
  };
}

function downloadInstashop(branchId){
  const f = buildInstashopFile(branchId);
  if(!f){ toast('أنشئ الريبورتات أولاً'); return; }
  XLSX.writeFile(f.workbook, f.filename);
}

/* يبني ملف Instashop لفرع معين — نفس تفاصيل Vezeeta بالظبط، لكن من ريبورت Instashop المستقل
   (اللى بيستثنى أصناف الألبان من الحذف بسبب النواقص) */
function buildInstashopFile(branchId){
  const r = getInstashopReport(branchId);
  if(!r) return null;
  const aoa = [['كود الصنف','إسم الصنف','سعر البيع','الرصيد']];
  r.items.forEach(it => aoa.push([it.code, it.name, it.price, it.balance]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:14},{wch:34},{wch:12},{wch:10}];
  const wb = XLSX.utils.book_new();
  const name = branchSheetFileName(branchId);
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
  const arr = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  return {
    workbook: wb,
    filename: name+'.xlsx',
    blob: new Blob([arr], {type:'application/octet-stream'})
  };
}

/* تصدير ليستة النواقص: كود الصنف، اسم الصنف، الرصيد، السعر (الاسم/الرصيد/السعر من آخر ليستة يومية) */
function exportShortageSheet(branchId){
  const shortage = getShortage(branchId);
  if(!shortage.items.length){ toast('لا توجد ليستة نواقص لتصديرها'); return; }
  const main = getMain(branchId);
  const aoa = [['كود الصنف','اسم الصنف','رصيد الصنف','سعر الصنف']];
  shortage.items.forEach(it=>{
    const found = main && main.items.find(m => m.code === it.code);
    aoa.push([
      it.code,
      found ? found.name : '',
      found ? found.qty : '',
      found ? found.price : ''
    ]);
  });
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:14},{wch:34},{wch:12},{wch:12}];
  const wb = XLSX.utils.book_new();
  const name = branchName(branchId) + ' - نواقص';
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
  XLSX.writeFile(wb, name+'.xlsx');
}

/* يهرب أي قيمة لتناسب صيغة CSV (فواصل، اقتباسات، أسطر جديدة) */
function csvEscape(v){
  const s = String(v ?? '');
  if(/[",\r\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}

function downloadTalabat(branchId){
  const f = buildTalabatFile(branchId);
  if(!f){ toast('أنشئ الريبورتات أولاً'); return; }
  const url = URL.createObjectURL(f.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* يبني ملف Talabat (CSV) لفرع معين ويرجّع الـ blob + اسم الملف */
function buildTalabatFile(branchId){
  const r = getReports(branchId);
  if(!r) return null;
  const rows = [['sku','barcode','price','Active','quantity','maximum_sales_quantity']];
  r.items.forEach(it => rows.push([it.code, '', it.price, 1, '', it.balance]));
  const csv = rows.map(row => row.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], {type: 'text/csv;charset=utf-8;'});
  return { filename: talabatFileName(branchId) + '.csv', blob };
}

/* ===================== حفظ فى مجلد محدد على الجهاز (File System Access API) ===================== */
/* يدعمه Chrome / Edge فقط. أول استخدام هيطلب اختيار المجلد، وبعدين بيتفتكر تلقائيًا */
const DIR_HANDLE_DB = 'app_dir_handles';
function openHandleDB(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(DIR_HANDLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function saveDirHandle(key, handle){
  const db = await openHandleDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('handles','readwrite');
    tx.objectStore('handles').put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function loadDirHandle(key){
  const db = await openHandleDB();
  return new Promise((resolve, reject)=>{
    const tx = db.transaction('handles','readonly');
    const req = tx.objectStore('handles').get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/* يرجّع مجلد جاهز للكتابة، ويطلب من المستخدم يختاره أول مرة بس */
async function ensureDirAccess(key, folderLabel){
  if(!window.showDirectoryPicker){
    return null;
  }
  let handle = null;
  try{ handle = await loadDirHandle(key); }catch(e){ handle = null; }

  if(handle){
    try{
      const perm = await handle.queryPermission({mode:'readwrite'});
      if(perm === 'granted') return handle;
      const reqPerm = await handle.requestPermission({mode:'readwrite'});
      if(reqPerm === 'granted') return handle;
    }catch(e){ /* الهاندل القديم بقى غير صالح، هنختار تاني */ }
  }

  toast('اختر المجلد: '+folderLabel);
  try{
    handle = await window.showDirectoryPicker({mode:'readwrite'});
    await saveDirHandle(key, handle);
    return handle;
  }catch(e){
    return null; // المستخدم لغى الاختيار
  }
}

async function writeFileToDir(dirHandle, filename, blob){
  const fileHandle = await dirHandle.getFileHandle(filename, {create:true});
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/* تصدير كل شيتات Vezeeta لكل الفروع دفعة واحدة */
/* فروع مستثناة من التصدير الجماعى لكل نوع ريبورت (بالاسم كما هو مكتوب فى النظام، بحروف صغيرة) */
const VEZEETA_EXPORT_EXCLUDE = ['dar elyosr'];
const INSTASHOP_EXPORT_EXCLUDE = ['abaasya'];

async function exportAllVezeetaToFolder(){
  const branches = getBranches()
    .filter(b => getReports(b.id))
    .filter(b => !VEZEETA_EXPORT_EXCLUDE.includes(norm(b.name).toLowerCase()));
  if(!branches.length){ toast('لا توجد ريبورتات لتصديرها — أنشئ الريبورتات أولاً'); return; }

  if(window.showDirectoryPicker){
    const dir = await ensureDirAccess('vezeetaDir', 'vezeeta sheet daily');
    if(dir){
      let count = 0;
      for(const b of branches){
        const f = await buildVezeetaFile(b.id);
        if(!f) continue;
        await writeFileToDir(dir, f.filename, f.blob);
        count++;
      }
      toast(`تم حفظ ${count} شيت Vezeeta فى المجلد المحدد (بدون Dar elyosr)`);
      return;
    }
    toast('لم يتم اختيار مجلد — تم إلغاء العملية');
    return;
  }

  // متصفح لا يدعم الحفظ التلقائى: تنزيل عادى لكل الملفات
  branches.forEach((b, i)=>{ setTimeout(()=>downloadVezeeta(b.id), i*400); });
  toast('متصفحك لا يدعم الحفظ التلقائى فى مجلد (استخدم Chrome أو Edge) — سيتم تنزيل الملفات لمجلد التنزيلات، وانقلها يدويًا للمسار المطلوب');
}

/* تصدير كل شيتات Instashop لكل الفروع دفعة واحدة — مسار حفظ مستقل عن فيزيتا */
async function exportAllInstashopToFolder(){
  const branches = getBranches()
    .filter(b => getInstashopReport(b.id))
    .filter(b => !INSTASHOP_EXPORT_EXCLUDE.includes(norm(b.name).toLowerCase()));
  if(!branches.length){ toast('لا توجد ريبورتات Instashop لتصديرها — أنشئ الريبورتات أولاً'); return; }

  if(window.showDirectoryPicker){
    const dir = await ensureDirAccess('instashopDir', 'instashop sheet daily');
    if(dir){
      let count = 0;
      for(const b of branches){
        const f = buildInstashopFile(b.id);
        if(!f) continue;
        await writeFileToDir(dir, f.filename, f.blob);
        count++;
      }
      toast(`تم حفظ ${count} شيت Instashop فى المجلد المحدد (بدون Abaasya)`);
      return;
    }
    toast('لم يتم اختيار مجلد — تم إلغاء العملية');
    return;
  }

  // متصفح لا يدعم الحفظ التلقائى: تنزيل عادى لكل الملفات
  branches.forEach((b, i)=>{ setTimeout(()=>downloadInstashop(b.id), i*400); });
  toast('متصفحك لا يدعم الحفظ التلقائى فى مجلد (استخدم Chrome أو Edge) — سيتم تنزيل الملفات لمجلد التنزيلات، وانقلها يدويًا للمسار المطلوب');
}

/* تصدير كل ملفات Talabat لكل الفروع دفعة واحدة */
async function exportAllTalabatToFolder(){
  const branches = getBranches().filter(b => getReports(b.id));
  if(!branches.length){ toast('لا توجد ريبورتات لتصديرها — أنشئ الريبورتات أولاً'); return; }

  if(window.showDirectoryPicker){
    const dir = await ensureDirAccess('talabatDir', 'instashop & vezeeta sheet daily \\ (Talabat) \\ Active_Wells \\ Active_Wells');
    if(dir){
      let count = 0;
      for(const b of branches){
        const f = buildTalabatFile(b.id);
        if(!f) continue;
        await writeFileToDir(dir, f.filename, f.blob);
        count++;
      }
      toast(`تم حفظ ${count} ملف Talabat فى المجلد المحدد`);
      return;
    }
    toast('لم يتم اختيار مجلد — تم إلغاء العملية');
    return;
  }

  // متصفح لا يدعم الحفظ التلقائى: تنزيل عادى لكل الملفات
  branches.forEach((b, i)=>{ setTimeout(()=>downloadTalabat(b.id), i*400); });
  toast('متصفحك لا يدعم الحفظ التلقائى فى مجلد (استخدم Chrome أو Edge) — سيتم تنزيل الملفات لمجلد التنزيلات، وانقلها يدويًا للمسار المطلوب');
}

/* ===================== RENDER BRANCHES ===================== */
function renderBranches(keepOpenId){
  const list = document.getElementById('branches-list');
  const branches = getBranches();
  if(!branches.length){
    list.innerHTML = '<div class="empty"><b>لا يوجد فروع بعد</b>ابدأ بإضافة فرع من الزر أعلى الصفحة</div>';
    return;
  }
  list.innerHTML = branches.map(b => renderBranchCard(b, b.id === keepOpenId)).join('');
}

function renderBranchCard(b, isOpen){
  const main = getMain(b.id);
  const shortage = getShortage(b.id);
  const reports = getReports(b.id);
  const instashop = getInstashopReport(b.id);

  const mainBadge = main ? `<span class="badge badge-ok">آخر تحديث: ${fmtDate(main.uploadedAt)}</span>` : `<span class="badge badge-off">لم يتم الرفع</span>`;
  const shortBadge = shortage.items.length ? `<span class="badge badge-ok">${shortage.items.length} صنف ناقص</span>` : `<span class="badge badge-off">لا توجد نواقص</span>`;
  const repBadge = reports ? `<span class="badge badge-warn">تُحذف ${fmtDate(reports.generatedAt + 1000*60*60*24*2)}</span>` : `<span class="badge badge-off">لا يوجد ريبورت</span>`;
  const instashopBadge = instashop ? `<span class="badge badge-warn">تُحذف ${fmtDate(instashop.generatedAt + 1000*60*60*24*2)}</span>` : `<span class="badge badge-off">لا يوجد ريبورت</span>`;

  /* محتوى تفاصيل الفرع (الجداول التقيلة) بيتبني بس لو الكارت مفتوح فعلاً — الفروع المقفولة
     بتاخد div فاضي، وبيتبني محتواها أول ما المستخدم يفتحها (lazy render) — ده بيقلل شغل
     المتصفح جدًا خصوصًا مع عدد فروع/أصناف كبير */
  const bodyContent = isOpen ? renderBranchBody(b) : '';

  return `
  <div class="branch-card">
    <div class="branch-head" onclick="toggleBranch('${b.id}')">
      <div class="name"><span class="dot"></span><h3>${escHtml(b.name)}</h3></div>
      <div class="branch-meta">
        <span>الليستة اليومية ${mainBadge}</span>
        <span>النواقص ${shortBadge}</span>
        <span>Vezeeta ${repBadge}</span>
        <span>Instashop ${instashopBadge}</span>
      </div>
      <button class="btn btn-danger btn-sm" onclick="event.stopPropagation(); deleteBranch('${b.id}')">حذف الفرع</button>
    </div>
    <div class="branch-body${isOpen ? ' open' : ''}" id="body-${b.id}" data-rendered="${isOpen ? '1' : '0'}">${bodyContent}</div>
  </div>`;
}

/* يبني محتوى تفاصيل الفرع (الجداول) لوحده — بيتنادى إما فورًا لو الفرع مفتوح وقت renderBranches،
   أو لاحقًا لحظة ما المستخدم يفتح فرع كان مقفول (lazy) */
function toggleBranch(branchId){
  const list = document.getElementById('branches-list');
  if(!list) return;
  const target = document.getElementById('body-' + branchId);
  if(!target) return;

  const willOpen = !target.classList.contains('open');

  // اقفل كل الفروع الأخرى أولًا — فرع واحد فقط مفتوح في نفس الوقت.
  list.querySelectorAll('.branch-body.open').forEach(el => {
    if(el.id !== 'body-' + branchId) {
      el.classList.remove('open');
      el.innerHTML = '';
      el.dataset.rendered = '0';
    }
  });

  // سجّل الفرع المفتوح حاليًا عشان تحديثات فايربيز اللاحقة تحافظ عليه مفتوح (راجع attachDataListener).
  currentOpenBranchId = willOpen ? branchId : null;

  if(!willOpen){
    target.classList.remove('open');
    target.innerHTML = '';
    target.dataset.rendered = '0';
    return;
  }

  const branch = getBranches().find(b => String(b.id) === String(branchId));
  if(!branch) return;

  // افتح الكارت أولًا حتى تظهر الاستجابة فورًا.
  target.classList.add('open');
  target.innerHTML = '<div class="empty"><b>جارٍ فتح الفرع...</b></div>';
  target.dataset.rendered = '0';

  // بناء الجداول الثقيلة بعد لحظة، حتى لا تتجمد الواجهة أثناء الـclick.
  setTimeout(() => {
    if(!target.classList.contains('open')) return;
    const latest = getBranches().find(b => String(b.id) === String(branchId));
    if(!latest) return;
    try{
      target.innerHTML = renderBranchBody(latest);
      target.dataset.rendered = '1';
    }catch(err){
      console.error('renderBranchBody error:', err);
      target.innerHTML = '<div class="empty"><b>تعذر فتح بيانات الفرع</b><br>حدث خطأ أثناء عرض البيانات.</div>';
    }
  }, 0);
}

function renderBranchBody(b){
  const main = getMain(b.id);
  const shortage = getShortage(b.id);
  const reports = getReports(b.id);
  const instashop = getInstashopReport(b.id);

  /* خريطة كود->صنف تتبني مرة واحدة بس هنا، بدل ما نعمل .find() بطيء لكل صنف نواقص لوحده */
  const mainByCode = main ? new Map(main.items.map(m=>[m.code, m])) : null;

  const shortRows = shortage.items.map((it, idx) => {
    const preview = codePreviewHtml(main, it.code);
    const foundItem = mainByCode ? mainByCode.get(it.code) : null;
    const resolvedName = foundItem ? foundItem.name : '';
    return `
    <tr data-code="${escAttr((it.code||'').toLowerCase())}" data-name="${escAttr((resolvedName||'').toLowerCase())}">
      <td style="width:6%"><input type="checkbox" class="short-check" data-branch="${b.id}" data-idx="${idx}"></td>
      <td>
        <input class="cell-input mono" value="${escAttr(it.code)}" oninput="previewShortageCode('${b.id}',${idx},this.value)" onchange="updateShortageCell('${b.id}',${idx},'code',this.value)" onkeydown="handleShortageKeydown(event,'${b.id}',${idx})">
        <div class="mini-preview ${preview.cls}" id="short-preview-${b.id}-${idx}">${preview.html}</div>
      </td>
      <td><span class="del-x" onclick="removeShortageRow('${b.id}',${idx})">×</span></td>
    </tr>`;
  }).join('');

  const noBalanceCodes = shortage.items
    .map(it => it.code)
    .filter(Boolean)
    .filter(code => {
      const found = mainByCode ? mainByCode.get(code) : null;
      return !found || found.qty <= 0;
    });

  const duplicateShortageCount = (()=>{
    const seen = new Set();
    let dupCount = 0;
    shortage.items.forEach(it=>{
      const code = norm(it.code);
      if(code === '') return;
      if(seen.has(code)) dupCount++;
      else seen.add(code);
    });
    return dupCount;
  })();

  const reportRows = reports ? reports.items.map(it=>
    `<tr data-code="${escAttr((it.code||'').toLowerCase())}" data-name="${escAttr((it.name||'').toLowerCase())}"><td class="mono">${escHtml(it.code)}</td><td>${escHtml(it.name)}</td><td>${it.price}</td><td>${it.balance}</td></tr>`
  ).join('') : '';

  return `
      <div class="grid3">

        <div class="box">
          <h4>الليستة اليومية (الأرصدة)</h4>
          <div class="sub">تُحدَّث تلقائيًا من الرفع الموحد أعلى الصفحة. ويمكنك هنا رفع ملف لهذا الفرع بمفرده يدويًا عند الحاجة (A كود الصنف · B اسم الصنف · M سعر الصنف · P كمية الصنف).</div>
          <div class="row-check"><input type="checkbox" id="mainHeader-${b.id}" checked> <label for="mainHeader-${b.id}">الصف الأول عناوين</label></div>
          <input type="file" accept=".xlsx,.xls,.csv" onchange="handleMainUpload('${b.id}', this)">
          <div class="status">
            ${main ? `📄 ${escHtml(main.fileName || 'ملف غير معروف الاسم')}<br>آخر رفع: ${fmtDate(main.uploadedAt)} — ${main.items.length} صنف` : 'لم يتم رفع أي ليستة بعد'}
          </div>
          <input class="code-search" placeholder="ابحث بالكود..." oninput="searchMainCode('${b.id}', this.value)">
          <div id="main-search-result-${b.id}"></div>
        </div>

        <div class="box">
          <h4>ليستة النواقص (ثابتة — تحديث أسبوعي)</h4>
          <div class="sub">عمود واحد فقط: A = كود الصنف. أي كود موجود في هذه الليستة يُحذف صنفه بالكامل من الريبورتات</div>
          <div class="row-check"><input type="checkbox" id="shortHeader-${b.id}" checked> <label for="shortHeader-${b.id}">الصف الأول عناوين</label></div>
          <input type="file" accept=".xlsx,.xls,.csv" onchange="handleShortageUpload('${b.id}', this)">
          <div class="status">${shortage.items.length ? `آخر تحديث: ${fmtDate(shortage.updatedAt)} — ${shortage.items.length} صنف` : 'لا توجد ليستة نواقص'}</div>
          ${noBalanceCodes.length ? `<button class="btn btn-danger btn-sm" style="margin-top:8px; width:100%" onclick="deleteNoBalanceShortage('${b.id}')">🗑 حذف ${noBalanceCodes.length} صنف بدون رصيد</button>` : ''}
          ${duplicateShortageCount ? `<button class="btn btn-danger btn-sm" style="margin-top:8px; width:100%" onclick="dedupeShortage('${b.id}')">🗑 حذف ${duplicateShortageCount} كود مكرر</button>` : ''}
          <input class="code-search" placeholder="ابحث بالكود أو الاسم..." oninput="filterShortageTable('${b.id}', this.value)">
          ${shortage.items.length ? `
          <div style="display:flex; align-items:center; justify-content:space-between; margin-top:8px; gap:8px;">
            <label style="display:flex; align-items:center; gap:5px; font-size:12px; color:var(--ink-soft);">
              <input type="checkbox" onchange="toggleSelectAllShortage('${b.id}', this.checked)"> تحديد الكل
            </label>
            <button class="btn btn-danger btn-sm" onclick="deleteSelectedShortage('${b.id}')">حذف المحدد</button>
          </div>
          <div class="table-wrap">
            <table class="data" id="short-table-${b.id}">
              <thead><tr><th style="width:6%"></th><th style="width:79%">الكود</th><th style="width:8%"></th></tr></thead>
              <tbody>${shortRows}</tbody>
            </table>
          </div>` : ''}
          ${hasSharedPermission('inventorySingleAddShortage') ? `<button class="btn btn-accent btn-sm" style="width:100%; margin-top:10px" onclick="openSingleAddShortage('${b.id}')">+ إضافة صنف واحد لهذا الفرع</button>` : ''}
          ${hasSharedPermission('inventoryBulkAddShortage') ? `<button class="btn btn-ghost btn-sm" style="width:100%; margin-top:8px" onclick="openBulkAddShortage('${b.id}')">+ إضافة أصناف بالجملة</button>` : ''}
          ${shortage.items.length ? `<button class="btn btn-accent btn-sm" style="width:100%; margin-top:8px" onclick="exportShortageSheet('${b.id}')">⬇ Export sheet</button>` : ''}
        </div>

        <div class="box">
          <h4>الريبورتات</h4>
          <div class="sub">يتم حذف أصناف النواقص بالكامل من الليستة، ثم توليد ريبورت Vezeeta و Instashop و Talabat. فى Instashop فقط: أصناف الألبان (milk / Baby Milk Powder And Other babies &amp; Adults Food فى عمود D) لا تُحذف حتى لو كانت فى النواقص، وتظهر برصيدها الفعلي.</div>
          <button class="btn btn-accent btn-sm" style="width:100%" ${(!main||!main.items.length) ? 'disabled' : ''} onclick="generateReports('${b.id}')">إنشاء / تحديث الريبورتات</button>
          ${reports ? `
            <div class="status" style="margin-top:10px">Vezeeta — تم الإنشاء: ${fmtDate(reports.generatedAt)}<br>تم حذف ${reports.matchedCount} صنف (ليستة النواقص)<br>الإجمالي بعد الحذف: <b>${reports.items.length}</b> صنف</div>
            ${instashop ? `<div class="status" style="margin-top:6px">Instashop — تم الإنشاء: ${fmtDate(instashop.generatedAt)}<br>تم حذف ${instashop.matchedCount} صنف — واستُثنى ${instashop.milkKept||0} صنف ألبان من الحذف<br>الإجمالي: <b>${instashop.items.length}</b> صنف</div>` : ''}
            <div class="reports-actions">
              <button class="btn btn-ghost btn-sm" onclick="downloadVezeeta('${b.id}')">⬇ Vezeeta</button>
              ${instashop ? `<button class="btn btn-ghost btn-sm" onclick="downloadInstashop('${b.id}')">⬇ Instashop</button>` : ''}
              <button class="btn btn-ghost btn-sm" onclick="downloadTalabat('${b.id}')">⬇ Talabat (CSV)</button>
            </div>
            <input class="code-search" style="margin-top:10px" placeholder="ابحث بالكود أو الاسم فى ريبورت Vezeeta..." oninput="filterBranchReportTable('${b.id}', this.value)">
            <div class="table-wrap" style="max-height:200px">
              <table class="rep-table" id="rep-table-branch-${b.id}">
                <thead><tr><th>الكود</th><th>اسم الصنف</th><th>السعر</th><th>الرصيد</th></tr></thead>
                <tbody>${reportRows}</tbody>
              </table>
            </div>
            <div class="hint" id="rep-count-branch-${b.id}" style="padding:6px 2px 0">${reports.items.length} صنف (Vezeeta)</div>
            <div class="expiry-note">سيُحذف هذا الريبورت تلقائيًا في ${fmtDate(reports.generatedAt + 1000*60*60*24*2)}</div>
          ` : `<div class="status">لا يوجد ريبورت بعد</div>`}
        </div>

      </div>
  `;
}

/* ===================== أصناف غير متوفرة على الأبليكيشن ===================== */
const APP_LIST = ['instashop','vezeeta','talabat'];
const APP_LABELS = {instashop:'Instashop', vezeeta:'Vezeeta', talabat:'Talabat'};

function getCatalog(branchId, app){
  return (cache.catalogs && cache.catalogs[branchId] && cache.catalogs[branchId][app]) || null;
}
function getAppAvailable(branchId, app){
  return (cache.appAvailable && cache.appAvailable[branchId] && cache.appAvailable[branchId][app]) || null;
}
function getUnavailableReport(branchId, app){
  return (cache.unavailableReports && cache.unavailableReports[branchId] && cache.unavailableReports[branchId][app]) || null;
}

/* رفع الشيت الأصلى (الكتالوج الحقيقى) لأبليكيشن معين لفرع معين: A كود الصنف، B Related to، C اسم الصنف، D كمية الصنف، E السعر */
async function handleCatalogUpload(branchId, app, input){
  const file = input.files[0];
  if(!file) return;
  const headerEl = document.getElementById('catHeader-'+app+'-'+branchId);
  const hasHeader = headerEl ? headerEl.checked : true;
  try{
    const rows = await readWorkbookRows(file);
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const items = dataRows
      .filter(r => norm(r[0]) !== '')
      .map(r => ({
        code: norm(r[0]),
        relatedTo: norm(r[1]),
        name: norm(r[2]),
        qty: toNum(r[3]),
        price: toNum(r[4])
      }));
    const data = {uploadedAt: now(), fileName: file.name, items};
    cache.catalogs[branchId] = cache.catalogs[branchId] || {};
    cache.catalogs[branchId][app] = data;
    firebaseWrite('app_data/catalogs/'+branchId+'/'+app, data);
    toast('تم رفع الشيت الأصلى لـ '+APP_LABELS[app]+': '+items.length+' صنف');
    renderUnavailableList(branchId);
  }catch(err){
    console.error(err);
    toast('حدث خطأ أثناء قراءة الملف');
  }
  input.value='';
}

function clearCatalog(branchId, app){
  if(!confirm('هل تريد حذف الشيت الأصلى لـ '+APP_LABELS[app]+' لهذا الفرع؟')) return;
  if(cache.catalogs[branchId]) delete cache.catalogs[branchId][app];
  firebaseRemove('app_data/catalogs/'+branchId+'/'+app);
  if(cache.unavailableReports[branchId]) delete cache.unavailableReports[branchId][app];
  firebaseRemove('app_data/unavailableReports/'+branchId+'/'+app);
  toast('تم حذف الشيت الأصلى');
  renderUnavailableList(branchId);
}

/* رفع شيت "المتوفر فعليًا على الأبليكيشن الآن" لفرع/أبليكيشن معين — عمود A فقط = كود الصنف
   (أى أعمدة تانية فى الشيت بيتم تجاهلها، زى منطق رفع ليستة النواقص بالظبط) */
async function handleAppAvailableUpload(branchId, app, input){
  const file = input.files[0];
  if(!file) return;
  const headerEl = document.getElementById('availHeader-'+app+'-'+branchId);
  const hasHeader = headerEl ? headerEl.checked : true;
  try{
    const rows = await readWorkbookRows(file);
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const items = dataRows
      .filter(r => norm(r[0]) !== '')
      .map(r => ({ code: norm(r[0]) }));
    const data = {uploadedAt: now(), fileName: file.name, items};
    cache.appAvailable[branchId] = cache.appAvailable[branchId] || {};
    cache.appAvailable[branchId][app] = data;
    firebaseWrite('app_data/appAvailable/'+branchId+'/'+app, data);
    toast('تم رفع شيت المتوفر فعليًا على '+APP_LABELS[app]+': '+items.length+' صنف');
    renderUnavailableList(branchId);
  }catch(err){
    console.error(err);
    toast('حدث خطأ أثناء قراءة الملف');
  }
  input.value='';
}

function clearAppAvailable(branchId, app){
  if(!confirm('هل تريد حذف شيت المتوفر فعليًا على '+APP_LABELS[app]+' لهذا الفرع؟')) return;
  if(cache.appAvailable[branchId]) delete cache.appAvailable[branchId][app];
  firebaseRemove('app_data/appAvailable/'+branchId+'/'+app);
  if(cache.unavailableReports[branchId]) delete cache.unavailableReports[branchId][app];
  firebaseRemove('app_data/unavailableReports/'+branchId+'/'+app);
  toast('تم حذف شيت المتوفر فعليًا');
  renderUnavailableList(branchId);
}

/* المرجع الحقيقى (رصيد الفرع الفعلى) = الشيت الأصلى + أى كود فى ليستة النواقص مش موجود بالفعل
   فى الشيت الأصلى (بيتضاف تلقائيًا، والاسم/الكمية/السعر بتتجاب من الليستة اليومية لو موجود الكود بيها) */
function buildReferenceItems(branchId, app){
  const catalog = getCatalog(branchId, app);
  if(!catalog || !catalog.items.length) return null;

  const shortage = getShortage(branchId);
  const main = getMain(branchId);
  const mainByCode = main ? new Map(main.items.map(m=>[m.code, m])) : null;

  const map = new Map();
  catalog.items.forEach(it=>{
    if(it.code && !map.has(it.code)) map.set(it.code, it);
  });
  shortage.items.forEach(s=>{
    const code = norm(s.code);
    if(!code || map.has(code)) return;
    const found = mainByCode ? mainByCode.get(code) : null;
    map.set(code, {
      code,
      relatedTo: found ? found.relatedTo : '',
      name: found ? found.name : '',
      qty: found ? found.qty : 0,
      price: found ? found.price : 0
    });
  });
  return Array.from(map.values());
}

/* يقارن المرجع الحقيقى (الشيت الأصلى + النواقص) بشيت "المتوفر فعليًا على الأبليكيشن"،
   ويحفظ ريبورت بكل كود موجود فى المرجع لكن مش موجود فى شيت المتوفر فعليًا */
function generateUnavailableReportCore(branchId, app, updates){
  const referenceItems = buildReferenceItems(branchId, app);
  if(!referenceItems || !referenceItems.length) return null;

  const appAvail = getAppAvailable(branchId, app);
  if(!appAvail || !appAvail.items.length) return null;

  const availSet = new Set(appAvail.items.map(i=>i.code).filter(Boolean));
  const unavailable = referenceItems.filter(it => it.code && !availSet.has(it.code));
  const data = {generatedAt: now(), items: unavailable, totalCatalog: referenceItems.length};
  cache.unavailableReports[branchId] = cache.unavailableReports[branchId] || {};
  cache.unavailableReports[branchId][app] = data;
  const path = 'app_data/unavailableReports/'+branchId+'/'+app;
  if(updates){ updates[path] = data; } else { firebaseWrite(path, data); }
  return {count: unavailable.length, total: referenceItems.length};
}

function generateUnavailableForBranch(branchId){
  const updates = {};
  let done = 0;
  APP_LIST.forEach(app=>{

    const res = generateUnavailableReportCore(branchId, app, updates);
    if(res) done++;
  });
  if(!done){ toast('ارفع الشيت الأصلى وشيت المتوفر فعليًا لأبليكيشن واحد على الأقل لهذا الفرع'); return; }
  firebaseBatchWrite(updates);
  renderUnavailableList(branchId);
  toast('تم مقارنة '+done+' أبليكيشن لهذا الفرع');
}

function generateUnavailableForAllBranches(){
  const branches = getBranches();
  const updates = {};
  let doneBranches = 0;
  branches.forEach(b=>{
    let doneApp = false;
    APP_LIST.forEach(app=>{
      const res = generateUnavailableReportCore(b.id, app, updates);
      if(res) doneApp = true;
    });
    if(doneApp) doneBranches++;
  });
  if(!doneBranches){ toast('لا توجد شيتات كاملة (أصلى + متوفر فعليًا) مرفوعة لأى فرع بعد'); return; }
  firebaseBatchWrite(updates);
  toast('تم تحديث الريبورتات لـ '+doneBranches+' فرع');
}

/* ===================== EXPORT: أصناف غير متوفرة ===================== */
function buildUnavailableFile(branchId, app){
  const r = getUnavailableReport(branchId, app);
  if(!r) return null;
  const aoa = [['كود الصنف','Related to','اسم الصنف','كمية الصنف','السعر']];
  r.items.forEach(it => aoa.push([it.code, it.relatedTo||'', it.name, it.qty, it.price]));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{wch:14},{wch:14},{wch:34},{wch:12},{wch:12}];
  const wb = XLSX.utils.book_new();
  const name = branchName(branchId)+' - '+APP_LABELS[app]+' - غير متوفر';
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name));
  const arr = XLSX.write(wb, {bookType:'xlsx', type:'array'});
  return {
    workbook: wb,
    filename: name+'.xlsx',
    blob: new Blob([arr], {type:'application/octet-stream'})
  };
}
function downloadUnavailable(branchId, app){
  const f = buildUnavailableFile(branchId, app);
  if(!f){ toast('أنشئ الريبورت أولاً (اضغط قارن)'); return; }
  XLSX.writeFile(f.workbook, f.filename);
}

async function exportAllUnavailableToFolder(app){
  const branches = getBranches().filter(b => getUnavailableReport(b.id, app));
  if(!branches.length){ toast('لا توجد ريبورتات '+APP_LABELS[app]+' لتصديرها — اضغط قارن أولاً'); return; }

  if(window.showDirectoryPicker){
    const dir = await ensureDirAccess('unavailable'+app+'Dir', 'أصناف غير متوفرة - '+APP_LABELS[app]);
    if(dir){
      let count = 0;
      for(const b of branches){
        const f = buildUnavailableFile(b.id, app);
        if(!f) continue;
        await writeFileToDir(dir, f.filename, f.blob);
        count++;
      }
      toast(`تم حفظ ${count} شيت فى المجلد المحدد`);
      return;
    }
    toast('لم يتم اختيار مجلد — تم إلغاء العملية');
    return;
  }

  branches.forEach((b, i)=>{ setTimeout(()=>downloadUnavailable(b.id, app), i*400); });
  toast('متصفحك لا يدعم الحفظ التلقائى فى مجلد (استخدم Chrome أو Edge) — سيتم تنزيل الملفات لمجلد التنزيلات');
}

/* ===================== RENDER: أصناف غير متوفرة ===================== */
function renderUnavailableList(keepOpenId){
  const list = document.getElementById('unavailable-list');
  if(!list) return;
  const branches = getBranches();
  if(!branches.length){
    list.innerHTML = '<div class="empty"><b>لا يوجد فروع بعد</b>ابدأ بإضافة فرع من تبويب الفروع</div>';
    renderUnavailableSummary();
    return;
  }
  list.innerHTML = branches.map(b => renderUnavailableBranchCard(b, b.id === keepOpenId)).join('');
  renderUnavailableSummary();
}

function renderUnavailableSummary(){
  const el = document.getElementById('unavailable-summary');
  if(!el) return;
  const branches = getBranches();
  const totals = {
    instashop: {cat:0, un:0},
    vezeeta: {cat:0, un:0},
    talabat: {cat:0, un:0}
  };
  let any = false;
  const rows = branches.map(b=>{
    const cells = APP_LIST.map(app=>{
      const r = getUnavailableReport(b.id, app);
      if(r){
        any = true;
        totals[app].cat += r.totalCatalog;
        totals[app].un += r.items.length;
        return `${r.items.length} / ${r.totalCatalog}`;
      }
      return '—';
    });
    return `<tr><td>${escHtml(b.name)}</td><td>${cells[0]}</td><td>${cells[1]}</td><td>${cells[2]}</td></tr>`;
  }).join('');

  if(!any){
    el.innerHTML = '<div class="empty"><b>لا توجد ريبورتات بعد</b>ارفع الكتالوجات لكل فرع واضغط "قارن"</div>';
    return;
  }
  const totalRow = `<tr style="font-weight:800"><td>الإجمالي</td><td>${totals.instashop.un} / ${totals.instashop.cat}</td><td>${totals.vezeeta.un} / ${totals.vezeeta.cat}</td><td>${totals.talabat.un} / ${totals.talabat.cat}</td></tr>`;
  el.innerHTML = `
    <div class="table-wrap">
      <table class="rep-table">
        <thead><tr><th>الفرع</th><th>Instashop (غير متوفر / إجمالى)</th><th>Vezeeta (غير متوفر / إجمالى)</th><th>Talabat (غير متوفر / إجمالى)</th></tr></thead>
        <tbody>${rows}${totalRow}</tbody>
      </table>
    </div>`;
}

function renderUnavailableBranchCard(b, isOpen){
  const badges = APP_LIST.map(app=>{
    const r = getUnavailableReport(b.id, app);
    return r
      ? `<span class="badge badge-warn">${APP_LABELS[app]}: ${r.items.length} غير متوفر</span>`
      : `<span class="badge badge-off">${APP_LABELS[app]}: لا يوجد ريبورت</span>`;
  }).join('');

  const bodyContent = isOpen ? renderUnavailableBranchBody(b) : '';

  return `
  <div class="branch-card">
    <div class="branch-head" onclick="toggleUnavailableBranch('${b.id}')">
      <div class="name"><span class="dot"></span><h3>${escHtml(b.name)}</h3></div>
      <div class="branch-meta">${badges}</div>
    </div>
    <div class="branch-body${isOpen ? ' open' : ''}" id="unavail-body-${b.id}" data-rendered="${isOpen ? '1' : '0'}">${bodyContent}</div>
  </div>`;
}

function toggleUnavailableBranch(id){
  const el = document.getElementById('unavail-body-'+id);
  if(!el) return;
  const opening = !el.classList.contains('open');
  el.classList.toggle('open');
  if(opening && el.dataset.rendered !== '1'){
    const b = getBranches().find(x=>x.id===id);
    if(b){
      el.innerHTML = renderUnavailableBranchBody(b);
      el.dataset.rendered = '1';
    }
  }
}

function renderUnavailableBranchBody(b){
  const boxes = APP_LIST.map(app => renderAppBox(b, app)).join('');
  return `
      <div class="grid3">${boxes}</div>
      <div style="margin-top:14px">
        <button class="btn btn-accent btn-sm" onclick="generateUnavailableForBranch('${b.id}')">🔄 قارن كل الأبليكيشنز لهذا الفرع</button>
      </div>
  `;
}

function renderAppBox(b, app){
  const catalog = getCatalog(b.id, app);
  const appAvail = getAppAvailable(b.id, app);
  const report = getUnavailableReport(b.id, app);
  const rows = report ? report.items.map(it => `
    <tr>
      <td class="mono">${escHtml(it.code)}</td>
      <td class="mono">${it.relatedTo ? escHtml(it.relatedTo) : '—'}</td>
      <td>${escHtml(it.name)}</td>
      <td>${it.qty}</td>
      <td>${it.price}</td>
    </tr>`).join('') : '';

  return `
    <div class="box">
      <h4>${APP_LABELS[app]}</h4>

      <div class="sub" style="margin-bottom:4px"><b>1) الشيت الأصلى (الرصيد الحقيقى)</b> — A كود الصنف · B Related to · C اسم الصنف · D كمية الصنف · E السعر. أى كود فى ليستة النواقص مش موجود هنا بيتضاف تلقائيًا.</div>
      <div class="row-check"><input type="checkbox" id="catHeader-${app}-${b.id}" checked> <label for="catHeader-${app}-${b.id}">الصف الأول عناوين</label></div>
      <input type="file" accept=".xlsx,.xls,.csv" onchange="handleCatalogUpload('${b.id}','${app}', this)">
      <div class="status">${catalog ? `📄 ${escHtml(catalog.fileName || 'ملف')}<br>آخر رفع: ${fmtDate(catalog.uploadedAt)} — ${catalog.items.length} صنف` : 'لم يتم رفع الشيت الأصلى بعد'}</div>
      ${catalog ? `<button class="btn btn-danger btn-sm" style="width:100%; margin-top:6px" onclick="clearCatalog('${b.id}','${app}')">🗑 حذف الشيت الأصلى</button>` : ''}

      <div class="sub" style="margin:14px 0 4px; border-top:1px solid var(--line); padding-top:12px"><b>2) المتوفر فعليًا على ${APP_LABELS[app]} الآن</b> — عمود A فقط = كود الصنف (باقى الأعمدة بيتم تجاهلها لو موجودة)</div>
      <div class="row-check"><input type="checkbox" id="availHeader-${app}-${b.id}" checked> <label for="availHeader-${app}-${b.id}">الصف الأول عناوين</label></div>
      <input type="file" accept=".xlsx,.xls,.csv" onchange="handleAppAvailableUpload('${b.id}','${app}', this)">
      <div class="status">${appAvail ? `📄 ${escHtml(appAvail.fileName || 'ملف')}<br>آخر رفع: ${fmtDate(appAvail.uploadedAt)} — ${appAvail.items.length} صنف` : 'لم يتم رفع شيت المتوفر فعليًا بعد'}</div>
      ${appAvail ? `<button class="btn btn-danger btn-sm" style="width:100%; margin-top:6px" onclick="clearAppAvailable('${b.id}','${app}')">🗑 حذف شيت المتوفر فعليًا</button>` : ''}

      ${report ? `
        <div class="status" style="margin-top:12px; border-top:1px solid var(--line); padding-top:10px">تم الإنشاء: ${fmtDate(report.generatedAt)}<br>غير متوفر: <b>${report.items.length}</b> من إجمالى <b>${report.totalCatalog}</b> صنف (الرصيد الحقيقى)</div>
        <button class="btn btn-ghost btn-sm" style="width:100%; margin-top:6px" onclick="downloadUnavailable('${b.id}','${app}')">⬇ Export sheet</button>
        <div class="table-wrap" style="max-height:220px; margin-top:8px">
          <table class="rep-table">
            <thead><tr><th>الكود</th><th>Related to</th><th>اسم الصنف</th><th>الكمية</th><th>السعر</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : ''}
    </div>`;
}

/* ===================== SEARCH CHAIN (بحث شامل فى كل الفروع) ===================== */
function renderChainSection(title, headers, hits, rowFn, emptyMsg, totalCount){
  const total = totalCount ?? hits.length;
  const shown = hits.slice(0, 100);
  const more = Math.max(0, total - shown.length);
  return `
  <div class="box" style="margin-bottom:16px">
    <h4>${title} ${total ? `<span class="badge badge-ok">${total}</span>` : `<span class="badge badge-off">0</span>`}</h4>
    ${total ? `
    <div class="table-wrap" style="max-height:260px">
      <table class="rep-table">
        <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${shown.map(rowFn).join('')}</tbody>
      </table>
    </div>
    ${more ? `<div class="sub" style="margin-top:8px">تم عرض أول 100 نتيجة فقط — إجمالى النتائج: <b>${total}</b>. ضيّق البحث أو اختر فرعًا محددًا.</div>` : ''}` : `<div class="sub" style="margin:0">${emptyMsg}</div>`}
  </div>`;
}

/* ===================== SEARCH CHAIN — FAST INDEX ENGINE =====================
   الإصدار السابق كان يفحص كل صف فى الليستة اليومية + النواقص + الريبورتات
   + انستاشوب مع كل حرف. ده يظل صحيحًا منطقيًا لكنه يصبح بطيئًا جدًا مع ملفات كبيرة.
   هنا نبنى Index مرة واحدة من الكاش، ثم البحث نفسه يعمل على نتائج جاهزة.
   الأهم: النواقص لها Index مستقل، لذلك أى كود موجود فى ليستة النواقص يظهر مباشرة.
*/
let __chainSearchTimer = null;
let __chainSearchToken = 0;
let __chainIndexVersion = 0;
let __chainIndexBuiltVersion = -1;
let __chainIndex = { main: [], shortage: [], reports: [], instashop: [] };
let __chainIndexBuildTimer = null;

function rebuildChainSearchIndex(){
  __chainIndexVersion++;
  clearTimeout(__chainIndexBuildTimer);
  __chainIndexBuildTimer = setTimeout(buildChainSearchIndex, 40);
}

function buildChainSearchIndex(){
  if(__chainIndexBuiltVersion === __chainIndexVersion) return;
  const branches = getBranches();
  const next = {main:[], shortage:[], reports:[], instashop:[]};
  const nameMaps = {};

  /* بناء Map للكود -> الاسم من الليستة اليومية لكل فرع مرة واحدة فقط */
  branches.forEach(b=>{
    const main = getMain(b.id);
    const map = new Map();
    (main && Array.isArray(main.items) ? main.items : []).forEach(it=>{
      const k = codeKey(it && it.code);
      if(k && !map.has(k)) map.set(k, norm(it && it.name));
    });
    nameMaps[b.id] = map;
  });

  branches.forEach(b=>{
    const branchName = b.name || '';
    const shortage = getShortage(b.id);
    const main = getMain(b.id);
    const reports = (cache.reports && cache.reports[b.id]) || null;
    const instashop = (cache.instashopReports && cache.instashopReports[b.id]) || null;
    const shortageItems = shortage && Array.isArray(shortage.items) ? shortage.items : [];
    const shortageSet = new Set(shortageItems.map(x=>codeKey(x && x.code)).filter(Boolean));

    (main && Array.isArray(main.items) ? main.items : []).forEach(it=>{
      const code=codeKey(it&&it.code); if(!code) return;
      next.main.push({branchId:b.id,branch:branchName,codeRaw:norm(it.code),code,name:norm(it.name),qty:it.qty,relatedTo:it.relatedTo});
    });
    shortageItems.forEach(it=>{
      const code=codeKey(it&&it.code); if(!code) return;
      next.shortage.push({branchId:b.id,branch:branchName,codeRaw:norm(it.code),code,name:norm(it.name)||nameMaps[b.id].get(code)||''});
    });
    (reports && Array.isArray(reports.items) ? reports.items : []).forEach(it=>{
      const code=codeKey(it&&it.code); if(!code || shortageSet.has(code)) return;
      next.reports.push({branchId:b.id,branch:branchName,codeRaw:norm(it.code),code,name:norm(it.name),price:it.price,balance:it.balance});
    });
    (instashop && Array.isArray(instashop.items) ? instashop.items : []).forEach(it=>{
      const code=codeKey(it&&it.code); if(!code || (shortageSet.has(code) && !it.milk)) return;
      next.instashop.push({branchId:b.id,branch:branchName,codeRaw:norm(it.code),code,name:norm(it.name),price:it.price,balance:it.balance});
    });
  });
  __chainIndex = next;
  __chainIndexBuiltVersion = __chainIndexVersion;
}

function debounce(fn, delay){
  let t;
  return function(...args){ clearTimeout(t); t=setTimeout(()=>fn.apply(this,args),delay); };
}

function populateChainBranchFilter(){
  const sel=document.getElementById('chainBranchFilter'); if(!sel) return;
  const current=sel.value, branches=getBranches();
  sel.innerHTML='<option value="">كل الفروع</option>'+branches.map(b=>`<option value="${escAttr(b.id)}">${escHtml(b.name)}</option>`).join('');
  if(current && branches.some(b=>b.id===current)) sel.value=current;
}

function runSearchChain(value){
  const el=document.getElementById('chain-results'); if(!el) return;
  const q=norm(value).toLowerCase();
  const myToken=++__chainSearchToken;
  clearTimeout(__chainSearchTimer);
  if(!q){ el.innerHTML='<div class="empty"><b>ابدأ الكتابة للبحث</b>اكتب كود أو اسم الصنف لعرض تواجده فى كل الفروع</div>'; return; }

  /* تأكد أن آخر نسخة من بيانات Firebase ممثلة فى الـIndex قبل البحث */
  buildChainSearchIndex();
  const filterEl=document.getElementById('chainBranchFilter');
  const branchFilterId=filterEl ? filterEl.value : '';
  const mainHits=[], shortageHits=[], reportHits=[], instashopHits=[];
  let mainCount=0, shortageCount=0, reportCount=0, instashopCount=0;
  const MAX_STORED=100;
  const sources=[['main',__chainIndex.main],['shortage',__chainIndex.shortage],['reports',__chainIndex.reports],['instashop',__chainIndex.instashop]];
  let sourceIndex=0, itemIndex=0;
  el.innerHTML='<div class="empty"><b>جارى البحث…</b></div>';

  function finish(){
    if(myToken!==__chainSearchToken) return;
    el.innerHTML=
      renderChainSection('متوفر فى الليستة اليومية',['الفرع','الكود','اسم الصنف','الرصيد','Related to'],mainHits,h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.codeRaw)}</td><td>${escHtml(h.name)}</td><td>${h.qty}</td><td class="mono">${h.relatedTo ? escHtml(h.relatedTo) : '—'}</td></tr>`,'الصنف غير موجود فى أي ليستة يومية',mainCount)+
      renderChainSection('موجود فى ليستة النواقص',['الفرع','الكود','اسم الصنف'],shortageHits,h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.codeRaw)}</td><td>${escHtml(h.name)||'—'}</td></tr>`,'الصنف غير موجود فى أي ليستة نواقص',shortageCount)+
      renderChainSection('موجود فى الريبورت فيزيتا/طلبات بعد حذف النواقص',['الفرع','الكود','اسم الصنف','السعر','الرصيد'],reportHits,h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.codeRaw)}</td><td>${escHtml(h.name)}</td><td>${h.price}</td><td>${h.balance}</td></tr>`,'الصنف غير موجود فى أي ريبورت فيزيتا/طلبات',reportCount)+
      renderChainSection('موجود فى ريبورت انستاشوب بعد حذف النواقص',['الفرع','الكود','اسم الصنف','السعر','الرصيد'],instashopHits,h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.codeRaw)}</td><td>${escHtml(h.name)}</td><td>${h.price}</td><td>${h.balance}</td></tr>`,'الصنف غير موجود فى أي ريبورت انستاشوب',instashopCount);
  }

  function process(){
    if(myToken!==__chainSearchToken) return;
    const CHUNK=1500;
    let budget=CHUNK;
    while(sourceIndex<sources.length && budget>0){
      const stage=sources[sourceIndex][0], arr=sources[sourceIndex][1];
      while(itemIndex<arr.length && budget>0){
        const h=arr[itemIndex++]; budget--;
        if(branchFilterId && h.branchId!==branchFilterId) continue;
        if(!(h.code.includes(q) || h.name.toLowerCase().includes(q))) continue;
        if(stage==='main'){mainCount++;if(mainHits.length<MAX_STORED)mainHits.push(h);}
        else if(stage==='shortage'){shortageCount++;if(shortageHits.length<MAX_STORED)shortageHits.push(h);}
        else if(stage==='reports'){reportCount++;if(reportHits.length<MAX_STORED)reportHits.push(h);}
        else {instashopCount++;if(instashopHits.length<MAX_STORED)instashopHits.push(h);}
      }
      if(itemIndex>=arr.length){sourceIndex++;itemIndex=0;}
    }
    if(sourceIndex>=sources.length){ finish(); return; }
    __chainSearchTimer=setTimeout(process,0);
  }
  process();
}
const runSearchChainDebounced=debounce(runSearchChain,120);

/* ===================== ESCAPE HELPERS ===================== */
function escHtml(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s){ return escHtml(s); }

/* ===================== INIT ===================== */
/* بدء التطبيق يتم الآن من خلال showApp() بعد تأكيد تسجيل الدخول عبر Firebase */
