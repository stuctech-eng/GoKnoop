import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { GraphProvider } from "@/lib/route-engine/types";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/direct-route
 * Body: { fromNodeId?, toNodeId?, fromDisplayNumber?, toDisplayNumber?,
 *         nearFromLat?, nearFromLon?, nearToLat?, nearToLon? }
 * Response: { fromNodeId, toNodeId, result: "ok"|"failed", distanceM?, hopCount?, reason?,
 *             geographicDistanceM, computeTimeMs, fromNodeIdsFound, toNodeIdsFound }
 *
 * Diagnose-tool (sectie 9.52/9.55/9.56/9.57, 30-8-2026, "gat tussen Waterland en het Gooi").
 * UITGEBREID (sectie 9.58): APARTE referentiepunten voor herkomst en bestemming
 * (`nearFromLat`/`nearFromLon` vs. `nearToLat`/`nearToLon`) -- nodig om bijv. "knooppunt 60
 * dichtbij Amsterdam-Noord" en "knooppunt 36 dichtbij Hilversum" TEGELIJK correct op te lossen
 * (met een enkel gedeeld referentiepunt zou dat niet lukken, de twee gebieden liggen te ver
 * uit elkaar).
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

  if (displayNumber) {
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

  // GEEN weergavenummer opgegeven, WEL een referentiepunt (30-8-2026, "we gaan door tot het
  // gefixt is"): het dichtstbijzijnde knooppunt bij dit punt, ongeacht weergavenummer -- veel
  // flexibeler voor het snel testen van willekeurige plekken tijdens het inperken van het gat,
  // zonder eerst een specifiek nummer daar te hoeven opzoeken.
  if (nearPointRd) {
    let closest: string | null = null;
    let closestDistSq = Infinity;
    for (const id of provider.getAllNodeIds()) {
      const node = provider.getNode(id);
      if (!node) continue;
      const distSq = (node.x - nearPointRd.x) ** 2 + (node.y - nearPointRd.y) ** 2;
      if (distSq < closestDistSq) {
        closestDistSq = distSq;
        closest = id;
      }
    }
    return { nodeId: closest, candidatesFound: closest ? 1 : 0 };
  }

  return { nodeId: null, candidatesFound: 0 };
}

export async function POST(req: NextRequest) {
  let body: {
    fromNodeId?: string;
    toNodeId?: string;
    fromDisplayNumber?: string;
    toDisplayNumber?: string;
    nearFromLat?: number;
    nearFromLon?: number;
    nearToLat?: number;
    nearToLon?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const {
    fromNodeId: exactFromNodeId,
    toNodeId: exactToNodeId,
    fromDisplayNumber,
    toDisplayNumber,
    nearFromLat,
    nearFromLon,
    nearToLat,
    nearToLon,
  } = body;

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const nearFromRd = nearFromLat !== undefined && nearFromLon !== undefined ? wgs84ToRd(nearFromLat, nearFromLon) : null;
    const nearToRd = nearToLat !== undefined && nearToLon !== undefined ? wgs84ToRd(nearToLat, nearToLon) : null;

    const from = resolveNode(provider, exactFromNodeId, fromDisplayNumber, nearFromRd);
    const to = resolveNode(provider, exactToNodeId, toDisplayNumber, nearToRd);

    if (!from.nodeId || !to.nodeId) {
      return NextResponse.json(
        { error: `Knooppunt niet gevonden: ${!from.nodeId ? fromDisplayNumber ?? exactFromNodeId : toDisplayNumber ?? exactToNodeId}.` },
        { status: 404 }
      );
    }

    const fromNode = provider.getNode(from.nodeId)!;
    const toNode = provider.getNode(to.nodeId)!;
    const geographicDistanceM = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y);
    const fromWgs84 = rdToWgs84(fromNode.x, fromNode.y);
    const toWgs84 = rdToWgs84(toNode.x, toNode.y);
    const resolvedInfo = {
      fromDisplayNumber: fromNode.displayNumber,
      fromLat: fromWgs84.lat,
      fromLon: fromWgs84.lon,
      toDisplayNumber: toNode.displayNumber,
      toLat: toWgs84.lat,
      toLon: toWgs84.lon,
    };

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
        ...resolvedInfo,
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
      ...resolvedInfo,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
