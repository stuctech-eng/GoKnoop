import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CANDIDATES: Record<string, string> = {
  "Amsterdam Centraal": "CJSXBPUMG49vOPmYvhJd",
  "Amsterdam alt-kandidaat": "MQAnNb1IMego7dnVPXpS",
  "Hilversum knooppunt 55": "ZYuO6ZfzSa2iim0HcUbn",
  "Volendam knooppunt 95": "7fmSWIHYsKu3Wb3yOtM2",
  "Lochem kandidaat": "0pgYw2kgDphP2IT1RAi7",
  "Lochem bestemming": "61aNR7RWLxQhHTOfMHtm",
};

/**
 * GET /api/admin/compare-goknoop-edges?datasetVersionId=...
 *
 * Fase 4-vervolg, 11-9-2026. Sommige kandidaten toonden verdacht lage
 * GoKnoop-edge-aantallen via het NIEUWE, gebatchte formaat (bijv. 0 voor
 * "Lochem bestemming", 1 voor "Amsterdam Centraal" -- een hoofdknooppunt).
 * Vergelijkt dit direct tegen de ORIGINELE, ongewijzigde `edges`-collectie
 * (matchConfidence='matched') om te bevestigen of de GoKnoop-batching-
 * migratie edges liet wegvallen.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId") ?? "uINZ3y2QsgBdEyky3duq";

  try {
    const db = getDb();
    const results: Record<string, unknown> = {};

    for (const [label, nodeId] of Object.entries(CANDIDATES)) {
      const [fromSnap, toSnap] = await Promise.all([
        db.collection("edges").where("datasetVersionId", "==", datasetVersionId).where("matchConfidence", "==", "matched").where("fromLogicalNodeId", "==", nodeId).get(),
        db.collection("edges").where("datasetVersionId", "==", datasetVersionId).where("matchConfidence", "==", "matched").where("toLogicalNodeId", "==", nodeId).get(),
      ]);

      results[label] = {
        nodeId,
        origineleEdgesCollectie: {
          alsFrom: fromSnap.size,
          alsTo: toSnap.size,
          totaal: fromSnap.size + toSnap.size,
        },
      };
    }

    return NextResponse.json({ datasetVersionId, resultaten: results });
  } catch (err) {
    return NextResponse.json(
      { error: "Vergelijking mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
