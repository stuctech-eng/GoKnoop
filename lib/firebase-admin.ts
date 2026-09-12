import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

/**
 * Server-side Firebase Admin SDK init. Nooit importeren in client-code.
 *
 * Credentials komen uit environment variables (Vercel), nooit hardcoded.
 * FIREBASE_PRIVATE_KEY bevat letterlijke "\n"-tekens zoals gekopieerd uit het
 * service-account JSON-bestand — die worden hier omgezet naar echte regeleinden.
 *
 * TOEGEVOEGD 12-9-2026, timing-audit: firebase-initialisatie had nooit een
 * eigen meetpunt -- volledig ongemeten sinds het begin van het project.
 * `getLastDbInitBreakdown()` geeft de tijdsopsplitsing van de meest recente
 * `getDb()`-aanroep terug (initializeApp is 0ms bij een warme herhaalaanroep
 * binnen dezelfde instance, waar de Firebase-app al bestond).
 */

let app: App;

function getFirebaseApp(): App {
  if (getApps().length > 0) {
    return getApps()[0];
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKeyRaw) {
    throw new Error(
      "Ontbrekende Firebase environment variables: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL en/of FIREBASE_PRIVATE_KEY zijn niet ingesteld in Vercel."
    );
  }

  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  app = initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return app;
}

export function getDb(): Firestore {
  const t0 = Date.now();
  const a = getFirebaseApp();
  const afterInitApp = Date.now();
  const db = getFirestore(a);
  const afterGetFirestore = Date.now();
  (getDb as unknown as { _lastBreakdown: { initializeAppMs: number; getFirestoreMs: number } })._lastBreakdown = {
    initializeAppMs: afterInitApp - t0,
    getFirestoreMs: afterGetFirestore - afterInitApp,
  };
  return db;
}

/** Geeft de tijdsopsplitsing van de MEEST RECENTE getDb()-aanroep terug (initializeApp is 0ms bij een warme herhaalaanroep). */
export function getLastDbInitBreakdown(): { initializeAppMs: number; getFirestoreMs: number } {
  return (getDb as unknown as { _lastBreakdown?: { initializeAppMs: number; getFirestoreMs: number } })._lastBreakdown ?? { initializeAppMs: 0, getFirestoreMs: 0 };
}
