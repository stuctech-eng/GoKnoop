import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import type { GraphProvider } from "@/lib/route-engine/types";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/direct-route
 * Body: { fromNodeId?, toNodeId?, fromDisplayNumber?, toDisplayNumber?, nearLat?, nearLon? }
 * Response: { fromNodeId, toNodeId, result: "ok"|"failed", distanceM?, hopCount?, reason?,
 *             geographicDistanceM, computeTimeMs, fromNodeIdsFound, toNodeIdsFound }
 *
 * Diagnose-tool (sectie 9.52/9.55/9.56, 30-8-2026, "Hilversum doet een omweg" -- gerichte
 * vervolgtest op verzoek). UITGEBREID: `nearLat`/`nearLon` -- als een weergavenummer meerdere
 * treffers heeft (bevestigd: dat is de NORM, niet de uitzondering, sectie 9.55), kies dan het
 * knooppunt met dat nummer dat het DICHTST bij dit referentiepunt ligt, niet zomaar het eerste.
 * Toont nu ook `hopCount` (aantal knooppunten in de route) en `geographicDistanceM`
 * (hemelsbrede afstand tussen de twee gekozen knooppunten) -- om netwerkafstand vs.
 * geografische afstand te kunnen vergelijken (de kernvraag van deze test).
 */

function resolveNode(
  provider: GraphProvider,
  exactId: string | undefined,
  displayNumber: string | undefined,
  nearPointRd: { x: number; y: number } | null
): { nodeId: string | null; candidatesFound: number } {
  if (exactId) {
    return { nodeId: provider.getNode(exactId) ? exactId : null, candidatesFound: provider.getNode(exactId) ? 1 : 0 };
  }
  if (!displayNumber) return { nodeId: null, candidatesFound: 0 };

  const matches = provider.getAllNodeIds().filter((id) => provider.getNode(id)?.displayNumber === displayNumber);
  if (matches.length === 0) return { nodeId: null, candidatesFound: 0 };

  if (nearPointRd) {
    matches.sort((a, b) => {
      const na = provider.getNode(a)!;
      const nb = provider.getNode(b)!;
      const da = (na.x - nearPointRd.x) ** 2 + (na.y - nearPointRd.y) ** 2;
      const db = (nb.x - nearPointRd.x) ** 2 + (nb.y - nearPointRd.y) ** 2;
      return da - db;
    });
  }
  return { nodeId: matches[0], candidatesFound: matches.length };
}

export async function POST(req: NextRequest) {
  let body: {
    fromNodeId?: string;
    toNodeId?: string;
    fromDisplayNumber?: string;
    toDisplayNumber?: string;
    nearLat?: number;
    nearLon?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromNodeId: exactFromNodeId, toNodeId: exactToNodeId, fromDisplayNumber, toDisplayNumber, nearLat, nearLon } = body;

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const nearPointRd = nearLat !== undefined && nearLon !== undefined ? wgs84ToRd(nearLat, nearLon) : null;

    const from = resolveNode(provider, exactFromNodeId, fromDisplayNumber, nearPointRd);
    const to = resolveNode(provider, exactToNodeId, toDisplayNumber, nearPointRd);

    if (!from.nodeId || !to.nodeId) {
      return NextResponse.json(
        { error: `Knooppunt niet gevonden: ${!from.nodeId ? fromDisplayNumber ?? exactFromNodeId : toDisplayNumber ?? exactToNodeId}.` },
        { status: 404 }
      );
    }

    const fromNode = provider.getNode(from.nodeId)!;
    const toNode = provider.getNode(to.nodeId)!;
    const geographicDistanceM = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y);

    const t0 = Date.now();
    const result = computeRoute(provider, datasetVersionId, from.nodeId, to.nodeId);
    const computeTimeMs = Date.now() - t0;

    if ("reason" in result) {
      return NextResponse.json({
        fromNodeId: from.nodeId,
        toNodeId: to.nodeId,
        result: "failed",
        reason: result.reason,
        geographicDistanceM,
        computeTimeMs,
        fromNodeIdsFound: from.candidatesFound,
        toNodeIdsFound: to.candidatesFound,
      });
    }

    return NextResponse.json({
      fromNodeId: from.nodeId,
      toNodeId: to.nodeId,
      result: "ok",
      distanceM: result.distanceM,
      hopCount: result.nodes.length - 1,
      geographicDistanceM,
      computeTimeMs,
      fromNodeIdsFound: from.candidatesFound,
      toNodeIdsFound: to.candidatesFound,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
