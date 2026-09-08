import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import { fetchAllNwbSegmentsInBbox } from "@/lib/nwb-analysis/nwb-client";
import { classifySegment } from "@/lib/nwb-analysis/classify";
import { analyzeNwbGraph } from "@/lib/nwb-analysis/graph-analysis";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/nwb-gap-pinpoint?datasetVersionId=...&from=...&to=...&radiusM=2500
 *
 * TIJDELIJKE, puur lezende test (8-9-2026), vervolg op nwb-validation-test.
 * GEEN productiecode gewijzigd, GEEN Bridge Layer geactiveerd.
 *
 * Chirurgische aanpak i.p.v. een groot gebied: berekent eerst de daadwerkelijke
 * GoKnoop-only omweg-route, vindt het punt met de grootste afwijking van de
 * rechte lijn start->bestemming (het vermoedelijke "breukpunt" van de omweg),
 * en onderzoekt daar een klein, GEGARANDEERD-compleet NWB-gebied (geen
 * paginering/afkapping-risico bij een straal van een paar km).
 */

const DEFAULT_FROM = "CJSXBPUMG49vOPmYvhJd"; // Amsterdam Centraal
const DEFAULT_TO = "ZYuO6ZfzSa2iim0HcUbn"; // knooppunt 55, Hilversum

const SNAP_TOLERANCES_M = [5, 10, 20];

/** Loodrechte afstand van punt P tot de lijn A-B (alles in RD-meters). */
function perpendicularDistance(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
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
    return NextResponse.json({ error: "datasetVersionId-parameter verplicht." }, { status: 400 });
  }
  const fromNodeId = req.nextUrl.searchParams.get("from") ?? DEFAULT_FROM;
  const toNodeId = req.nextUrl.searchParams.get("to") ?? DEFAULT_TO;
  const radiusM = Number(req.nextUrl.searchParams.get("radiusM") ?? "2500");

  try {
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    // Stap 1: de daadwerkelijke, huidige GoKnoop-only omweg-route berekenen.
    const routeResult = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId);
    if (!("distanceM" in routeResult)) {
      return NextResponse.json({ error: "Kon geen GoKnoop-only route berekenen.", reason: routeResult.reason }, { status: 502 });
    }

    const startPoint = routeResult.geometry[0];
    const endPoint = routeResult.geometry[routeResult.geometry.length - 1];
    const straightLineDistanceM = Math.hypot(endPoint.x - startPoint.x, endPoint.y - startPoint.y);

    // Stap 2: het punt met de grootste loodrechte afwijking van de rechte lijn
    // start->bestemming zoeken -- het vermoedelijke "breukpunt" van de omweg.
    let maxDeviation = -1;
    let breakpoint = startPoint;
    let breakpointIndex = 0;
    routeResult.geometry.forEach((p, i) => {
      const dev = perpendicularDistance(p, startPoint, endPoint);
      if (dev > maxDeviation) {
        maxDeviation = dev;
        breakpoint = p;
        breakpointIndex = i;
      }
    });

    // Stap 3: klein, gegarandeerd-compleet NWB-gebied rond het breukpunt.
    const bbox = {
      minX: breakpoint.x - radiusM,
      maxX: breakpoint.x + radiusM,
      minY: breakpoint.y - radiusM,
      maxY: breakpoint.y + radiusM,
    };

    const { segments: allSegments, pagesRetrieved, truncated, debugFirstFeatureKeys } = await fetchAllNwbSegmentsInBbox(bbox, 4);

    const bstCodeDistribution: Record<string, number> = {};
    for (const s of allSegments) {
      const code = s.bstCode ?? "(leeg)";
      bstCodeDistribution[code] = (bstCodeDistribution[code] || 0) + 1;
    }

    const setASegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) === "setA");
    const setBSegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded");

    const setAComponents = Object.fromEntries(SNAP_TOLERANCES_M.map((t) => [`${t}m`, analyzeNwbGraph(setASegments, t)]));
    const setBComponents = Object.fromEntries(SNAP_TOLERANCES_M.map((t) => [`${t}m`, analyzeNwbGraph(setBSegments, t)]));

    // Stap 4: GoKnoop-knopen binnen dit kleine gebied + hun afstand tot NWB Set B.
    const allNodeIds = provider.getAllNodeIds();
    const goknoopNodesInRegion: { id: string; displayNumber: string; x: number; y: number; edgeCount: number; nearestNwbM: number | null }[] = [];
    const nwbEndpoints = setBSegments.flatMap((s) =>
      s.coordinates.length >= 2 ? [s.coordinates[0], s.coordinates[s.coordinates.length - 1]] : []
    );
    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      if (n.x >= bbox.minX && n.x <= bbox.maxX && n.y >= bbox.minY && n.y <= bbox.maxY) {
        let nearest: number | null = null;
        for (const p of nwbEndpoints) {
          const d = Math.hypot(p.x - n.x, p.y - n.y);
          if (nearest === null || d < nearest) nearest = d;
        }
        goknoopNodesInRegion.push({ id, displayNumber: n.displayNumber ?? "?", x: n.x, y: n.y, edgeCount: provider.getEdgesFrom(id).length, nearestNwbM: nearest });
      }
    }

    return NextResponse.json({
      stap1_goknoopOnlyRoute: {
        fromNodeId,
        toNodeId,
        actualDistanceM: routeResult.distanceM,
        straightLineDistanceM: Math.round(straightLineDistanceM),
        deviationFactor: (routeResult.distanceM / straightLineDistanceM).toFixed(1),
      },
      stap2_breukpunt: {
        indexInRoute: breakpointIndex,
        totalRoutePoints: routeResult.geometry.length,
        percentageDoorRoute: ((breakpointIndex / routeResult.geometry.length) * 100).toFixed(1) + "%",
        rdCoordinaten: breakpoint,
        loodrechteAfwijkingM: Math.round(maxDeviation),
      },
      stap3_nwbGebied: {
        bboxRD: bbox,
        radiusM,
        segmentenOpgehaald: allSegments.length,
        paginasOpgehaald: pagesRetrieved,
        truncated,
        bstCodeVerdeling: bstCodeDistribution,
        debugFirstFeatureKeys,
      },
      setA: { omschrijving: "BST_CODE = FP", segmentCount: setASegments.length, components: setAComponents },
      setB: { omschrijving: "FP + HR + RB, min. autosnelwegen/busbanen", segmentCount: setBSegments.length, components: setBComponents },
      stap4_goknoopKoppeling: {
        knopenInGebied: goknoopNodesInRegion.length,
        knopenMetNwbBinnen20m: goknoopNodesInRegion.filter((n) => n.nearestNwbM !== null && n.nearestNwbM <= 20).length,
        details: goknoopNodesInRegion.map((n) => ({
          knooppunt: n.displayNumber,
          edgeCountInGoKnoop: n.edgeCount,
          afstandTotDichtstbijzijndeNwbM: n.nearestNwbM !== null ? Math.round(n.nearestNwbM) : null,
        })),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Breukpunt-test mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
