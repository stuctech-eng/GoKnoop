import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Diagnose voor unmatched_both edges: hoe ver ligt de werkelijk dichtstbijzijnde
 * node (zonder de 5m-tolerantiegrens), en in welke regio's concentreert dit
 * zich? Onderscheidt "net buiten tolerantie" (kalibratieprobleem) van
 * "structureel ver weg" (regio-dekkingsgat, zoals verwacht uit Phase 1C).
 */

type SourceNode = { x: number; y: number };

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
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }
  const sampleSize = parseInt(req.nextUrl.searchParams.get("sample") || "300", 10);

  try {
    const db = getDb();

    const [nodesSnap, isolatedEdgesSnap] = await Promise.all([
      db.collection("sourceNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db
        .collection("edges")
        .where("datasetVersionId", "==", datasetVersionId)
        .where("matchConfidence", "==", "unmatched_both")
        .limit(sampleSize)
        .get(),
    ]);

    const nodes: SourceNode[] = nodesSnap.docs.map((d) => {
      const data = d.data();
      return { x: data.x, y: data.y };
    });

    const regioCounts: Record<string, number> = {};
    const distances: number[] = [];

    for (const doc of isolatedEdgesSnap.docs) {
      const data = doc.data();
      regioCounts[data.regio] = (regioCounts[data.regio] || 0) + 1;

      const coords = data.coords as { x: number; y: number }[];
      if (!coords || coords.length === 0) continue;
      const start = coords[0];

      let nearest = Infinity;
      for (const n of nodes) {
        const d = dist(start, n);
        if (d < nearest) nearest = d;
      }
      distances.push(nearest);
    }

    distances.sort((a, b) => a - b);
    const thresholds = [5, 10, 20, 50, 100, 500, 1000, 5000];
    const withinThreshold: Record<string, string> = {};
    for (const t of thresholds) {
      const count = distances.filter((d) => d <= t).length;
      withinThreshold[`within_${t}m`] = `${count}/${distances.length} (${((count / distances.length) * 100).toFixed(1)}%)`;
    }

    return NextResponse.json({
      datasetVersionId,
      sampledIsolatedEdges: isolatedEdgesSnap.size,
      regioDistribution: Object.entries(regioCounts).sort((a, b) => b[1] - a[1]),
      nearestNodeDistanceStats: distances.length
        ? {
            min: distances[0].toFixed(1),
            median: distances[Math.floor(distances.length / 2)].toFixed(1),
            max: distances[distances.length - 1].toFixed(1),
          }
        : null,
      withinThreshold,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
