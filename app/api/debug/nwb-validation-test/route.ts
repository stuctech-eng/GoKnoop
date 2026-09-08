import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { fetchAllNwbSegmentsInBbox } from "@/lib/nwb-analysis/nwb-client";
import { classifySegment } from "@/lib/nwb-analysis/classify";
import { analyzeNwbGraph } from "@/lib/nwb-analysis/graph-analysis";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/nwb-validation-test?region=hilversum|lochem|volendam&datasetVersionId=...
 *
 * TIJDELIJKE, puur lezende validatietest (8-9-2026). GEEN productiecode
 * gewijzigd, GEEN Bridge Layer geactiveerd, GEEN wijziging aan
 * isTraversable() of de bestaande graph.
 *
 * HERZIEN 8-9-2026: haalt nu ALLE wegvakken in de bbox op (ongefilterd,
 * standaard bbox-parameter -- zie nwb-client.ts voor waarom CQL_FILTER is
 * losgelaten) en classificeert client-side naar Set A/B (classify.ts).
 * Rapporteert ook de ruwe bstCode-verdeling als sanity-check: als die
 * gevarieerd is (niet 1 dominant getal, en verschillend per regio), weten
 * we zeker dat de data nu wél regio-specifiek en betrouwbaar is.
 */

const REGIONS: Record<string, { label: string; latMin: number; latMax: number; lonMin: number; lonMax: number }> = {
  // TOEGEVOEGD 8-9-2026: gebieden verkleind t.o.v. de eerste versie -- die
  // waren te groot (>3000 wegvakken, dus afgekapt bij 3 paginas), wat de
  // component-analyse onbetrouwbaar onderschat (een segment lijkt "geïsoleerd"
  // als zijn buursegment toevallig niet is opgehaald, niet omdat het écht
  // geïsoleerd is). Nu gericht op de daadwerkelijke corridor/kern, klein
  // genoeg om volledig (niet-afgekapt) op te halen.
  hilversum: { label: "Amsterdam-Zuidoost -> Hilversum (smalle corridor)", latMin: 52.3, latMax: 52.36, lonMin: 5.0, lonMax: 5.18 },
  lochem: { label: "Lochem-kern + directe omgeving", latMin: 52.13, latMax: 52.18, lonMin: 6.38, lonMax: 6.46 },
  volendam: { label: "Volendam / Edam (kern)", latMin: 52.47, latMax: 52.51, lonMin: 4.98, lonMax: 5.06 },
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

    const { segments: allSegments, pagesRetrieved, truncated, debugFirstFeatureKeys } = await fetchAllNwbSegmentsInBbox(bbox, 4);

    // Sanity-check: verdeling van ruwe bstCode-waarden -- als dit gevarieerd
    // is (niet gedomineerd door 1 vaste waarde), bevestigt dat de data nu
    // echt uit deze regio komt, niet een generieke standaardset.
    const bstCodeDistribution: Record<string, number> = {};
    for (const s of allSegments) {
      const code = s.bstCode ?? "(leeg)";
      bstCodeDistribution[code] = (bstCodeDistribution[code] || 0) + 1;
    }

    const setASegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) === "setA");
    const setBSegments = allSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded"); // setA + setB samen

    const setAComponents = Object.fromEntries(SNAP_TOLERANCES_M.map((t) => [`${t}m`, analyzeNwbGraph(setASegments, t)]));
    const setBComponents = Object.fromEntries(SNAP_TOLERANCES_M.map((t) => [`${t}m`, analyzeNwbGraph(setBSegments, t)]));

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

    const nwbEndpoints = setBSegments.flatMap((s) =>
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
      ruweData: {
        segmentenOpgehaald: allSegments.length,
        paginasOpgehaald: pagesRetrieved,
        truncated,
        bstCodeVerdeling: bstCodeDistribution,
        debugFirstFeatureKeys,
      },
      setA: {
        omschrijving: "BST_CODE = FP (fietspad, conservatief)",
        segmentCount: setASegments.length,
        components: setAComponents,
      },
      setB: {
        omschrijving: "FP + HR + RB, min. autosnelwegen/busbanen (ruim)",
        segmentCount: setBSegments.length,
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
