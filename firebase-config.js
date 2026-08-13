/* =====================================================================
   إعدادات Firebase — نظام إدارة مخزون الفروع
   =====================================================================
   1) روح على https://console.firebase.google.com وأنشئ مشروع جديد (مجاني).
   2) من داخل المشروع: Project settings (⚙️) > General > Your apps
      > اضغط أيقونة الويب </> وسجّل تطبيق جديد (اسمه أي حاجة).
   3) هيديك Firebase هيديك object فيه القيم دي، انسخها وحطها هنا بدل
      القيم الوهمية تحت.
   4) من القايمة الجانبية: Build > Authentication > Get started
      > فعّل طريقة الدخول "Email/Password".
   5) من نفس الصفحة (Authentication) > تبويب Users > Add user
      وضيف إيميل وباسورد لكل موظف/فرع هيدخل بيهم على النظام.
      (مفيش تسجيل ذاتي في الموقع — الإضافة بتتم من هنا فقط، وده أأمن).
   ===================================================================== */

const firebaseConfig = {
  apiKey: "ضع_API_KEY_هنا",
  authDomain: "ضع_PROJECT_ID.firebaseapp.com",
  projectId: "ضع_PROJECT_ID_هنا",
  storageBucket: "ضع_PROJECT_ID.appspot.com",
  messagingSenderId: "ضع_SENDER_ID_هنا",
  appId: "ضع_APP_ID_هنا"
};

firebase.initializeApp(firebaseConfig);
