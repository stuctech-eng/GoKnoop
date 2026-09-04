import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { resolveNearestNodes } from "@/lib/route-engine/location-resolver";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/batch-diagnose
 * Body: { originLat, originLon, destLat, destLon, limit? }
 * Response: { pairs: {fromDisplayNumber, toDisplayNumber, result, distanceM?, hopCount?,
 *             geographicDistanceM, ratio?, anomaly}[] }
 *
 * Geautomatiseerde vervolgversie op het handmatige, één-paar-per-keer testen (sectie 9.52-
 * 9.66, 30-8-2026, op verzoek: "kun je niet iets automatiseren"). Test in ÉÉN aanvraag ALLE
 * combinaties tussen de N dichtstbijzijnde kandidaten bij twee punten (standaard 5x5=25
 * combinaties, begrensd om ruim binnen Vercel Hobby's 10s te blijven -- elke afzonderlijke
 * `computeRoute`-aanroep bleek vandaag doorgaans <150ms).
 *
 * Een combinatie wordt gemarkeerd als `anomaly: true` als de netwerkafstand meer dan 3x de
 * hemelsbrede afstand is (een ruime, maar redelijke marge voor normale fietsknooppunten-
 * circuity), of als er geen enkel pad bestaat (`disconnected`).
 */
export async function POST(req: NextRequest) {
  let body: { originLat?: number; originLon?: number; destLat?: number; destLon?: number; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { originLat, originLon, destLat, destLon } = body;
  if (originLat === undefined || originLon === undefined || destLat === undefined || destLon === undefined) {
    return NextResponse.json({ error: "originLat, originLon, destLat, destLon zijn verplicht." }, { status: 400 });
  }
  const limit = Math.min(body.limit ?? 5, 6); // hard begrensd -- 6x6=36 combinaties is de bovengrens binnen het tijdsbudget

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const originRd = wgs84ToRd(originLat, originLon);
    const destRd = wgs84ToRd(destLat, destLon);
    const originCandidates = resolveNearestNodes(provider, originRd, limit);
    const destCandidates = resolveNearestNodes(provider, destRd, limit);

    const pairs: {
      fromDisplayNumber: string;
      toDisplayNumber: string;
      result: "ok" | "failed";
      distanceM?: number;
      hopCount?: number;
      reason?: string;
      geographicDistanceM: number;
      ratio?: number;
      anomaly: boolean;
    }[] = [];

    for (const from of originCandidates) {
      for (const to of destCandidates) {
        const geographicDistanceM = Math.hypot(to.x - from.x, to.y - from.y);
        const result = computeRoute(provider, datasetVersionId, from.logicalNodeId, to.logicalNodeId);
        if ("reason" in result) {
          pairs.push({
            fromDisplayNumber: from.displayNumber ?? "?",
            toDisplayNumber: to.displayNumber ?? "?",
            result: "failed",
            reason: result.reason,
            geographicDistanceM,
            anomaly: true, // disconnected is per definitie een anomalie
          });
        } else {
          const ratio = geographicDistanceM > 0 ? result.distanceM / geographicDistanceM : 1;
          pairs.push({
            fromDisplayNumber: from.displayNumber ?? "?",
            toDisplayNumber: to.displayNumber ?? "?",
            result: "ok",
            distanceM: result.distanceM,
            hopCount: result.nodes.length - 1,
            geographicDistanceM,
            ratio,
            anomaly: ratio > 3, // ruime, maar redelijke marge voor normale knooppunten-circuity
          });
        }
      }
    }

    pairs.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));

    return NextResponse.json({
      pairs,
      originCandidatesFound: originCandidates.length,
      destCandidatesFound: destCandidates.length,
      anomalyCount: pairs.filter((p) => p.anomaly).length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Batch-diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
