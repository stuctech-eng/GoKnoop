import { getDb } from "@/lib/firebase-admin";
import type { LocalBikeRouteResult } from "@/lib/local-bike-router/types";

/**
 * Permanente cache van eerder berekende fietspad-stukken TUSSEN TWEE KNOOPPUNTEN
 * (19-9-2026, "functie 2: kortste weg via knooppunten met de echte-fietspad-motor",
 * GO van Te). Firestore, niet in-memory -- overleeft koude starts EN wordt gedeeld
 * tussen alle gebruikers, precies om de reden die Te zelf aangaf: ORS heeft een
 * beperkt gebruik (bevestigd eerder incident: ~40 aanvragen/minuut, ~2000/dag,
 * gedeeld over de hele app). Veel routes van verschillende gebruikers lopen via
 * dezelfde populaire knooppunt-verbindingen -- eenmaal berekend, nooit meer
 * opnieuw bij ORS nodig.
 *
 * Sleutel is GEORDEND (fromNodeId__toNodeId, niet gesorteerd) -- bewust NIET
 * aangenomen dat een fietspad in beide richtingen identiek is (eenrichtingspaden
 * bestaan); dat is een expliciete, voorzichtige keuze, geen bewezen noodzaak. Dit
 * halveert het cache-hergebruik t.o.v. een symmetrische sleutel, maar voorkomt een
 * mogelijk foutieve aanname.
 *
 * Los van `LocalBikeRouter`'s eigen in-memory cache (die blijft ongewijzigd bestaan
 * en helpt binnen één enkel verzoek/warme instance) -- dit is een AANVULLENDE,
 * permanente laag specifiek voor knooppunt-tot-knooppunt-stukken.
 */

const COLLECTION = "knotSegmentCache";

function docId(fromNodeId: string, toNodeId: string): string {
  return `${fromNodeId}__${toNodeId}`;
}

export async function getCachedKnotSegment(fromNodeId: string, toNodeId: string): Promise<LocalBikeRouteResult | null> {
  const db = getDb();
  const snap = await db.collection(COLLECTION).doc(docId(fromNodeId, toNodeId)).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!data) return null;
  // Lichte vormcontrole -- geen stilzwijgende foutieve cache-hit bij onverwachte/oude data.
  if (typeof data.distanceM !== "number" || typeof data.durationS !== "number" || !Array.isArray(data.geometry)) {
    return null;
  }
  return {
    geometry: data.geometry,
    distanceM: data.distanceM,
    durationS: data.durationS,
    steps: Array.isArray(data.steps) ? data.steps : undefined,
  };
}

export async function setCachedKnotSegment(fromNodeId: string, toNodeId: string, result: LocalBikeRouteResult): Promise<void> {
  const db = getDb();
  await db
    .collection(COLLECTION)
    .doc(docId(fromNodeId, toNodeId))
    .set({
      geometry: result.geometry,
      distanceM: result.distanceM,
      durationS: result.durationS,
      steps: result.steps ?? [],
      cachedAt: new Date().toISOString(),
    });
}
