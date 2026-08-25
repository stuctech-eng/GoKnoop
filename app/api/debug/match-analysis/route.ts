import { NextRequest, NextResponse } from "next/server";

/**
 * Phase 1C, stap 1: matchtolerantie-steekproef.
 *
 * Haalt een steekproef nodes (fietsknooppunten_vrij) en edges (fietsnetwerken_vrij)
 * op uit hetzelfde geografische gebied (bbox, beide lagen al in EPSG:28992 —
 * geen CRS-conversie nodig), en berekent voor elk edge-eindpunt de afstand tot
 * de dichtstbijzijnde node. Retourneert een statistische samenvatting, geen
 * ruwe featuredata — dit is een eenmalig diagnose-hulpmiddel, geen dataset-export.
 *
 * Beveiligd met dezelfde DEBUG_SECRET als de andere debug-routes.
 */

function parseNodes(xml: string) {
  const nodes: { knooppuntnr: string; soort: string; x: number; y: number }[] = [];
  const memberRegex = /<routedatabank:fietsknooppunten_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsknooppunten_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const nrMatch = /<routedatabank:knooppuntnr>([^<]*)<\/routedatabank:knooppuntnr>/.exec(block);
    const soortMatch = /<routedatabank:soort_knooppunt>([^<]*)<\/routedatabank:soort_knooppunt>/.exec(block);
    const posMatch = /<gml:pos>([^<]*)<\/gml:pos>/.exec(block);
    if (posMatch) {
      const [x, y] = posMatch[1].trim().split(/\s+/).map(Number);
      nodes.push({
        knooppuntnr: nrMatch ? nrMatch[1] : "",
        soort: soortMatch ? soortMatch[1] : "",
        x,
        y,
      });
    }
  }
  return nodes;
}

function parseEdges(xml: string) {
  const edges: { rijrichting: string; lengte_m: number; start: [number, number]; end: [number, number] }[] = [];
  const memberRegex = /<routedatabank:fietsnetwerken_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsnetwerken_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const rrMatch = /<routedatabank:rijrichting>([^<]*)<\/routedatabank:rijrichting>/.exec(block);
    const lenMatch = /<routedatabank:lengte_m>([^<]*)<\/routedatabank:lengte_m>/.exec(block);
    const posListMatch = /<gml:posList>([^<]*)<\/gml:posList>/.exec(block);
    if (posListMatch) {
      const coords = posListMatch[1].trim().split(/\s+/).map(Number);
      if (coords.length >= 4) {
        const start: [number, number] = [coords[0], coords[1]];
        const end: [number, number] = [coords[coords.length - 2], coords[coords.length - 1]];
        edges.push({
          rijrichting: rrMatch ? rrMatch[1] : "",
          lengte_m: lenMatch ? parseFloat(lenMatch[1]) : 0,
          start,
          end,
        });
      }
    }
  }
  return edges;
}

function pointInBbox(point: [number, number], bbox: [number, number, number, number]): boolean {
  const [minx, miny, maxx, maxy] = bbox;
  return point[0] >= minx && point[0] <= maxx && point[1] >= miny && point[1] <= maxy;
}

function nearestDistance(point: [number, number], nodes: { x: number; y: number }[]): number {
  let best = Infinity;
  for (const n of nodes) {
    const dx = n.x - point[0];
    const dy = n.y - point[1];
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < best) best = d;
  }
  return best;
}

function reverseCoords(coords: [number, number][]): [number, number][] {
  return [...coords].reverse();
}

function geometryDistance(a: [number, number][], b: [number, number][]): number {
  // Vergelijkt twee lijnen puntsgewijs (na eventueel omkeren) op basis van
  // start- en eindpunt-afstand plus een steekproef van tussenpunten.
  // Geen volledige Hausdorff-afstand nodig voor deze diagnose — start/eind/midden volstaat.
  if (a.length === 0 || b.length === 0) return Infinity;
  const distAt = (p1: [number, number], p2: [number, number]) =>
    Math.sqrt((p1[0] - p2[0]) ** 2 + (p1[1] - p2[1]) ** 2);
  const startDist = distAt(a[0], b[0]);
  const endDist = distAt(a[a.length - 1], b[b.length - 1]);
  const midA = a[Math.floor(a.length / 2)];
  const midB = b[Math.floor(b.length / 2)];
  const midDist = distAt(midA, midB);
  return Math.max(startDist, endDist, midDist);
}

function parseEdgesFull(xml: string) {
  const edges: {
    objectid: string;
    rijrichting: string;
    lengte_m: number;
    regio: string;
    coords: [number, number][];
  }[] = [];
  const memberRegex = /<routedatabank:fietsnetwerken_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsnetwerken_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const idMatch = /<routedatabank:objectid>([^<]*)<\/routedatabank:objectid>/.exec(block);
    const rrMatch = /<routedatabank:rijrichting>([^<]*)<\/routedatabank:rijrichting>/.exec(block);
    const lenMatch = /<routedatabank:lengte_m>([^<]*)<\/routedatabank:lengte_m>/.exec(block);
    const regioMatch = /<routedatabank:regio>([^<]*)<\/routedatabank:regio>/.exec(block);
    const posListMatch = /<gml:posList>([^<]*)<\/gml:posList>/.exec(block);
    if (posListMatch) {
      const flat = posListMatch[1].trim().split(/\s+/).map(Number);
      const coords: [number, number][] = [];
      for (let i = 0; i < flat.length; i += 2) {
        coords.push([flat[i], flat[i + 1]]);
      }
      edges.push({
        objectid: idMatch ? idMatch[1] : "",
        rijrichting: rrMatch ? rrMatch[1] : "",
        lengte_m: lenMatch ? parseFloat(lenMatch[1]) : 0,
        regio: regioMatch ? regioMatch[1] : "",
        coords,
      });
    }
  }
  return edges;
}

function runDirectionValidation(edgesFull: ReturnType<typeof parseEdgesFull>) {
  const MATCH_TOLERANCE_M = 10; // start/eind/midden mogen tot 10m verschillen
  const rijrichting2Edges = edgesFull.filter((e) => e.rijrichting === "2");
  const others = edgesFull.filter((e) => e.rijrichting !== "2");

  const results: {
    objectid: string;
    matched: boolean;
    counterpartObjectid?: string;
    counterpartRijrichting?: string;
    geometryDistance?: string;
    lengthDiff?: string;
  }[] = [];

  for (const edge of rijrichting2Edges) {
    const reversed = reverseCoords(edge.coords);
    let best: { other: (typeof others)[number]; dist: number } | null = null;
    for (const other of others) {
      const dist = geometryDistance(reversed, other.coords);
      if (dist < MATCH_TOLERANCE_M && (!best || dist < best.dist)) {
        best = { other, dist };
      }
    }
    if (best) {
      results.push({
        objectid: edge.objectid,
        matched: true,
        counterpartObjectid: best.other.objectid,
        counterpartRijrichting: best.other.rijrichting,
        geometryDistance: best.dist.toFixed(2),
        lengthDiff: Math.abs(edge.lengte_m - best.other.lengte_m).toFixed(1),
      });
    } else {
      results.push({ objectid: edge.objectid, matched: false });
    }
  }

  const matchedCount = results.filter((r) => r.matched).length;
  const matchRate = rijrichting2Edges.length > 0 ? (matchedCount / rijrichting2Edges.length) * 100 : null;

  return {
    rijrichting2EdgeCount: rijrichting2Edges.length,
    matchedWithReverseCounterpart: matchedCount,
    noCounterpartFound: rijrichting2Edges.length - matchedCount,
    matchRatePercent: matchRate !== null ? matchRate.toFixed(1) : "n/a (geen rijrichting=2 edges in steekproef)",
    counterpartRijrichtingWaarden: results
      .filter((r) => r.matched)
      .reduce((acc: Record<string, number>, r) => {
        const key = r.counterpartRijrichting || "?";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    exceptions: results.filter((r) => !r.matched).map((r) => r.objectid),
    exampleMatches: results.filter((r) => r.matched).slice(0, 5),
  };
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const baseUrl = process.env.ROUTEDATABANK_URL;
  const user = process.env.ROUTEDATABANK_USER;
  const pass = process.env.ROUTEDATABANK_PASS;
  if (!baseUrl || !user || !pass) {
    return NextResponse.json({ error: "Ontbrekende Routedatabank env vars." }, { status: 500 });
  }

  const bbox = req.nextUrl.searchParams.get("bbox") || "140000,465000,155000,475000";
  const sampleSize = Math.min(parseInt(req.nextUrl.searchParams.get("sample") || "500", 10), 2000);
  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const commonHeaders = {
    Authorization: authHeader,
    "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app; QGIS-compatible WFS client)",
    Referer: "https://go-knoop.vercel.app/",
  };

  async function fetchLayer(typeName: string) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName,
      bbox: `${bbox},urn:ogc:def:crs:EPSG::28992`,
      count: String(sampleSize),
    });
    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: commonHeaders,
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`${typeName} gaf status ${res.status}`);
    }
    return res.text();
  }

  try {
    const [nodesXml, edgesXml] = await Promise.all([
      fetchLayer("routedatabank:fietsknooppunten_vrij"),
      fetchLayer("routedatabank:fietsnetwerken_vrij"),
    ]);

    const nodes = parseNodes(nodesXml);
    const edges = parseEdges(edgesXml);

    const bboxParts = bbox.split(",").map(Number) as [number, number, number, number];
    // Kleine marge naar binnen, zodat we punten heel dicht bij de rand ook uitsluiten
    // (die kunnen alsnog een node net buiten de opgehaalde node-bbox hebben).
    const margin = 200; // meter
    const innerBbox: [number, number, number, number] = [
      bboxParts[0] + margin,
      bboxParts[1] + margin,
      bboxParts[2] - margin,
      bboxParts[3] - margin,
    ];

    const distances: number[] = [];
    let excludedAsEdgeClipping = 0;
    for (const edge of edges) {
      for (const point of [edge.start, edge.end]) {
        if (pointInBbox(point, innerBbox)) {
          distances.push(nearestDistance(point, nodes));
        } else {
          excludedAsEdgeClipping++;
        }
      }
    }
    distances.sort((a, b) => a - b);

    const thresholds = [2, 5, 10, 15, 20, 30, 50];
    const withinThreshold: Record<string, string> = {};
    for (const t of thresholds) {
      const count = distances.filter((d) => d <= t).length;
      withinThreshold[`within_${t}m`] = `${count}/${distances.length} (${((count / distances.length) * 100).toFixed(1)}%)`;
    }

    const rijrichtingCounts: Record<string, number> = {};
    for (const e of edges) {
      rijrichtingCounts[e.rijrichting] = (rijrichtingCounts[e.rijrichting] || 0) + 1;
    }

    const soortCounts: Record<string, number> = {};
    for (const n of nodes) {
      soortCounts[n.soort] = (soortCounts[n.soort] || 0) + 1;
    }

    const knooppuntnrCounts: Record<string, number> = {};
    for (const n of nodes) {
      knooppuntnrCounts[n.knooppuntnr] = (knooppuntnrCounts[n.knooppuntnr] || 0) + 1;
    }
    const duplicateKnooppuntnrs = Object.entries(knooppuntnrCounts).filter(([, c]) => c > 1);

    const edgesFull = parseEdgesFull(edgesXml);
    const directionValidation = runDirectionValidation(edgesFull);

    return NextResponse.json({
      sample: {
        bbox,
        nodesFetched: nodes.length,
        edgesFetched: edges.length,
        endpointsAnalyzed: distances.length,
        endpointsExcludedAsBoundaryClipping: excludedAsEdgeClipping,
      },
      distanceStats: {
        min: distances[0]?.toFixed(2),
        max: distances[distances.length - 1]?.toFixed(2),
        median: distances[Math.floor(distances.length / 2)]?.toFixed(2),
        p90: distances[Math.floor(distances.length * 0.9)]?.toFixed(2),
        p99: distances[Math.floor(distances.length * 0.99)]?.toFixed(2),
      },
      withinThreshold,
      rijrichtingWaarden: rijrichtingCounts,
      soortKnooppuntWaarden: soortCounts,
      knooppuntnrsMetMeerdereRecords: duplicateKnooppuntnrs.length,
      voorbeeldDuplicateKnooppuntnrs: duplicateKnooppuntnrs.slice(0, 10).map(([nr, count]) => ({ nr, count })),
      directionSemanticsValidation: directionValidation,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Analyse mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
