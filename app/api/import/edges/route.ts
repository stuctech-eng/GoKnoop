import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { fetchWfsPage } from "@/lib/wfs-client";
import { parseFietsnetwerkenVrij } from "@/lib/gml-parser";

export const maxDuration = 60;

/**
 * Phase 1C, stap 13 — importer, deel 2: edges.
 *
 * Haalt fietsnetwerken_vrij gepagineerd op en schrijft de ruwe brondata naar
 * edges. rijrichting wordt ongewijzigd bewaard; directionality wordt hier al
 * op 'unknown' gezet (zie ontwerp sectie 4/6 — geen gok, veilige default).
 * fromLogicalNodeId/toLogicalNodeId/matchConfidence worden pas in de
 * matching-stap ingevuld (na de composite-node-clustering).
 *
 * Hervatbaar, zelfde patroon als /api/import/nodes.
 */

const PAGE_SIZE_DEFAULT = 200;
const FIRESTORE_BATCH_LIMIT = 500;

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const startIndex = parseInt(req.nextUrl.searchParams.get("startIndex") || "0", 10);
  const pageSize = parseInt(req.nextUrl.searchParams.get("pageSize") || String(PAGE_SIZE_DEFAULT), 10);
  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");

  if (!datasetVersionId) {
    return NextResponse.json(
      { error: "datasetVersionId is verplicht — gebruik dezelfde versie als de nodes-import." },
      { status: 400 }
    );
  }

  try {
    const db = getDb();

    const { xml, numberMatched, numberReturned } = await fetchWfsPage(
      "routedatabank:fietsnetwerken_vrij",
      startIndex,
      pageSize
    );

    const edges = parseFietsnetwerkenVrij(xml);

    for (let i = 0; i < edges.length; i += FIRESTORE_BATCH_LIMIT) {
      const chunk = edges.slice(i, i + FIRESTORE_BATCH_LIMIT);
      const batch = db.batch();
      for (const e of chunk) {
        // Deterministische ID (datasetVersionId + sourceObjectId): een herhaalde
        // of gedeeltelijk mislukte aanroep overschrijft hetzelfde document in
        // plaats van een duplicaat aan te maken (pre-flight checklist punt 1).
        const ref = db.collection("edges").doc(`${datasetVersionId}_${e.sourceObjectId}`);
        batch.set(ref, {
          datasetVersionId,
          sourceObjectId: e.sourceObjectId,
          regio: e.regio,
          provincie: e.provincie,
          rijrichting: e.rijrichting,
          directionality: "unknown",
          distanceM: e.distanceM,
          coords: e.coords,
          fromLogicalNodeId: null,
          toLogicalNodeId: null,
          matchConfidence: null,
          mode: "bicycle",
          network: null,
          restrictions: {},
          qualityScore: null,
          createdAt: new Date().toISOString(),
        });
      }
      await batch.commit();
    }

    const newStartIndex = startIndex + numberReturned;
    const done = newStartIndex >= numberMatched || numberReturned === 0;

    if (done) {
      await db.collection("datasetVersions").doc(datasetVersionId).update({
        edgeCount: newStartIndex,
      });
    }

    return NextResponse.json({
      datasetVersionId,
      startIndex,
      numberReturned,
      numberMatched,
      newStartIndex,
      done,
      nextUrl: done
        ? null
        : `/api/import/edges?key=...&datasetVersionId=${datasetVersionId}&startIndex=${newStartIndex}&pageSize=${pageSize}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Edge-import mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
