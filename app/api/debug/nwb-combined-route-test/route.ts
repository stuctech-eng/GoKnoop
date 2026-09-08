import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { buildCombinedGraph, dijkstraOnCombinedGraph } from "@/lib/nwb-analysis/combined-graph";
import type { NwbSegment } from "@/lib/nwb-analysis/nwb-client";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/nwb-combined-route-test
 * Body: { datasetVersionId, from, to, nwbSegments: NwbSegment[], tolerances?: number[] }
 *
 * TIJDELIJKE, puur lezende beslissende test (8-9-2026). GEEN productiecode
 * gewijzigd, GEEN database geschreven, GEEN Bridge Layer/rijrichting
 * aangeraakt, GEEN externe routers gebruikt. Bouwt een tijdelijke,
 * uitsluitend-in-memory gecombineerde graaf (GoKnoop + al-verzamelde NWB-
 * corridordata + connectors) en draait Dijkstra, per opgegeven
 * snap-tolerantie apart.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { datasetVersionId?: string; from?: string; to?: string; nwbSegments?: NwbSegment[]; tolerances?: number[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { datasetVersionId, from, to, nwbSegments } = body;
  const tolerances = body.tolerances && body.tolerances.length > 0 ? body.tolerances : [2, 5, 10];

  if (!datasetVersionId || !from || !to || !nwbSegments) {
    return NextResponse.json({ error: "datasetVersionId, from, to en nwbSegments zijn verplicht." }, { status: 400 });
  }

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const fromNode = provider.getNode(from);
    const toNode = provider.getNode(to);
    if (!fromNode || !toNode) {
      return NextResponse.json({ error: "from- of to-knooppunt niet gevonden." }, { status: 404 });
    }
    const straightLineDistanceM = Math.hypot(toNode.x - fromNode.x, toNode.y - fromNode.y);

    // Zoekgebied voor connectors: bounding box van alle meegegeven NWB-segmenten,
    // met een kleine marge -- geen reden om buiten dit gebied naar aansluitingen
    // te zoeken (daar is toch geen NWB-data verzameld).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of nwbSegments) {
      for (const c of s.coordinates) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
      }
    }
    const connectorSearchBbox = { minX: minX - 50, minY: minY - 50, maxX: maxX + 50, maxY: maxY + 50 };

    const resultsPerTolerance: Record<string, unknown> = {};

    for (const tol of tolerances) {
      const graph = buildCombinedGraph(provider, nwbSegments, tol, connectorSearchBbox);
      const result = dijkstraOnCombinedGraph(graph, from, to);

      if (!result.found) {
        resultsPerTolerance[`${tol}m`] = { routeFound: false };
        continue;
      }

      // Sanity-checks.
      const deviationFactor = result.distanceM / straightLineDistanceM;

      // Richtings-consistentie: netto verplaatsing (start->eind van het gevonden
      // pad, via werkelijke posities) t.o.v. totale afgelegde afstand. Een reële
      // route zonder enorme omweg heeft een redelijk hoge ratio; een sterk
      // kronkelend/omweg-pad een lage.
      const pathPositions = result.steps.map((s) => graph.nodePosition.get(s.nodeId)).filter((p): p is NonNullable<typeof p> => !!p);
      const netDisplacementM =
        pathPositions.length >= 2
          ? Math.hypot(
              pathPositions[pathPositions.length - 1].x - pathPositions[0].x,
              pathPositions[pathPositions.length - 1].y - pathPositions[0].y
            )
          : 0;
      const directionConsistencyRatio = result.distanceM > 0 ? netDisplacementM / result.distanceM : 0;

      // Verdachte connectors: aansluitingen dicht bij de tolerantiegrens zelf
      // (dus net-nog-wel-toegestaan) -- de moeite waard om apart te bekijken,
      // niet per definitie fout.
      const suspiciousConnectors = result.steps.filter((s) => s.edgeSource === "connector");

      // Segmenttype-verdeling langs het NWB-deel van de route.
      const bstCodeBreakdown: Record<string, number> = {};
      for (const s of result.steps) {
        if (s.edgeSource === "nwb" && s.nwbInfo) {
          const code = s.nwbInfo.bstCode ?? "(leeg)";
          bstCodeBreakdown[code] = (bstCodeBreakdown[code] || 0) + 1;
        }
      }

      resultsPerTolerance[`${tol}m`] = {
        routeFound: true,
        distanceMeters: Math.round(result.distanceM),
        straightLineDistanceM: Math.round(straightLineDistanceM),
        deviationFactor: deviationFactor.toFixed(2),
        goknoopEdgeCount: result.goknoopEdgeCount,
        nwbEdgeCount: result.nwbEdgeCount,
        connectorCount: result.connectorCount,
        totalHops: result.steps.length,
        sanityChecks: {
          directionConsistencyRatio: directionConsistencyRatio.toFixed(2),
          directionConsistencyOordeel:
            directionConsistencyRatio > 0.6 ? "plausibel (rechtlijnig)" : directionConsistencyRatio > 0.3 ? "matig, controleer handmatig" : "verdacht kronkelend/omweg",
          nwbBstCodeVerdelingInRoute: bstCodeBreakdown,
          aantalConnectorsGebruikt: suspiciousConnectors.length,
          connectorAfstanden: suspiciousConnectors.map((s) => ({ nodeId: s.nodeId, afstandTotaalOpDitPunt: Math.round(s.distanceM) })),
        },
        eersteStappen: result.steps.slice(0, 20).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
        laatsteStappen: result.steps.slice(-20).map((s) => ({ nodeId: s.nodeId, bron: s.edgeSource, cumulatieveAfstandM: Math.round(s.distanceM) })),
      };
    }

    return NextResponse.json({
      from,
      to,
      straightLineDistanceM: Math.round(straightLineDistanceM),
      nwbSegmentenGebruikt: nwbSegments.length,
      huidigeGoKnoopOnlyAfstandM: 366859, // bekend, eerder gemeten -- ter vergelijking
      resultatenPerTolerantie: resultsPerTolerance,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Gecombineerde routetest mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
