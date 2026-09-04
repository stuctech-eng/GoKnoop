import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/component-size
 * Body: { nodeId }
 * Response: { componentSize, sampleDisplayNumbers, totalNodesInGraph }
 *
 * Diagnose-tool (sectie 9.68/9.69, 30-8-2026, "is knooppunt 5 een eiland?") -- doet een
 * simpele breedte-eerst-zoektocht (BFS) vanaf het opgegeven knooppunt en telt hoeveel andere
 * knooppunten daadwerkelijk bereikbaar zijn, ONGEACHT afstand. Als dat een klein getal is
 * (een paar tientallen i.p.v. duizenden), bevestigt dat direct dat het knooppunt in een klein,
 * geïsoleerd eiland zit -- in plaats van dit af te leiden uit losse, één-voor-één
 * afstandstests.
 */
export async function POST(req: NextRequest) {
  let body: { nodeId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { nodeId } = body;
  if (!nodeId) {
    return NextResponse.json({ error: "nodeId is verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (!provider.getNode(nodeId)) {
      return NextResponse.json({ error: "Knooppunt bestaat niet in de actieve dataset." }, { status: 404 });
    }

    const visited = new Set<string>([nodeId]);
    const queue: string[] = [nodeId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of provider.getEdgesFrom(current)) {
        const neighborId = edge.fromLogicalNodeId === current ? edge.toLogicalNodeId : edge.fromLogicalNodeId;
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    const sampleDisplayNumbers = Array.from(visited)
      .slice(0, 20)
      .map((id) => provider.getNode(id)?.displayNumber ?? "?");

    return NextResponse.json({
      componentSize: visited.size,
      sampleDisplayNumbers,
      totalNodesInGraph: provider.getAllNodeIds().length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
