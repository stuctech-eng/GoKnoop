import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/patch-ferry-edge
 *
 * EENMALIGE, GERICHTE DATAPATCH (30-8-2026, sectie 9.63/9.64) -- voegt PRECIES ÉÉN
 * ontbrekende verbinding toe aan de knooppuntengraaf: de pontje-oversteek tussen knooppunt 61
 * (Buiksloterweg, noordkant IJ) en knooppunt 5 (Amsterdam Centraal, zuidkant IJ). Grondig
 * geverifieerd vandaag: een directe test tussen deze twee exacte knooppunten gaf
 * "disconnected" (géén enkel pad, hoe lang ook), terwijl ze slechts 1,6 km hemelsbreed uit
 * elkaar liggen -- een harde knip in de brondata, vermoedelijk omdat het pontje in
 * OpenStreetMap als `route=ferry` getagd staat i.p.v. een gewoon fietspad, en dus niet
 * herkend werd bij de oorspronkelijke import (Fase 1).
 *
 * VEILIGHEIDSMAATREGELEN:
 * - Uitsluitend deze TWEE, hardgecodeerde knooppunt-ID's -- geen generieke "voeg edges toe"-
 *   functionaliteit, geen risico voor de rest van het netwerk.
 * - Controleert eerst of de edge al bestaat (voorkomt duplicaten bij een tweede aanroep).
 * - Controleert dat beide knooppunten daadwerkelijk bestaan in de actieve dataset voordat er
 *   iets geschreven wordt.
 * - `matchConfidence: "matched"` (verplicht, anders wordt de edge door FirestoreGraphProvider
 *   genegeerd, zie sectie hierboven).
 *
 * Na deze patch: de `CachedGraphProvider`'s in-memory cache (module-niveau) moet ververst
 * worden voordat de nieuwe edge daadwerkelijk gebruikt wordt door lopende serverless-
 * instances -- gebeurt vanzelf bij de eerstvolgende koude start, of kan geforceerd worden
 * door een nieuwe deploy.
 */

const FROM_NODE_ID = "bvMw2fsQTTyeJMUfX6wX"; // Knooppunt 61, Buiksloterweg (noordkant IJ)
const TO_NODE_ID = "CJSXBPUMG49vOPmYvhJd"; // Knooppunt 5, Amsterdam Centraal (zuidkant IJ)
const ESTIMATED_DISTANCE_M = 1600; // hemelsbrede afstand als redelijke schatting voor de pontje-oversteek

export async function POST(_req: NextRequest) {
  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const fromNode = provider.getNode(FROM_NODE_ID);
    const toNode = provider.getNode(TO_NODE_ID);
    if (!fromNode || !toNode) {
      return NextResponse.json(
        { error: "Eén van de twee knooppunten bestaat niet in de actieve dataset -- patch NIET uitgevoerd." },
        { status: 404 }
      );
    }

    // Controleer of de edge al bestaat (voorkomt duplicaten bij een herhaalde aanroep).
    const existingSnap = await db
      .collection("edges")
      .where("datasetVersionId", "==", datasetVersionId)
      .where("fromLogicalNodeId", "in", [FROM_NODE_ID, TO_NODE_ID])
      .get();
    const alreadyExists = existingSnap.docs.some((doc) => {
      const d = doc.data();
      return (
        (d.fromLogicalNodeId === FROM_NODE_ID && d.toLogicalNodeId === TO_NODE_ID) ||
        (d.fromLogicalNodeId === TO_NODE_ID && d.toLogicalNodeId === FROM_NODE_ID)
      );
    });
    if (alreadyExists) {
      return NextResponse.json({ status: "already_exists", message: "De pontje-edge bestond al -- niets gewijzigd." });
    }

    const newEdgeRef = db.collection("edges").doc();
    await newEdgeRef.set({
      datasetVersionId,
      matchConfidence: "matched",
      fromLogicalNodeId: FROM_NODE_ID,
      toLogicalNodeId: TO_NODE_ID,
      distanceM: ESTIMATED_DISTANCE_M,
      directionality: "unknown", // pontjes zijn tweerichtingsverkeer
      coords: [
        { x: fromNode.x, y: fromNode.y },
        { x: toNode.x, y: toNode.y },
      ],
      // Herkenbaar gemaakt voor toekomstige inspectie/eventueel terugdraaien.
      source: "manual-patch-2026-08-30",
      patchReason: "pontje-oversteek Buiksloterweg <-> Amsterdam Centraal, sectie 9.63/9.64",
    });

    return NextResponse.json({
      status: "created",
      edgeId: newEdgeRef.id,
      fromNodeId: FROM_NODE_ID,
      toNodeId: TO_NODE_ID,
      distanceM: ESTIMATED_DISTANCE_M,
      note: "De CachedGraphProvider-cache van warme serverless-instances ververst pas bij een koude start of nieuwe deploy.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Patch mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
