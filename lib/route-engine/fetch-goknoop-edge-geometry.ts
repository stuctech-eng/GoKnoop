import type { Point } from "./types";

const FIRESTORE_IN_QUERY_LIMIT = 30; // Firestore's harde limiet voor "in"-queries

/**
 * Fase M6/M7 (GoKnoop-opslagformaat-fix, geometrie-scheiding), 10-9-2026.
 *
 * De bulk-graafopbouw (voor Dijkstra) laadt nu ALLEEN topologie (from/to/
 * distanceM) -- geen geometrie meer, die bleek de daadwerkelijke
 * bottleneck (78 gebatchte edge-documenten MET coords: 6,2s; puur
 * topologie: een fractie daarvan). Geometrie wordt nu PAS opgehaald NADAT
 * Dijkstra de winnende route heeft bepaald, en dan uitsluitend voor de
 * edges die daadwerkelijk in die ene route voorkomen (typisch een tiental,
 * niet alle 15.495).
 *
 * Haalt uit de ORIGINELE, ongewijzigde `edges`-collectie (die heeft de
 * volledige geometrie nog steeds, per-document) -- gerichte lookups op
 * exact ID zijn snel, ook al is de collectie zelf groot.
 */
export async function fetchGoknoopEdgeGeometry(edgeIds: string[]): Promise<Map<string, Point[]>> {
  const result = new Map<string, Point[]>();
  if (edgeIds.length === 0) return result;

  try {
    const { getDb } = await import("@/lib/firebase-admin");
    const db = getDb();
    const uniqueIds = Array.from(new Set(edgeIds));

    for (let i = 0; i < uniqueIds.length; i += FIRESTORE_IN_QUERY_LIMIT) {
      const batch = uniqueIds.slice(i, i + FIRESTORE_IN_QUERY_LIMIT);
      const snap = await db
        .collection("edges")
        .where("__name__", "in", batch.map((id) => db.collection("edges").doc(id)))
        .get();
      for (const doc of snap.docs) {
        const d = doc.data();
        result.set(doc.id, (d.coords as Point[]) || []);
      }
    }
  } catch {
    // Veilige degradatie: Firestore niet bereikbaar (bijv. in tests, of een
    // productiefout) -- geeft terug wat al gelukt is (mogelijk leeg). De
    // aanroeper (combined-route-geometry.ts) valt dan terug op de
    // provider's eigen geometrie, indien aanwezig.
  }

  return result;
}
