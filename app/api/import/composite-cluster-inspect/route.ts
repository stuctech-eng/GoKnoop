import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Gerichte sanity-check voor specifieke composite clusters (opgevraagd via
 * ?ids=comma,separated,logicalNodeIds). Toont per cluster de fysieke
 * bronpunten (coördinaten, onderlinge afstand, soort_knooppunt, knooppuntnr,
 * regio) en welke edges aan welk specifiek punt hangen — zodat je kunt
 * beoordelen of het daadwerkelijk één logisch kruispunt is, of dat er
 * per ongeluk losse knooppunten zijn samengevoegd.
 */

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  const idsParam = req.nextUrl.searchParams.get("ids");
  if (!datasetVersionId || !idsParam) {
    return NextResponse.json({ error: "datasetVersionId en ids zijn verplicht." }, { status: 400 });
  }
  const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);

  try {
    const db = getDb();
    const results = [];

    for (const logicalNodeId of ids) {
      const logicalDoc = await db.collection("logicalNodes").doc(logicalNodeId).get();
      if (!logicalDoc.exists) {
        results.push({ logicalNodeId, error: "Niet gevonden." });
        continue;
      }
      const logicalData = logicalDoc.data()!;
      const mappings: { sourceNodeId: string; mergeDecision: string }[] = logicalData.sourceNodeMappings || [];

      const sourceNodeDocs = await Promise.all(
        mappings.map((m) => db.collection("sourceNodes").doc(m.sourceNodeId).get())
      );
      const physicalPoints = sourceNodeDocs.map((doc, i) => {
        const d = doc.data();
        return {
          sourceNodeId: mappings[i].sourceNodeId,
          mergeDecision: mappings[i].mergeDecision,
          knooppuntnr: d?.knooppuntnr,
          regio: d?.regio,
          soortKnooppunt: d?.soortKnooppunt,
          x: d?.x,
          y: d?.y,
        };
      });

      let maxPairwise = 0;
      let sumPairwise = 0;
      let pairCount = 0;
      for (let i = 0; i < physicalPoints.length; i++) {
        for (let j = i + 1; j < physicalPoints.length; j++) {
          const d = dist(physicalPoints[i], physicalPoints[j]);
          maxPairwise = Math.max(maxPairwise, d);
          sumPairwise += d;
          pairCount++;
        }
      }

      const [fromSnap, toSnap] = await Promise.all([
        db.collection("edges").where("fromLogicalNodeId", "==", logicalNodeId).get(),
        db.collection("edges").where("toLogicalNodeId", "==", logicalNodeId).get(),
      ]);
      const edgeDocsById: Record<string, FirebaseFirestore.QueryDocumentSnapshot> = {};
      fromSnap.docs.forEach((d) => (edgeDocsById[d.id] = d));
      toSnap.docs.forEach((d) => (edgeDocsById[d.id] = d));

      const edgesPerPhysicalPoint: Record<string, number> = {};
      physicalPoints.forEach((p) => (edgesPerPhysicalPoint[p.sourceNodeId] = 0));
      let internalEdgeCount = 0; // edge waarbij beide kanten binnen dit cluster matchen

      for (const edgeDoc of Object.values(edgeDocsById)) {
        const d = edgeDoc.data();
        const matches: { matchedSourceNodeId: string | null; logicalNodeId: string | null }[] =
          d.endpointMatches || [];
        let touchesCount = 0;
        for (const m of matches) {
          if (m.logicalNodeId === logicalNodeId && m.matchedSourceNodeId) {
            edgesPerPhysicalPoint[m.matchedSourceNodeId] = (edgesPerPhysicalPoint[m.matchedSourceNodeId] || 0) + 1;
            touchesCount++;
          }
        }
        if (touchesCount === 2) internalEdgeCount++;
      }

      results.push({
        logicalNodeId,
        displayNumber: logicalData.displayNumber,
        displayRegio: logicalData.displayRegio,
        physicalPointCount: physicalPoints.length,
        maxPairwiseDistanceM: maxPairwise.toFixed(1),
        avgPairwiseDistanceM: pairCount ? (sumPairwise / pairCount).toFixed(1) : "0",
        totalAttachedEdges: Object.keys(edgeDocsById).length,
        internalEdgeCount,
        physicalPoints: physicalPoints.map((p) => ({
          ...p,
          attachedEdgeCount: edgesPerPhysicalPoint[p.sourceNodeId] || 0,
        })),
        allPointsHaveEdges: physicalPoints.every((p) => (edgesPerPhysicalPoint[p.sourceNodeId] || 0) > 0),
      });
    }

    return NextResponse.json({ datasetVersionId, clusters: results });
  } catch (err) {
    return NextResponse.json(
      { error: "Inspectie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
