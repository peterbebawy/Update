import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-analytics.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";

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

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getDatabase(app);

export { app, db };
