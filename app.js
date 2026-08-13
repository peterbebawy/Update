/* ===================== AUTH + APP SHELL ===================== */

// Local Storage helper
const LS = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      if (value === null) return fallback;
      return JSON.parse(value);
    } catch (e) {
      console.warn('LS.get error:', e);
      return fallback;
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('LS.set error:', e);
      return false;
    }
  },

  del(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error('LS.del error:', e);
      return false;
    }
  }
};

let appInitialized = false;
let currentUser = LS.get('ibs_current_user', null);

function isInventoryPage(){
  return !!document.getElementById('appRoot');
}

function isLoginPage(){
  return !!document.getElementById('loginScreen');
}

function startInventoryApp(){
  if(!isInventoryPage() || appInitialized) return;

  appInitialized = true;

  const list = document.getElementById('branches-list');

  if(list){
    list.innerHTML =
      '<div class="empty"><b>جارٍ تحميل البيانات...</b>لو استمرت الشاشة فاضية لفترة طويلة، تأكد من اتصالك بالإنترنت</div>';
  }

  if(typeof attachDataListener === 'function'){
    attachDataListener();
  }

  if(typeof watchConnectionState === 'function'){
    watchConnectionState();
  }

  if(typeof expireOldReports === 'function'){
    setInterval(expireOldReports, 1000 * 60 * 30);
  }
}

function showApp(user){
  if(isLoginPage()){
    location.replace('inventory.html');
    return;
  }

  const app = document.getElementById('appRoot');

  if(app){
    app.style.display = '';
  }

  const label = document.getElementById('userEmailLabel');

  if(label){
    label.textContent = user.name || user.email || '';
  }

  startInventoryApp();
}

function showLogin(){
  if(isInventoryPage()){
    location.replace('index.html');
    return;
  }

  const screen = document.getElementById('loginScreen');

  if(screen){
    screen.classList.remove('hidden');
  }
}

function doLogin(){

  const emailEl = document.getElementById('loginEmail');
  const passEl = document.getElementById('loginPassword');
  const errEl = document.getElementById('loginError');

  if(!emailEl || !passEl) return;

  const username = emailEl.value.trim();
  const password = passEl.value;

  if(errEl){
    errEl.textContent = '';
  }

  if(!username || !password){

    if(errEl){
      errEl.textContent = 'من فضلك أدخل اسم المستخدم وكلمة المرور';
    }

    return;
  }

  firebase.database()
    .ref('users')
    .once('value')

    .then(snapshot => {

      const users = snapshot.val() || {};

      const found = Object.entries(users).find(([id, user]) => {

        return user &&
          user.name &&
          user.pass &&
          String(user.name).trim().toLowerCase() === username.toLowerCase() &&
          String(user.pass) === String(password);

      });

      if(!found){

        if(errEl){
          errEl.textContent = 'اسم المستخدم أو كلمة المرور غير صحيحة';
        }

        return;
      }

      const [userId, userData] = found;

      currentUser = {
        id: userId,
        ...userData
      };

      const saved = LS.set('ibs_current_user', currentUser);

      if(!saved){

        if(errEl){
          errEl.textContent = 'تعذر حفظ تسجيل الدخول على الجهاز';
        }

        return;
      }

      console.log('✅ Login successful:', currentUser);

      location.replace('inventory.html');

    })

    .catch(err => {

      console.error('Login error:', err);

      if(errEl){
        errEl.textContent =
          'حدث خطأ أثناء تسجيل الدخول، تأكد من الاتصال بالإنترنت وحاول مرة أخرى';
      }

    });
}

function doLogout(){

  if(!confirm('هل تريد تسجيل الخروج؟')) return;

  currentUser = null;
  appInitialized = false;

  if(typeof detachDataListener === 'function'){
    detachDataListener();
  }

  LS.del('ibs_current_user');

  location.replace('index.html');
}

/* ===================== TOAST ===================== */
