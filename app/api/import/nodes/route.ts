import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { fetchWfsPage } from "@/lib/wfs-client";
import { parseFietsknooppuntenVrij } from "@/lib/gml-parser";

/**
 * Phase 1C, stap 13 — importer, deel 1: nodes.
 *
 * Haalt fietsknooppunten_vrij gepagineerd op (RD-native, geen CRS-conversie
 * nodig) en schrijft de ruwe brondata ongewijzigd naar sourceNodes.
 *
 * Hervatbaar: elke aanroep verwerkt één pagina. Roep herhaaldelijk aan met
 * oplopende startIndex totdat done=true. Zonder datasetVersionId wordt een
 * nieuwe dataset_version aangemaakt (status 'pending').
 *
 * Query params:
 *   key              — DEBUG_SECRET
 *   datasetVersionId — bestaande versie hervatten (optioneel bij eerste call)
 *   startIndex       — WFS-paginering (default 0)
 *   pageSize         — records per pagina (default 1000)
 */

const PAGE_SIZE_DEFAULT = 1000;
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
  let datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");

  try {
    const db = getDb();

    if (!datasetVersionId) {
      if (startIndex !== 0) {
        return NextResponse.json(
          { error: "startIndex > 0 zonder datasetVersionId — geef de versie mee om te hervatten." },
          { status: 400 }
        );
      }
      const newDoc = await db.collection("datasetVersions").add({
        source: "routedatabank",
        importedAt: new Date().toISOString(),
        status: "pending",
        nodeCount: 0,
        edgeCount: 0,
        validationResult: null,
      });
      datasetVersionId = newDoc.id;
    }

    const { xml, numberMatched, numberReturned } = await fetchWfsPage(
      "routedatabank:fietsknooppunten_vrij",
      startIndex,
      pageSize
    );

    const nodes = parseFietsknooppuntenVrij(xml);

    // Firestore batches: max 500 writes per batch.
    for (let i = 0; i < nodes.length; i += FIRESTORE_BATCH_LIMIT) {
      const chunk = nodes.slice(i, i + FIRESTORE_BATCH_LIMIT);
      const batch = db.batch();
      for (const n of chunk) {
        const ref = db.collection("sourceNodes").doc();
        batch.set(ref, {
          datasetVersionId,
          sourceObjectId: n.sourceObjectId,
          knooppuntnr: n.knooppuntnr,
          regio: n.regio,
          provincie: n.provincie,
          soortKnooppunt: n.soortKnooppunt,
          networkType: "fiets",
          x: n.x,
          y: n.y,
          logicalNodeId: null,
          createdAt: new Date().toISOString(),
        });
      }
      await batch.commit();
    }

    const newStartIndex = startIndex + numberReturned;
    const done = newStartIndex >= numberMatched || numberReturned === 0;

    if (done) {
      await db.collection("datasetVersions").doc(datasetVersionId).update({
        nodeCount: newStartIndex,
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
        : `/api/import/nodes?key=...&datasetVersionId=${datasetVersionId}&startIndex=${newStartIndex}&pageSize=${pageSize}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Node-import mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
