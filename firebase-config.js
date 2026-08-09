// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
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

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
