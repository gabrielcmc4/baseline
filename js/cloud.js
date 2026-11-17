// Accounts and saved analyses. Google sign-in and Firestore, loaded only when a Firebase project is configured.
import { firebaseConfig } from './firebase-config.js';
const VER = '13.4.0', CDN = `https://www.gstatic.com/firebasejs/${VER}/`;
let be = null, user = null;
export const cloudConfigured = () => !!firebaseConfig.apiKey || !!window.__baselineFakeCloud;
export const currentUser = () => user;
export async function initCloud(onUser) {
  if (window.__baselineFakeCloud) be = window.__baselineFakeCloud; // in-memory stand-in used by automated tests
  else if (firebaseConfig.apiKey) {
    const [{ initializeApp }, A, F] = await Promise.all([import(CDN + 'firebase-app.js'), import(CDN + 'firebase-auth.js'), import(CDN + 'firebase-firestore.js')]);
    const app = initializeApp(firebaseConfig), auth = A.getAuth(app), db = F.getFirestore(app), col = uid => F.collection(db, 'users', uid, 'sessions');
    be = { onUser: cb => A.onAuthStateChanged(auth, u => cb(u ? { uid: u.uid, name: u.displayName || u.email || '' } : null)),
      signIn: () => A.signInWithPopup(auth, new A.GoogleAuthProvider()), signOut: () => A.signOut(auth),
      list: async uid => (await F.getDocs(col(uid))).docs.map(d => ({ id: d.id, ...d.data() })),
      save: (uid, id, data) => F.setDoc(F.doc(col(uid), id), data), remove: (uid, id) => F.deleteDoc(F.doc(col(uid), id)) };
  } else return false;
  be.onUser(u => { user = u; onUser(u); }); return true;
}
export const signIn = () => be.signIn();
export const signOut = () => be.signOut();
export async function listSessions() { if (!user) return []; const l = await be.list(user.uid); return l.filter(s => s && Array.isArray(s.shots)).sort((a, b) => String(a.date).localeCompare(String(b.date))); }
export const saveSession = (id, data) => be.save(user.uid, id, data);
export const removeSession = id => be.remove(user.uid, id);
export async function removeAll() { for (const s of await listSessions()) await be.remove(user.uid, s.id); }
