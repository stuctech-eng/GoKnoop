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

    // Stap 2: TWEE punten bepalen, met verschillend doel.
    //
    // (a) Diepste punt (grootste loodrechte afwijking) -- puur informatief,
    // laat zien HOE ERG de omweg is, maar is NIET waar het misgaat: het is het
    // verste punt van een route die al lang van het pad af is.
    //
    // (b) EERSTE significante afwijking (TOEGEVOEGD 8-9-2026, n.a.v. het
    // eerdere resultaat: het diepste punt bleek ~99km van de rechte lijn te
    // liggen, ergens ver buiten het Amsterdam/Hilversum-gebied -- duidelijk
    // niet de daadwerkelijke gat-locatie). Dit is het eerste punt waar de
    // route meer dan 20% van de totale rechte-lijn-afstand van die lijn
    // afwijkt -- de vermoedelijke DECISIE-plek waar de route voor het eerst
    // gedwongen wordt om van het logische pad af te wijken. Dit punt wordt
    // hieronder gebruikt als centrum van het NWB-onderzoeksgebied, niet het
    // diepste punt.
    let maxDeviation = -1;
    let deepestPoint = startPoint;
    let deepestPointIndex = 0;
    routeResult.geometry.forEach((p, i) => {
      const dev = perpendicularDistance(p, startPoint, endPoint);
      if (dev > maxDeviation) {
        maxDeviation = dev;
        deepestPoint = p;
        deepestPointIndex = i;
      }
    });

    const SIGNIFICANT_DEVIATION_THRESHOLD_M = straightLineDistanceM * 0.2;
    let firstDeviationPoint = deepestPoint; // fallback als er nooit een "kleine" afwijking eerst voorkomt
    let firstDeviationIndex = deepestPointIndex;
    for (let i = 0; i < routeResult.geometry.length; i++) {
      const dev = perpendicularDistance(routeResult.geometry[i], startPoint, endPoint);
      if (dev > SIGNIFICANT_DEVIATION_THRESHOLD_M) {
        firstDeviationPoint = routeResult.geometry[i];
        firstDeviationIndex = i;
        break;
      }
    }

    // Stap 3: klein, gegarandeerd-compleet NWB-gebied rond het EERSTE
    // significante afwijkingspunt (niet het diepste punt, zie hierboven).
    const bbox = {
      minX: firstDeviationPoint.x - radiusM,
      maxX: firstDeviationPoint.x + radiusM,
      minY: firstDeviationPoint.y - radiusM,
      maxY: firstDeviationPoint.y + radiusM,
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
        eersteSignificanteAfwijking: {
          omschrijving: "Eerste punt waar de route >20% van de rechte-lijn-afstand afwijkt -- vermoedelijke decisie-plek, gebruikt als centrum van het NWB-onderzoeksgebied hieronder.",
          indexInRoute: firstDeviationIndex,
          percentageDoorRoute: ((firstDeviationIndex / routeResult.geometry.length) * 100).toFixed(1) + "%",
          rdCoordinaten: firstDeviationPoint,
        },
        diepstePuntTerInformatie: {
          omschrijving: "Punt met de grootste afwijking -- laat zien HOE ERG de omweg is, maar is NIET de gat-locatie (het is het verste punt van een reeds-afgedwaalde route).",
          indexInRoute: deepestPointIndex,
          percentageDoorRoute: ((deepestPointIndex / routeResult.geometry.length) * 100).toFixed(1) + "%",
          rdCoordinaten: deepestPoint,
          loodrechteAfwijkingM: Math.round(maxDeviation),
        },
        totalRoutePoints: routeResult.geometry.length,
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
