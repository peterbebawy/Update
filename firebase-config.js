import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
import { getFirestore } from "firebase/firestore";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyCikAWrMtiLw0WAYCH7I4iG6Wv2tMsEt9w",
  authDomain: "customer-care-841fe.firebaseapp.com",
  projectId: "customer-care-841fe",
  storageBucket: "customer-care-841fe.firebasestorage.app",
  messagingSenderId: "167461661789",
  appId: "1:167461661789:web:a1141fccdf4650b84eb1b4",
  measurementId: "G-EQ650CB20M"
};

const app = initializeApp(firebaseConfig);

const analytics = getAnalytics(app);

const db = getFirestore(app);

const auth = getAuth(app);

export { db, auth };
