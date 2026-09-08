import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { fetchNwbSegments } from "@/lib/nwb-analysis/nwb-client";
import { SET_A_BST_CODES, SET_B_BST_CODES } from "@/lib/nwb-analysis/classify";
import { analyzeNwbGraph } from "@/lib/nwb-analysis/graph-analysis";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/nwb-validation-test?region=hilversum|lochem|volendam&datasetVersionId=...
 *
 * TIJDELIJKE, puur lezende validatietest (8-9-2026, "GoKnoop -- NWB
 * ruimtelijke validatietest"). GEEN productiecode gewijzigd, GEEN Bridge
 * Layer geactiveerd, GEEN wijziging aan isTraversable() of de bestaande
 * graph. Eén regio per aanroep, om ruim binnen de Vercel-10s-limiet te
 * blijven -- Fase 1 van de gevraagde test: NWB-connectiviteit + koppeling
 * aan bestaande GoKnoop-knooppunten. De daadwerkelijke gecombineerde-graaf-
 * routetest (sectie 7-9 van de opdracht) is een logische vervolgstap, hier
 * bewust nog niet gebouwd totdat Fase 1 laat zien of dat de moeite waard is.
 */

const REGIONS: Record<string, { label: string; latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
  hilversum: { label: "Amsterdam Centraal -> Hilversum-corridor", latMin: 52.28, latMax: 52.4, lonMin: 4.9, lonMax: 5.2 },
  lochem: { label: "Lochem / Achterhoek", latMin: 52.1, latMax: 52.2, lonMin: 6.35, lonMax: 6.5 },
  volendam: { label: "Volendam / Edam / Purmerend", latMin: 52.44, latMax: 52.53, lonMin: 4.92, lonMax: 5.1 },
};

const SNAP_TOLERANCES_M = [5, 10, 20];
const GOKNOOP_PROXIMITY_TOLERANCES_M = [10, 20, 50];

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const regionKey = req.nextUrl.searchParams.get("region");
  const region = regionKey ? REGIONS[regionKey] : undefined;
  if (!region) {
    return NextResponse.json({ error: `region-parameter verplicht, één van: ${Object.keys(REGIONS).join(", ")}` }, { status: 400 });
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId-parameter verplicht." }, { status: 400 });
  }

  try {
    const corners = [
      wgs84ToRd(region.latMin, region.lonMin),
      wgs84ToRd(region.latMin, region.lonMax),
      wgs84ToRd(region.latMax, region.lonMin),
      wgs84ToRd(region.latMax, region.lonMax),
    ];
    const bbox = {
      minX: Math.min(...corners.map((c) => c.x)),
      maxX: Math.max(...corners.map((c) => c.x)),
      minY: Math.min(...corners.map((c) => c.y)),
      maxY: Math.max(...corners.map((c) => c.y)),
    };

    // NWB Set A en Set B parallel ophalen.
    const [setAResult, setBResult] = await Promise.all([
      fetchNwbSegments(bbox, SET_A_BST_CODES, 5000),
      fetchNwbSegments(bbox, SET_B_BST_CODES, 5000),
    ]);

    // Component-analyse bij 3 tolerantieniveaus, voor beide sets.
    const setAComponents = Object.fromEntries(SNAP_TOLERANCES_M.map((t) => [`${t}m`, analyzeNwbGraph(setAResult.segments, t)]));
    const setBComponents = Object.fromEntries(SNAP_TOLERANCES_M.map((t) => [`${t}m`, analyzeNwbGraph(setBResult.segments, t)]));

    // Bestaande GoKnoop logicalNodes binnen dezelfde bbox laden.
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    const allNodeIds = provider.getAllNodeIds();
    const goknoopNodesInRegion: { id: string; displayNumber: string; x: number; y: number; edgeCount: number }[] = [];
    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      if (n.x >= bbox.minX && n.x <= bbox.maxX && n.y >= bbox.minY && n.y <= bbox.maxY) {
        goknoopNodesInRegion.push({ id, displayNumber: n.displayNumber ?? "?", x: n.x, y: n.y, edgeCount: provider.getEdgesFrom(id).length });
      }
    }

    // Koppeling: voor elke tolerantie, hoeveel GoKnoop-knopen liggen binnen die
    // afstand van TEN MINSTE ÉÉN NWB Set B-segment-eindpunt (Set B is de ruimere,
    // dus een superset van wat Set A zou opleveren).
    const nwbEndpoints = setBResult.segments.flatMap((s) =>
      s.coordinates.length >= 2 ? [s.coordinates[0], s.coordinates[s.coordinates.length - 1]] : []
    );
    const proximityResults: Record<string, number> = {};
    for (const tol of GOKNOOP_PROXIMITY_TOLERANCES_M) {
      let count = 0;
      for (const gn of goknoopNodesInRegion) {
        const near = nwbEndpoints.some((p) => Math.hypot(p.x - gn.x, p.y - gn.y) <= tol);
        if (near) count++;
      }
      proximityResults[`${tol}m`] = count;
    }

    return NextResponse.json({
      region: regionKey,
      label: region.label,
      bboxRD: bbox,
      nwbBron: {
        dienst: "PDOK NWB-Wegen WFS (service.pdok.nl/rws/nwbwegen)",
        licentie: "CC0 (rechtstreeks bevestigd via WFS AccessConstraints, 8-9-2026)",
        typeName: "nwbwegen:wegvakken",
      },
      setA: {
        bstCodes: SET_A_BST_CODES,
        segmentenOpgehaald: setAResult.segments.length,
        numberMatched: setAResult.numberMatched,
        truncated: setAResult.truncated,
        debugCqlFilter: setAResult.debugCqlFilter,
        debugFirstFeatureKeys: setAResult.debugFirstFeatureKeys,
        components: setAComponents,
      },
      setB: {
        bstCodes: SET_B_BST_CODES,
        segmentenOpgehaald: setBResult.segments.length,
        numberMatched: setBResult.numberMatched,
        truncated: setBResult.truncated,
        debugCqlFilter: setBResult.debugCqlFilter,
        debugFirstFeatureKeys: setBResult.debugFirstFeatureKeys,
        components: setBComponents,
      },
      goknoop: {
        knopenInRegio: goknoopNodesInRegion.length,
        geisoleerdeKnopenInRegio: goknoopNodesInRegion.filter((n) => n.edgeCount === 0).length,
        proximityTotNwbSetB: proximityResults,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Validatietest mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
