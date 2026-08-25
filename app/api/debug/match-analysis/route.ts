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
  const sampleSize = Math.min(parseInt(req.nextUrl.searchParams.get("sample") || "500", 10), 1000);
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

    const distances: number[] = [];
    for (const edge of edges) {
      distances.push(nearestDistance(edge.start, nodes));
      distances.push(nearestDistance(edge.end, nodes));
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

    return NextResponse.json({
      sample: {
        bbox,
        nodesFetched: nodes.length,
        edgesFetched: edges.length,
        endpointsAnalyzed: distances.length,
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
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Analyse mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
