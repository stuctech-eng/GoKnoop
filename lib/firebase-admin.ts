import { initializeApp, getApps, cert, App } from "firebase-admin/app";
import { getFirestore, Firestore } from "firebase-admin/firestore";

/**
 * Server-side Firebase Admin SDK init. Nooit importeren in client-code.
 *
 * Credentials komen uit environment variables (Vercel), nooit hardcoded.
 * FIREBASE_PRIVATE_KEY bevat letterlijke "\n"-tekens zoals gekopieerd uit het
 * service-account JSON-bestand — die worden hier omgezet naar echte regeleinden.
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
  return getFirestore(getFirebaseApp());
}
