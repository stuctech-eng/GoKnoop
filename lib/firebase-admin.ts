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
 *
 * TERUGGEDRAAID 12-9-2026 (hotfix, app-breed niet-werkend): `preferRest: true`
 * (toegevoegd in commit d1172cf, "optie c architectuur") is hier verwijderd.
 * Root cause: preferRest schakelt gRPC-streaming uit ten gunste van losse
 * HTTP/1.1-round-trips per document. `FirestoreGraphProvider` leest duizenden
 * documenten (11.003 nodes) per aanvraag -- onder REST bleek dat trager, niet
 * sneller, waardoor requests over de 10s Vercel-limiet heen liepen en als
 * HTML-timeoutpagina terugkwamen i.p.v. JSON. Dat brak niet alleen de
 * precompute-route maar élke route die getDb() gebruikt, inclusief de
 * basale locatie-resolutie. Teruggezet naar de bewezen werkende standaard-
 * instelling. Niet opnieuw toevoegen zonder eerst afzonderlijk te meten of
 * het voor dít bulk-leespatroon daadwerkelijk sneller is.
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
