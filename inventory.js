
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

function normalizeCache(v){
  const val = v || {};
  return {
    branches: Array.isArray(val.branches) ? val.branches : (val.branches ? Object.values(val.branches) : []),
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

let firstDataReceived = false;
let firstLoadTimeoutTimer = null;

function attachDataListener(){
  if(dataListenerAttached) return;
  dataListenerAttached = true;

  /* لو أول تحميل للبيانات ماخدش وقت طويل من غير ما يوصل، بنوضح للمستخدم إن فيه مشكلة اتصال
     بدل ما يفضل شايف شاشة فاضية أو "جارٍ التحميل" لحد ما هو يفصل */
  firstLoadTimeoutTimer = setTimeout(()=>{
    if(firstDataReceived) return;
    const list = document.getElementById('branches-list');
    if(list){
      list.innerHTML = `
        <div class="empty">
          <b>تعذّر تحميل البيانات</b>
          الاتصال بقاعدة البيانات بطيء أو متعطل — تأكد من اتصالك بالإنترنت
          <div style="margin-top:14px">
            <button class="btn btn-accent btn-sm" onclick="location.reload()">🔄 إعادة تحميل الصفحة</button>
          </div>
        </div>`;
    }
  }, 12000);

  firebase.database().ref('app_data').on('value', snapshot=>{
    firstDataReceived = true;
    clearTimeout(firstLoadTimeoutTimer);
    cache = normalizeCache(snapshot.val());
    if(!cache.settings || !cache.settings.deleteBranchPassword){
      // أول مرة: نزرع كلمة السر الافتراضية فى فايربيز عشان تتخزن هناك بدل ما تكون مكتوبة فى كود الصفحة
      firebaseWrite('app_data/settings/deleteBranchPassword', DELETE_BRANCH_PASSWORD_DEFAULT);
    }
    // أظهر الفروع أولاً، ثم نفّذ الأعمال الثانوية بعد رسم الواجهة
    renderBranches();
    requestAnimationFrame(()=>{
      expireOldReports();
      renderUnavailableList();
      populateChainBranchFilter();
      const chainInput = document.getElementById('chainSearchInput');
      if(chainInput && chainInput.value) runSearchChain(chainInput.value);
    });
  }, err=>{
    console.error('Firebase sync error:', err);
    toast('تعذر الاتصال بقاعدة بيانات Firebase');
  });
}

/* مراقبة حالة الاتصال بفايربيز (مسار خاص .info/connected بيوفره فايربيز نفسه) —
   بيوضح للمستخدم فورًا لو النت اتقطع أو رجع تاني، بدل ما الصفحة تفضل واقفة بصمت */
let connectionWatcherAttached = false;
let wasConnected = true;
function watchConnectionState(){
  if(connectionWatcherAttached) return;
  connectionWatcherAttached = true;
  firebase.database().ref('.info/connected').on('value', snap=>{
    const connected = snap.val() === true;
    if(!connected && wasConnected){
      toast('⚠️ تم فقد الاتصال بالخادم — جارٍ محاولة إعادة الاتصال...');
    } else if(connected && !wasConnected){
      toast('✅ تم استعادة الاتصال بالخادم');
    }
    wasConnected = connected;
  });
}
function detachDataListener(){
  if(!dataListenerAttached) return;
  dataListenerAttached = false;
  cache = { branches: [], main: {}, shortage: {}, reports: {}, instashopReports: {}, settings: {}, catalogs: {}, appAvailable: {}, unavailableReports: {} };
  cache = { branches: [], main: {}, shortage: {}, reports: {}, instashopReports: {}, settings: {}, catalogs: {}, unavailableReports: {} };
  clearTimeout(firstLoadTimeoutTimer);
  firstDataReceived = false;
  if(connectionWatcherAttached){
    connectionWatcherAttached = false;
    wasConnected = true;
    firebase.database().ref('.info/connected').off();
  }
}

function firebaseWrite(path, value){
  firebase.database().ref(path).set(value).catch(err=>{
    console.error('Firebase write error:', path, err);
    toast('حدث خطأ أثناء الحفظ فى Firebase — تأكد من الاتصال بالإنترنت');
  });
}
/* كتابة عدة مسارات دفعة واحدة (بدل عدة كتابات منفصلة) — بتقلل عدد المرات اللي بيعاد فيها
   تحميل كل بيانات فايربيز عن طريق مستمع app_data، وبالتالي بتقلل "الوقوف/الانتظار" بشكل كبير */
async function firebaseBatchWrite(updates){
  if(!updates || !Object.keys(updates).length) return;
  return firebase.database().ref().update(updates);
}
function firebaseRemove(path){
  firebase.database().ref(path).remove().catch(err=>{
    console.error('Firebase remove error:', path, err);
    toast('حدث خطأ أثناء الحذف فى Firebase — تأكد من الاتصال بالإنترنت');
  });
}

function getBranches(){ return cache.branches || []; }
function saveBranches(b){ cache.branches = b; firebaseWrite('app_data/branches', b); }
function getMain(id){ return (cache.main && cache.main[id]) || null; }
function saveMain(id, d){ cache.main[id] = d; firebaseWrite('app_data/main/'+id, d); }
function clearMainCore(id){
  delete cache.main[id];
  firebaseRemove('app_data/main/'+id);
}
function clearMain(id){
  if(!confirm('هل تريد حذف الشيت المرفوع لهذا الفرع؟ سيتم حذف الليستة اليومية بالكامل.')) return;
  clearMainCore(id);
  toast('تم حذف الشيت');
  renderBranches(id);
}
/* حذف الشيت من كل الفروع دفعة واحدة */
function clearAllMain(){
  const branches = getBranches();
  const withMain = branches.filter(b => getMain(b.id));
  if(!withMain.length){ toast('لا توجد ليستة يومية مرفوعة لأي فرع'); return; }
  if(!confirm(`هل تريد حذف الليستة اليومية من كل الفروع (${withMain.length} فرع)؟ لا يمكن التراجع عن هذا الإجراء.`)) return;
  withMain.forEach(b => clearMainCore(b.id));
  const statusEl = document.getElementById('unifiedMainStatus');
  if(statusEl) statusEl.innerHTML = '';
  const checklistEl = document.getElementById('unifiedMainChecklist');
  if(checklistEl) checklistEl.innerHTML = '';
  renderBranches();
  toast(`تم حذف الشيت من ${withMain.length} فرع`);
}
function getShortage(id){ return (cache.shortage && cache.shortage[id]) || {updatedAt:null, items:[]}; }
function saveShortage(id, d){ cache.shortage[id] = d; firebaseWrite('app_data/shortage/'+id, d); }
function getReports(id){ return (cache.reports && cache.reports[id]) || null; }
function saveReports(id, d){ cache.reports[id] = d; firebaseWrite('app_data/reports/'+id, d); }
function clearReports(id){ delete cache.reports[id]; firebaseRemove('app_data/reports/'+id); }

/* ريبورت Instashop منفصل (نفس تفاصيل Vezeeta، لكن مع استثناء أصناف الألبان من الحذف بسبب النواقص) */
function getInstashopReport(id){ return (cache.instashopReports && cache.instashopReports[id]) || null; }
function saveInstashopReport(id, d){ cache.instashopReports[id] = d; firebaseWrite('app_data/instashopReports/'+id, d); }
function clearInstashopReport(id){ delete cache.instashopReports[id]; firebaseRemove('app_data/instashopReports/'+id); }

function norm(v){ return (v===undefined||v===null) ? '' : String(v).trim(); }
function toNum(v){ const n = parseFloat(v); return isNaN(n) ? 0 : n; }
/* يحوّل كود الصنف لرقم فعلى (Number) لو الكود أرقام فقط، عشان يتخزن فى الإكسل كـ Number مش نص
   (لو الكود فيه حروف أو رموز بيسيبه نص زي ما هو عشان متتلخبطش القيمة) */
function codeToNumber(code){
  const s = norm(code);
  if(s !== '' && /^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}
function fmtDate(ts){ if(!ts) return '—'; const d = new Date(ts); return d.toLocaleDateString('ar-EG',{day:'2-digit',month:'2-digit',year:'numeric'}) + ' ' + d.toLocaleTimeString('ar-EG',{hour:'2-digit',minute:'2-digit'}); }
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

/* ===================== TOAST ===================== */
var toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}

/* ===================== TABS ===================== */
document.querySelectorAll('nav.tabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+btn.dataset.view).classList.add('active');
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

/* ===================== تغيير كلمة السر ===================== */
function openChangePassword(){
  if(!currentUser){ toast('لازم تسجل الدخول الأول'); return; }
  document.getElementById('oldPass').value = '';
  document.getElementById('newPass').value = '';
  document.getElementById('newPass2').value = '';
  document.getElementById('changePassUserLabel').textContent = currentUser.name || currentUser.email || '';
  document.getElementById('changePassModal').classList.add('open');
  setTimeout(()=>document.getElementById('oldPass').focus(), 100);
}
function closeChangePassword(){
  document.getElementById('changePassModal').classList.remove('open');
}
function confirmChangePassword(){
  if(!currentUser || !currentUser.id){ toast('لازم تسجل الدخول الأول'); return; }
  const oldPass = document.getElementById('oldPass').value;
  const newPass = document.getElementById('newPass').value;
  const newPass2 = document.getElementById('newPass2').value;

  if(!oldPass){ toast('اكتب كلمة السر الحالية'); return; }
  if(String(oldPass) !== String(currentUser.pass)){ toast('كلمة السر الحالية غير صحيحة'); return; }
  if(!newPass){ toast('اكتب كلمة السر الجديدة'); return; }
  if(newPass.length < 4){ toast('كلمة السر الجديدة قصيرة جدًا (٤ حروف/أرقام على الأقل)'); return; }
  if(newPass !== newPass2){ toast('كلمة السر الجديدة وتأكيدها غير متطابقين'); return; }
  if(String(newPass) === String(oldPass)){ toast('كلمة السر الجديدة مطابقة للقديمة'); return; }

  const btn = document.querySelector('#changePassModal .btn-accent');
  if(btn){ btn.disabled = true; }

  firebase.database().ref('users/'+currentUser.id).update({ pass: newPass })
    .then(()=>{
      currentUser.pass = newPass;
      LS.set('ibs_current_user', currentUser);
      closeChangePassword();
      toast('تم تغيير كلمة السر بنجاح');
    })
    .catch(err=>{
      console.error('Change password error:', err);
      toast('حدث خطأ أثناء تغيير كلمة السر، حاول مرة أخرى');
    })
    .finally(()=>{
      if(btn){ btn.disabled = false; }
    });
}

/* ===================== TOGGLE BRANCH BODY ===================== */
function toggleBranch(id){
  const el = document.getElementById('body-'+id);
  if(!el) return;
  const opening = !el.classList.contains('open');
  el.classList.toggle('open');
  if(opening && el.dataset.rendered !== '1'){
    const b = getBranches().find(x=>x.id===id);
    if(b){
      el.innerHTML = renderBranchBody(b);
      el.dataset.rendered = '1';
    }
  }
}

/* ===================== PARSE EXCEL ===================== */
function readWorkbookRows(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e => {
      try{
        const wb = XLSX.read(e.target.result, {type:'array'});
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, {header:1, defval:''});
        resolve(rows);
      }catch(err){ reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/* يحوّل حرف عمود الإكسيل (A, B, ... Z, AA, AB ... BT) لرقم عمود (0-based) */
function colToIndex(letters){
  letters = String(letters).trim().toUpperCase();
  let idx = 0;
  for(let i=0;i<letters.length;i++){
    idx = idx*26 + (letters.charCodeAt(i) - 64);
  }
  return idx - 1;
}

/* خريطة: اسم الفرع (كما هو مكتوب فى النظام، بحروف صغيرة) => عمود رصيده فى الشيت الموحد */
const BRANCH_BALANCE_COLUMN = {
  'dar elyosr': 'BT',
  'watanya': 'BR',
  'awl gamal': 'AD',
  'midtown': 'AH',
  'midtwon': 'AH', /* تحسبًا لاختلاف كتابة الاسم */
  'abaasya': 'X',
  'j. tito': 'BP'
};

/* نسخة "منظّفة" من المفاتيح (بدون مسافات/نقط/شرطات) عشان فروق بسيطة زي مسافة زيادة
   أو نقطة أو شرطة فى اسم الفرع متحدثش مشكلة فى المطابقة */
function branchKeyClean(s){ return norm(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
const BRANCH_BALANCE_COLUMN_CLEAN = {};
Object.keys(BRANCH_BALANCE_COLUMN).forEach(k=>{
  BRANCH_BALANCE_COLUMN_CLEAN[branchKeyClean(k)] = BRANCH_BALANCE_COLUMN[k];
});
function getBranchBalanceColumn(branchName){
  const exact = BRANCH_BALANCE_COLUMN[norm(branchName).toLowerCase()];
  if(exact) return exact;
  return BRANCH_BALANCE_COLUMN_CLEAN[branchKeyClean(branchName)] || null;
}

/* رفع شيت واحد موحد لكل الفروع: A=كود الصنف، B=اسم الصنف، M=سعر الصنف، ورصيد كل فرع فى عموده الخاص */
async function handleUnifiedMainUpload(input){
  const file = input.files[0];
  if(!file) return;
  const hasHeader = document.getElementById('unifiedMainHeader').checked;
  const statusEl = document.getElementById('unifiedMainStatus');
  const checklistEl = document.getElementById('unifiedMainChecklist');
  try{
    const rows = await readWorkbookRows(file);
    toast('تم قراءة الليستة بنجاح — جارٍ تجهيز وتوزيع البيانات على الفروع بأقصى سرعة...');
    const dataRows = hasHeader ? rows.slice(1) : rows;

    const branches = getBranches();
    const matched = [], unmatched = [];
    const updates = {};
    const validRows = dataRows.filter(r => norm(r[0]) !== '');
    const uploadedAt = now();
    const codes = new Array(validRows.length);
    const names = new Array(validRows.length);
    const categories = new Array(validRows.length);
    const relatedTos = new Array(validRows.length);
    const prices = new Array(validRows.length);

    /* تجهيز الأعمدة المشتركة مرة واحدة بدل إعادة قراءة وتحويل كل صف لكل فرع */
    for(let i=0;i<validRows.length;i++){
      const r = validRows[i];
      codes[i] = norm(r[0]);
      names[i] = norm(r[1]);
      categories[i] = norm(r[3]);
      relatedTos[i] = norm(r[11]);
      prices[i] = toNum(r[12]);
    }

    branches.forEach(b=>{
      const colLetter = getBranchBalanceColumn(b.name);
      if(!colLetter){ unmatched.push(b.name); return; }
      const balCol = colToIndex(colLetter);
      const items = new Array(validRows.length);
      let withBalance = 0;
      for(let i=0;i<validRows.length;i++){
        const qty = toNum(validRows[i][balCol]);
        if(qty > 0) withBalance++;
        items[i] = {code:codes[i], name:names[i], category:categories[i], relatedTo:relatedTos[i], price:prices[i], qty};
      }
      const data = {uploadedAt, fileName: file.name, items};
      cache.main[b.id] = data;
      updates['app_data/main/'+b.id] = data;
      matched.push({name: b.name, col: colLetter, count: items.length, withBalance});
    });

    if(!Object.keys(updates).length){
      throw new Error('لا توجد بيانات فروع مطابقة للحفظ');
    }

    /* نحاول الحفظ دفعة واحدة أولاً. لو Firebase رفضت الطلب بسبب حجم العملية،
       نعيد المحاولة فرعًا فرعًا حتى لا تضيع كل عملية الرفع الموحد. */
    try{
      await firebaseBatchWrite(updates);
    }catch(batchErr){
      console.warn('Firebase batch write failed, retrying branch by branch:', batchErr);
      const failed = [];
      for(const b of branches){
        if(!Object.prototype.hasOwnProperty.call(updates, 'app_data/main/'+b.id)) continue;
        try{
          await firebase.database().ref('app_data/main/'+b.id).set(updates['app_data/main/'+b.id]);
        }catch(branchErr){
          console.error('Firebase branch write error:', b.name, branchErr);
          failed.push(b.name);
        }
      }
      if(failed.length){
        throw new Error('تعذر حفظ بيانات: '+failed.join('، '));
      }
    }

    renderBranches();
    if(statusEl) statusEl.innerHTML = `تم قراءة الليستة وتوزيعها وحفظها بنجاح — ${fmtDate(now())} — تم تحديث ${matched.length} فرع`;

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
    console.error('Unified upload error:', err);
    const msg = err && err.message ? err.message : 'خطأ غير معروف';
    toast('لم يتم الحفظ فى Firebase: '+msg);
  }
  input.value='';
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

/* إضافة صنف واحد سريعًا إلى ليستة نواقص الفرع */
function addSingleShortage(branchId){
  const input = document.getElementById('singleShortageCode-'+branchId);
  if(!input) return;
  const code = norm(input.value);
  if(!code){
    toast('من فضلك أدخل كود الصنف أولاً');
    input.focus();
    return;
  }
  const s = getShortage(branchId);
  if(s.items.some(it => norm(it.code) === code)){
    toast('هذا الصنف موجود بالفعل في ليستة النواقص');
    input.select();
    return;
  }
  s.items.push({code});
  s.updatedAt = now();
  saveShortage(branchId, s);
  toast('تمت إضافة الصنف إلى ليستة النواقص');
  renderBranches(branchId);
}
function handleSingleShortageKeydown(e, branchId){
  if(e.key === 'Enter'){
    e.preventDefault();
    addSingleShortage(branchId);
  }
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

/* ===================== SHORTAGE: BULK ADD / REMOVE ===================== */
/* نفس المودال يُستخدم للإضافة وللحذف بالجملة معًا، بالتحكم عن طريق bulkOpMode */
let bulkAddBranchId = null;
let bulkOpMode = 'add'; // 'add' | 'remove'

function openBulkAddShortage(branchId){
  openBulkShortageModal(branchId, 'add');
}
function openBulkRemoveShortage(branchId){
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
  const codes = raw.split(/[\n,،\t]+/).map(c=>norm(c)).filter(Boolean);
  if(!codes.length){ toast('اكتب أو الصق كودًا واحدًا على الأقل'); return; }
  const codeSet = new Set(codes);
  const isRemove = bulkOpMode === 'remove';

  /* تنفيذ على كل الفروع دفعة واحدة */
  if(bulkAddBranchId === 'ALL'){
    const branches = getBranches();
    if(!branches.length){ toast('لا توجد فروع مضافة'); return; }
    let changed = 0;
    branches.forEach(b=>{
      const s = getShortage(b.id);
      if(isRemove){
        const before = s.items.length;
        s.items = s.items.filter(it => !codeSet.has(it.code));
        changed += (before - s.items.length);
      }else{
        codes.forEach(code => s.items.push({code}));
        changed += codes.length;
      }
      s.updatedAt = now();
      saveShortage(b.id, s);
    });
    closeBulkAddShortage();
    renderBranches();
    toast(isRemove
      ? 'تم حذف '+changed+' صنف من ليستة النواقص فى '+branches.length+' فرع'
      : 'تم إضافة '+changed+' صنف لليستة النواقص فى '+branches.length+' فرع');
    return;
  }

  const s = getShortage(bulkAddBranchId);
  let changed = 0;
  if(isRemove){
    const before = s.items.length;
    s.items = s.items.filter(it => !codeSet.has(it.code));
    changed = before - s.items.length;
  }else{
    codes.forEach(code => s.items.push({code}));
    changed = codes.length;
  }
  s.updatedAt = now();
  saveShortage(bulkAddBranchId, s);
  const branchId = bulkAddBranchId;
  closeBulkAddShortage();
  renderBranches(branchId);
  toast(isRemove ? 'تم حذف '+changed+' صنف من ليستة النواقص' : 'تم إضافة '+changed+' صنف لليستة النواقص');
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

  const shortSet = new Set(shortage.items.map(s=>s.code).filter(Boolean));

  let removed = 0;
  const processed = main.items
    .filter(it=>{
      if(shortSet.has(it.code)){ removed++; return false; }
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

  const shortSet = new Set(shortage.items.map(s=>s.code).filter(Boolean));

  let removed = 0, milkKept = 0;
  const processed = main.items
    .filter(it=>{
      const milk = isMilkCategory(it.category);
      if(shortSet.has(it.code)){
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
          <div style="display:flex; gap:8px; margin-top:8px; align-items:center;">
            <input id="singleShortageCode-${b.id}" class="code-search" style="margin:0; flex:1" placeholder="أدخل كود صنف لإضافته سريعًا..." onkeydown="handleSingleShortageKeydown(event, '${b.id}')">
            <button class="btn btn-accent btn-sm" style="white-space:nowrap" onclick="addSingleShortage('${b.id}')">+ إضافة صنف</button>
          </div>
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
          <button class="btn btn-ghost btn-sm" style="width:100%; margin-top:10px" onclick="openBulkAddShortage('${b.id}')">+ إضافة أصناف بالجملة</button>
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
  renderUnavailableList();
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
function renderChainSection(title, headers, hits, rowFn, emptyMsg){
  return `
  <div class="box" style="margin-bottom:16px">
    <h4>${title} ${hits.length ? `<span class="badge badge-ok">${hits.length}</span>` : `<span class="badge badge-off">0</span>`}</h4>
    ${hits.length ? `
    <div class="table-wrap" style="max-height:260px">
      <table class="rep-table">
        <thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead>
        <tbody>${hits.map(rowFn).join('')}</tbody>
      </table>
    </div>` : `<div class="sub" style="margin:0">${emptyMsg}</div>`}
  </div>`;
}

/* تأخير بسيط عشان البحث ميتنفذش مع كل حرف أثناء الكتابة السريعة، لكن يستنى لحظة توقف بسيطة */
function debounce(fn, delay){
  let t;
  return function(...args){
    clearTimeout(t);
    t = setTimeout(()=>fn.apply(this, args), delay);
  };
}

/* بناء/تحديث لستة الفروع فى فلتر Search Chain، مع الحفاظ على الفرع المختار حاليًا لو لسه موجود */
function populateChainBranchFilter(){
  const sel = document.getElementById('chainBranchFilter');
  if(!sel) return;
  const current = sel.value;
  const branches = getBranches();
  sel.innerHTML = '<option value="">كل الفروع</option>' +
    branches.map(b => `<option value="${escAttr(b.id)}">${escHtml(b.name)}</option>`).join('');
  if(current && branches.some(b => b.id === current)){
    sel.value = current;
  }
}

function runSearchChain(value){
  const el = document.getElementById('chain-results');
  if(!el) return;
  const q = norm(value).toLowerCase();
  if(!q){
    el.innerHTML = '<div class="empty"><b>ابدأ الكتابة للبحث</b>اكتب كود أو اسم الصنف لعرض تواجده فى كل الفروع</div>';
    return;
  }

  const filterEl = document.getElementById('chainBranchFilter');
  const branchFilterId = filterEl ? filterEl.value : '';
  const allBranches = getBranches();
  const branches = branchFilterId ? allBranches.filter(b => b.id === branchFilterId) : allBranches;
  const mainHits = [], shortageHits = [], reportHits = [], instashopHits = [];

  branches.forEach(b=>{
    const main = getMain(b.id);
    const shortage = getShortage(b.id);
    const reports = getReports(b.id);
    const instashop = getInstashopReport(b.id);

    if(main && main.items.length){
      main.items.forEach(it=>{
        if(it.code.toLowerCase().includes(q) || (it.name||'').toLowerCase().includes(q)){
          mainHits.push({branch:b.name, code:it.code, name:it.name, qty:it.qty, relatedTo:it.relatedTo});
        }
      });
    }

    if(shortage && shortage.items.length){
      const mainByCode = main ? new Map(main.items.map(m=>[m.code, m])) : null;
      shortage.items.forEach(it=>{
        const foundMain = mainByCode ? mainByCode.get(it.code) : null;
        const resolvedName = foundMain ? (foundMain.name||'') : '';
        if((it.code||'').toLowerCase().includes(q) || resolvedName.toLowerCase().includes(q)){
          shortageHits.push({branch:b.name, code:it.code, name:resolvedName});
        }
      });
    }

    if(reports && reports.items.length){
      reports.items.forEach(it=>{
        if(it.code.toLowerCase().includes(q) || (it.name||'').toLowerCase().includes(q)){
          reportHits.push({branch:b.name, code:it.code, name:it.name, price:it.price, balance:it.balance});
        }
      });
    }

    if(instashop && instashop.items.length){
      instashop.items.forEach(it=>{
        if(it.code.toLowerCase().includes(q) || (it.name||'').toLowerCase().includes(q)){
          instashopHits.push({branch:b.name, code:it.code, name:it.name, price:it.price, balance:it.balance});
        }
      });
    }
  });

  el.innerHTML =
    renderChainSection(
      'متوفر فى الليستة اليومية',
      ['الفرع','الكود','اسم الصنف','الرصيد','Related to'],
      mainHits,
      h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.code)}</td><td>${escHtml(h.name)}</td><td>${h.qty}</td><td class="mono">${h.relatedTo ? escHtml(h.relatedTo) : '—'}</td></tr>`,
      'الصنف غير موجود فى أي ليستة يومية'
    ) +
    renderChainSection(
      'موجود فى ليستة النواقص',
      ['الفرع','الكود','اسم الصنف'],
      shortageHits,
      h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.code)}</td><td>${escHtml(h.name)||'—'}</td></tr>`,
      'الصنف غير موجود فى أي ليستة نواقص'
    ) +
    renderChainSection(
      'موجود فى الريبورت فيزيتا/طلبات بعد حذف النواقص',
      ['الفرع','الكود','اسم الصنف','السعر','الرصيد'],
      reportHits,
      h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.code)}</td><td>${escHtml(h.name)}</td><td>${h.price}</td><td>${h.balance}</td></tr>`,
      'الصنف غير موجود فى أي ريبورت فيزيتا/طلبات (لم يُنشأ ريبورت، أو تم حذفه ضمن النواقص)'
    ) +
    renderChainSection(
      'موجود فى ريبورت انستاشوب بعد حذف النواقص',
      ['الفرع','الكود','اسم الصنف','السعر','الرصيد'],
      instashopHits,
      h=>`<tr><td>${escHtml(h.branch)}</td><td class="mono">${escHtml(h.code)}</td><td>${escHtml(h.name)}</td><td>${h.price}</td><td>${h.balance}</td></tr>`,
      'الصنف غير موجود فى أي ريبورت انستاشوب (لم يُنشأ ريبورت، أو تم حذفه ضمن النواقص)'
    );
}
/* نسخة مؤجَّلة تُستخدم فى خانة البحث، عشان البحث ميتنفذش مع كل حرف أثناء الكتابة السريعة */
const runSearchChainDebounced = debounce(runSearchChain, 250);

/* ===================== ESCAPE HELPERS ===================== */
function escHtml(s){ return String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escAttr(s){ return escHtml(s); }

/* ===================== INIT ===================== */
/* بدء التطبيق يتم الآن من خلال showApp() بعد تأكيد تسجيل الدخول عبر Firebase */

