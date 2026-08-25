import { NextRequest, NextResponse } from "next/server";

/**
 * Phase 1C — empirische validatie-suite.
 *
 * Voert alle Phase 1C data-analyses in één route uit tegen een steekproef
 * uit Routedatabank (fietsknooppunten_vrij + fietsnetwerken_vrij, zelfde bbox,
 * beide al in EPSG:28992). Puur diagnostisch — retourneert samenvattingen,
 * geen ruwe featuredata-export.
 *
 * Query params:
 *   key      — DEBUG_SECRET
 *   bbox     — "minx,miny,maxx,maxy" in EPSG:28992 (default: klein gebied Utrecht)
 *   sample   — max features per laag (default 500, cap 2000)
 *   tests    — comma-separated subset: tolerance,direction,fieldProfile,composite
 *              (default: alle)
 */

type Node = { objectid: string; knooppuntnr: string; regio: string; soort: string; x: number; y: number };
type EdgeFull = {
  objectid: string;
  rijrichting: string;
  lengte_m: number;
  regio: string;
  provincie: string;
  coords: [number, number][];
};

function extractField(block: string, field: string): string | null {
  const m = new RegExp(`<routedatabank:${field}>([^<]*)</routedatabank:${field}>`).exec(block);
  return m ? m[1] : null;
}

function parseNodes(xml: string): Node[] {
  const nodes: Node[] = [];
  const memberRegex = /<routedatabank:fietsknooppunten_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsknooppunten_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const posMatch = /<gml:pos>([^<]*)<\/gml:pos>/.exec(block);
    if (posMatch) {
      const [x, y] = posMatch[1].trim().split(/\s+/).map(Number);
      nodes.push({
        objectid: extractField(block, "objectid") || "",
        knooppuntnr: extractField(block, "knooppuntnr") || "",
        regio: extractField(block, "regio") || "",
        soort: extractField(block, "soort_knooppunt") || "",
        x,
        y,
      });
    }
  }
  return nodes;
}

function parseEdgesFull(xml: string): EdgeFull[] {
  const edges: EdgeFull[] = [];
  const memberRegex = /<routedatabank:fietsnetwerken_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsnetwerken_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const posListMatch = /<gml:posList>([^<]*)<\/gml:posList>/.exec(block);
    if (posListMatch) {
      const flat = posListMatch[1].trim().split(/\s+/).map(Number);
      const coords: [number, number][] = [];
      for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
      edges.push({
        objectid: extractField(block, "objectid") || "",
        rijrichting: extractField(block, "rijrichting") || "",
        lengte_m: parseFloat(extractField(block, "lengte_m") || "0"),
        regio: extractField(block, "regio") || "",
        provincie: extractField(block, "provincie") || "",
        coords,
      });
    }
  }
  return edges;
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2);
}

function pointInBbox(point: [number, number], bbox: [number, number, number, number]): boolean {
  const [minx, miny, maxx, maxy] = bbox;
  return point[0] >= minx && point[0] <= maxx && point[1] >= miny && point[1] <= maxy;
}

function nearestNode(point: [number, number], nodes: Node[]): { node: Node; d: number } | null {
  let best: { node: Node; d: number } | null = null;
  for (const n of nodes) {
    const d = dist(point, [n.x, n.y]);
    if (!best || d < best.d) best = { node: n, d };
  }
  return best;
}

// ---- Test 1: matchtolerantie ----
function runToleranceTest(nodes: Node[], edges: EdgeFull[], bbox: [number, number, number, number]) {
  const margin = 200;
  const innerBbox: [number, number, number, number] = [
    bbox[0] + margin,
    bbox[1] + margin,
    bbox[2] - margin,
    bbox[3] - margin,
  ];
  const distances: number[] = [];
  let excluded = 0;
  for (const e of edges) {
    const start = e.coords[0];
    const end = e.coords[e.coords.length - 1];
    for (const point of [start, end]) {
      if (pointInBbox(point, innerBbox)) {
        const nearest = nearestNode(point, nodes);
        if (nearest) distances.push(nearest.d);
      } else {
        excluded++;
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
  return {
    endpointsAnalyzed: distances.length,
    endpointsExcludedAsBoundaryClipping: excluded,
    distanceStats: distances.length
      ? {
          min: distances[0].toFixed(2),
          max: distances[distances.length - 1].toFixed(2),
          median: distances[Math.floor(distances.length / 2)].toFixed(2),
          p90: distances[Math.floor(distances.length * 0.9)].toFixed(2),
          p99: distances[Math.floor(distances.length * 0.99)].toFixed(2),
        }
      : null,
    withinThreshold,
  };
}

// ---- Test 2: rijrichting duplicate-hypothese + lengte-correlatie ----
function geometryDistanceReversed(a: [number, number][], b: [number, number][]): number {
  if (a.length === 0 || b.length === 0) return Infinity;
  const rev = [...a].reverse();
  const startD = dist(rev[0], b[0]);
  const endD = dist(rev[rev.length - 1], b[b.length - 1]);
  const midD = dist(rev[Math.floor(rev.length / 2)], b[Math.floor(b.length / 2)]);
  return Math.max(startD, endD, midD);
}

function runDirectionTests(edges: EdgeFull[]) {
  const MATCH_TOLERANCE_M = 10;
  const byRijrichting: Record<string, EdgeFull[]> = {};
  for (const e of edges) {
    (byRijrichting[e.rijrichting] ||= []).push(e);
  }

  const rijrichting2 = byRijrichting["2"] || [];
  const others = edges.filter((e) => e.rijrichting !== "2");
  let matched = 0;
  const exceptions: string[] = [];
  for (const e of rijrichting2) {
    let found = false;
    for (const other of others) {
      if (geometryDistanceReversed(e.coords, other.coords) < MATCH_TOLERANCE_M) {
        found = true;
        break;
      }
    }
    if (found) matched++;
    else exceptions.push(e.objectid);
  }

  const stats = (arr: EdgeFull[]) => {
    if (arr.length === 0) return null;
    const lengths = arr.map((e) => e.lengte_m).sort((a, b) => a - b);
    const sum = lengths.reduce((a, b) => a + b, 0);
    const regioCounts: Record<string, number> = {};
    for (const e of arr) regioCounts[e.regio] = (regioCounts[e.regio] || 0) + 1;
    return {
      count: arr.length,
      avgLength: (sum / arr.length).toFixed(1),
      medianLength: lengths[Math.floor(lengths.length / 2)].toFixed(1),
      minLength: lengths[0].toFixed(1),
      maxLength: lengths[lengths.length - 1].toFixed(1),
      topRegios: Object.entries(regioCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5),
    };
  };

  return {
    duplicateHypothesisTest: {
      rijrichting2EdgeCount: rijrichting2.length,
      matchedWithReverseCounterpart: matched,
      matchRatePercent: rijrichting2.length ? ((matched / rijrichting2.length) * 100).toFixed(1) : "n/a",
      exceptionsSample: exceptions.slice(0, 10),
    },
    lengthCorrelationByRijrichting: {
      "0": stats(byRijrichting["0"] || []),
      "1": stats(byRijrichting["1"] || []),
      "2": stats(byRijrichting["2"] || []),
    },
  };
}

// ---- Test 3: veldprofilering ----
function profileField(values: string[]) {
  const nonEmpty = values.filter((v) => v !== "" && v !== null);
  const nullPercent = ((values.length - nonEmpty.length) / values.length) * 100;
  const freq: Record<string, number> = {};
  for (const v of nonEmpty) freq[v] = (freq[v] || 0) + 1;
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]);
  return {
    totalCount: values.length,
    nullOrEmptyPercent: nullPercent.toFixed(1),
    uniqueValueCount: sorted.length,
    topValues: sorted.slice(0, 15).map(([v, c]) => ({ value: v, count: c })),
  };
}

function runFieldProfile(nodes: Node[], edges: EdgeFull[]) {
  return {
    nodes: {
      knooppuntnr: profileField(nodes.map((n) => n.knooppuntnr)),
      soort_knooppunt: profileField(nodes.map((n) => n.soort)),
    },
    edges: {
      rijrichting: profileField(edges.map((e) => e.rijrichting)),
      regio: profileField(edges.map((e) => e.regio)),
      provincie: profileField(edges.map((e) => e.provincie)),
      lengte_m: {
        min: Math.min(...edges.map((e) => e.lengte_m)).toFixed(1),
        max: Math.max(...edges.map((e) => e.lengte_m)).toFixed(1),
        avg: (edges.reduce((a, e) => a + e.lengte_m, 0) / edges.length).toFixed(1),
      },
    },
  };
}

// ---- Test 4: samengesteld-knooppunt geometrie + edge-aansluiting ----
function runCompositeNodeAnalysis(nodes: Node[], edges: EdgeFull[]) {
  const byKey: Record<string, Node[]> = {};
  for (const n of nodes) {
    const key = `${n.regio}::${n.knooppuntnr}`;
    (byKey[key] ||= []).push(n);
  }

  const composites = Object.entries(byKey).filter(([, arr]) => arr.length > 1);

  const EDGE_ATTACH_TOLERANCE_M = 10;

  const analysis = composites.slice(0, 30).map(([key, physicalPoints]) => {
    const [regio, knooppuntnr] = key.split("::");
    let maxPairwise = 0;
    let sumPairwise = 0;
    let pairCount = 0;
    for (let i = 0; i < physicalPoints.length; i++) {
      for (let j = i + 1; j < physicalPoints.length; j++) {
        const d = dist([physicalPoints[i].x, physicalPoints[i].y], [physicalPoints[j].x, physicalPoints[j].y]);
        maxPairwise = Math.max(maxPairwise, d);
        sumPairwise += d;
        pairCount++;
      }
    }
    const avgPairwise = pairCount ? sumPairwise / pairCount : 0;

    // Edge-aansluiting per fysiek punt: hoeveel edge-eindpunten liggen dicht
    // genoeg bij dit specifieke fysieke punt (i.p.v. bij de andere fysieke
    // punten van hetzelfde knooppuntnummer)?
    const edgesPerPhysicalPoint = physicalPoints.map((p) => {
      let count = 0;
      for (const e of edges) {
        const start = e.coords[0];
        const end = e.coords[e.coords.length - 1];
        if (dist(start, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M || dist(end, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M) {
          count++;
        }
      }
      return { objectid: p.objectid, soort: p.soort, edgeCount: count };
    });

    let category: string;
    if (maxPairwise < 5) category = "< 5m: waarschijnlijk één fysieke locatie";
    else if (maxPairwise < 25) category = "5-25m: mogelijk meerdere aansluitpunten";
    else if (maxPairwise < 100) category = "25-100m: nader onderzoeken";
    else category = "> 100m: waarschijnlijk bewust verschillende locaties";

    return {
      regio,
      knooppuntnr,
      physicalPointCount: physicalPoints.length,
      maxPairwiseDistanceM: maxPairwise.toFixed(1),
      avgPairwiseDistanceM: avgPairwise.toFixed(1),
      category,
      edgesPerPhysicalPoint,
      allPointsHaveEdges: edgesPerPhysicalPoint.every((p) => p.edgeCount > 0),
    };
  });

  const categoryCounts: Record<string, number> = {};
  for (const a of analysis) categoryCounts[a.category] = (categoryCounts[a.category] || 0) + 1;

  return {
    totalCompositeKnooppuntnrs: composites.length,
    analyzedSample: analysis.length,
    categoryCounts,
    allPointsHaveEdgesCount: analysis.filter((a) => a.allPointsHaveEdges).length,
    someIsolatedPhysicalPointsCount: analysis.filter((a) => !a.allPointsHaveEdges).length,
    details: analysis,
  };
}

// ---- Test 5: threshold sensitivity + topologische validatie (pure ruimtelijke clustering) ----

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function clusterAtThreshold(nodes: Node[], thresholdM: number): number[][] {
  const uf = new UnionFind(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (dist([nodes[i].x, nodes[i].y], [nodes[j].x, nodes[j].y]) <= thresholdM) {
        uf.union(i, j);
      }
    }
  }
  const groups: Record<number, number[]> = {};
  for (let i = 0; i < nodes.length; i++) {
    const root = uf.find(i);
    (groups[root] ||= []).push(i);
  }
  return Object.values(groups);
}

function clusterDiameter(indices: number[], nodes: Node[]): number {
  let max = 0;
  for (let i = 0; i < indices.length; i++) {
    for (let j = i + 1; j < indices.length; j++) {
      const d = dist(
        [nodes[indices[i]].x, nodes[indices[i]].y],
        [nodes[indices[j]].x, nodes[indices[j]].y]
      );
      max = Math.max(max, d);
    }
  }
  return max;
}

function runThresholdSensitivity(nodes: Node[], edges: EdgeFull[]) {
  const thresholds = [10, 25, 50, 75, 100, 125, 150];
  const EDGE_ATTACH_TOLERANCE_M = 10;

  const results = thresholds.map((t) => {
    const clusters = clusterAtThreshold(nodes, t);
    const multiClusters = clusters.filter((c) => c.length > 1);
    const mergedRecordCount = multiClusters.reduce((sum, c) => sum + c.length, 0);
    const diameters = multiClusters.map((c) => clusterDiameter(c, nodes));
    const largestCluster = multiClusters.reduce((max, c) => Math.max(max, c.length), 0);

    // Attribuut-conflict: cluster waarin niet alle punten dezelfde (regio, knooppuntnr) delen.
    let regioConflicts = 0;
    let knooppuntnrConflicts = 0;
    for (const c of multiClusters) {
      const regios = new Set(c.map((i) => nodes[i].regio));
      const nrs = new Set(c.map((i) => nodes[i].knooppuntnr));
      if (regios.size > 1) regioConflicts++;
      if (nrs.size > 1) knooppuntnrConflicts++;
    }

    // Topologische conflict-indicator: cluster waarin de aangesloten edges van de
    // verschillende fysieke punten naar totaal andere gebieden lopen (mogelijk
    // twee onafhankelijke lokale netwerken die toevallig dicht bij elkaar liggen).
    let topologyConflicts = 0;
    for (const c of multiClusters) {
      if (c.length < 2) continue;
      const edgeRegiosPerPoint = c.map((i) => {
        const p = nodes[i];
        const regios = new Set<string>();
        for (const e of edges) {
          const start = e.coords[0];
          const end = e.coords[e.coords.length - 1];
          if (dist(start, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M || dist(end, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M) {
            regios.add(e.regio);
          }
        }
        return regios;
      });
      // Conflict als de fysieke punten edges hebben met totaal disjuncte regio-sets
      // (geen enkele gedeelde regio tussen de aangesloten edges van de verschillende punten).
      const allRegios = edgeRegiosPerPoint.map((s) => Array.from(s));
      let anyDisjoint = false;
      for (let i = 0; i < allRegios.length; i++) {
        for (let j = i + 1; j < allRegios.length; j++) {
          const a = allRegios[i];
          const b = allRegios[j];
          if (a.length && b.length && !a.some((r) => b.includes(r))) {
            anyDisjoint = true;
          }
        }
      }
      if (anyDisjoint) topologyConflicts++;
    }

    return {
      thresholdM: t,
      clusterCount: multiClusters.length,
      mergedRecordCount,
      largestClusterSize: largestCluster,
      avgClusterDiameterM: diameters.length ? (diameters.reduce((a, b) => a + b, 0) / diameters.length).toFixed(1) : "0",
      maxClusterDiameterM: diameters.length ? Math.max(...diameters).toFixed(1) : "0",
      regioAttributeConflicts: regioConflicts,
      knooppuntnrAttributeConflicts: knooppuntnrConflicts,
      topologyConflicts,
    };
  });

  return {
    note: "Attribuut-conflicten (regio/knooppuntnr) bij een cluster betekenen: ruimtelijk dicht bij elkaar, maar delen NIET dezelfde brondata-identiteit — mogelijk toeval, nader te bekijken. Topologie-conflicten: aangesloten edges van de verschillende fysieke punten wijzen naar totaal andere regio's — sterk signaal tegen samenvoegen.",
    perThreshold: results,
  };
}

function runConflictDetail(nodes: Node[], edges: EdgeFull[], thresholdM: number) {
  const EDGE_ATTACH_TOLERANCE_M = 10;
  const clusters = clusterAtThreshold(nodes, thresholdM);
  const multiClusters = clusters.filter((c) => c.length > 1);

  const details = multiClusters
    .map((c) => {
      const points = c.map((i) => nodes[i]);
      const regios = new Set(points.map((p) => p.regio));
      const nrs = new Set(points.map((p) => p.knooppuntnr));

      const edgeRegiosPerPoint = points.map((p) => {
        const regiosForPoint = new Set<string>();
        const attachedEdges: string[] = [];
        for (const e of edges) {
          const start = e.coords[0];
          const end = e.coords[e.coords.length - 1];
          if (dist(start, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M || dist(end, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M) {
            regiosForPoint.add(e.regio);
            attachedEdges.push(e.objectid);
          }
        }
        return { point: p, regios: Array.from(regiosForPoint), attachedEdges };
      });

      const allRegioSets = edgeRegiosPerPoint.map((e) => e.regios);
      let topologyConflict = false;
      for (let i = 0; i < allRegioSets.length; i++) {
        for (let j = i + 1; j < allRegioSets.length; j++) {
          const a = allRegioSets[i];
          const b = allRegioSets[j];
          if (a.length && b.length && !a.some((r) => b.includes(r))) topologyConflict = true;
        }
      }

      const hasConflict = regios.size > 1 || nrs.size > 1 || topologyConflict;
      if (!hasConflict) return null;

      return {
        clusterSize: c.length,
        diameterM: clusterDiameter(c, nodes).toFixed(1),
        regioConflict: regios.size > 1,
        knooppuntnrConflict: nrs.size > 1,
        topologyConflict,
        points: edgeRegiosPerPoint.map((e) => ({
          objectid: e.point.objectid,
          knooppuntnr: e.point.knooppuntnr,
          regio: e.point.regio,
          soort: e.point.soort,
          attachedEdgeRegios: e.regios,
          attachedEdgeCount: e.attachedEdges.length,
        })),
      };
    })
    .filter((d) => d !== null);

  return { thresholdM, conflictingClusterCount: details.length, details };
}

// ---- Test 6: semantische merge-classificatie (soort_knooppunt als primair signaal) ----

type ClusterClassification =
  | "enkelvoudig_only"        // alle punten Enkelvoudig — GEEN automatische merge-kandidaat
  | "samengesteld_only"        // alle punten Samengesteld_aan/uit — sterke merge-kandidaat
  | "mixed";                   // combinatie van Enkelvoudig en Samengesteld — apart beoordelen

function classifyCluster(points: Node[]): ClusterClassification {
  const soorten = new Set(points.map((p) => (p.soort.startsWith("Samengesteld") ? "samengesteld" : "enkelvoudig")));
  if (soorten.size === 1) {
    return soorten.has("samengesteld") ? "samengesteld_only" : "enkelvoudig_only";
  }
  return "mixed";
}

function runSemanticMergeAnalysis(nodes: Node[], edges: EdgeFull[], thresholdM: number) {
  const EDGE_ATTACH_TOLERANCE_M = 10;
  const clusters = clusterAtThreshold(nodes, thresholdM).filter((c) => c.length > 1);

  const classified = clusters.map((c) => {
    const points = c.map((i) => nodes[i]);
    const classification = classifyCluster(points);
    const regios = new Set(points.map((p) => p.regio));
    const nrs = new Set(points.map((p) => p.knooppuntnr));

    // Cluster ALS GEHEEL beoordeeld (niet paarsgewijs): verzamel alle regio's die
    // via aangesloten edges bij dit cluster horen. Een "brugpunt" dat naar twee
    // regio's leidt, telt niet als conflict zolang het cluster als geheel een
    // samenhangend netwerk vormt (elke regio wordt door minstens één punt gedeeld
    // met een ander punt in het cluster).
    const edgeRegiosPerPoint = points.map((p) => {
      const regiosForPoint = new Set<string>();
      for (const e of edges) {
        const start = e.coords[0];
        const end = e.coords[e.coords.length - 1];
        if (dist(start, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M || dist(end, [p.x, p.y]) < EDGE_ATTACH_TOLERANCE_M) {
          regiosForPoint.add(e.regio);
        }
      }
      return regiosForPoint;
    });
    const allEdgeRegios = new Set<string>();
    edgeRegiosPerPoint.forEach((s) => s.forEach((r) => allEdgeRegios.add(r)));
    // Samenhangend: elk punt deelt minstens één regio met de vereniging van de rest
    // (eenvoudige proxy — geen volledige graaftheorie nodig voor deze diagnose).
    const isCoherentNetwork = edgeRegiosPerPoint.every((s) => Array.from(s).some((r) => allEdgeRegios.has(r)));

    return {
      diameterM: clusterDiameter(c, nodes).toFixed(1),
      size: c.length,
      classification,
      regioCount: regios.size,
      knooppuntnrCount: nrs.size,
      involvedRegios: Array.from(allEdgeRegios),
      isCoherentNetwork,
      recommendedAction:
        classification === "enkelvoudig_only"
          ? "standaard NIET samenvoegen (Enkelvoudig-only cluster)"
          : classification === "samengesteld_only"
          ? isCoherentNetwork
            ? "samenvoegen (Samengesteld-only, samenhangend netwerk)"
            : "nader onderzoeken (Samengesteld-only, maar netwerk lijkt niet samenhangend)"
          : "handmatig beoordelen (gemengd Enkelvoudig/Samengesteld in één cluster)",
    };
  });

  const summary = {
    totalClusters: classified.length,
    enkelvoudigOnlyClusters: classified.filter((c) => c.classification === "enkelvoudig_only").length,
    samengesteldOnlyClusters: classified.filter((c) => c.classification === "samengesteld_only").length,
    mixedClusters: classified.filter((c) => c.classification === "mixed").length,
  };

  return {
    thresholdM,
    summary,
    note:
      "enkelvoudig_only-clusters zijn de kritieke test: als dit aantal hoog is, betekent dat dat 'Enkelvoudig' als brondata-signaal NIET betrouwbaar 'nooit samenvoegen' garandeert, en moet de regel worden bijgesteld. Mixed-clusters zijn per definitie handmatige beoordelingsgevallen.",
    enkelvoudigOnlyDetails: classified.filter((c) => c.classification === "enkelvoudig_only"),
    mixedDetails: classified.filter((c) => c.classification === "mixed"),
  };
}

// ---- Test 7: rijrichting semantiek — parallelle-edge-detectie ----
// Test niet "omgekeerde duplicaat" (dat is al verworpen), maar: heeft een
// 1/2-edge vaak een NABIJE, GELIJKGERICHTE (niet omgekeerde) tweelingedge?
// Dat zou duiden op een gescheiden pad per rijrichting (twee aparte lijnstukken
// voor bijv. een dijk met een baan per richting), in plaats van een simpele
// eenrichtingsbeperking op één gedeeld pad.

function resample(coords: [number, number][], n: number): [number, number][] {
  if (coords.length === 1) return Array(n).fill(coords[0]);
  // Cumulatieve lengte langs de lijn, dan n punten op gelijke afstand interpoleren.
  const cum: number[] = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
  }
  const total = cum[cum.length - 1] || 1;
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const target = (k / (n - 1)) * total;
    let idx = cum.findIndex((c) => c >= target);
    if (idx <= 0) idx = 1;
    const segStart = cum[idx - 1];
    const segEnd = cum[idx];
    const t = segEnd > segStart ? (target - segStart) / (segEnd - segStart) : 0;
    const p0 = coords[idx - 1];
    const p1 = coords[idx];
    out.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]);
  }
  return out;
}

function avgPointwiseDistance(a: [number, number][], b: [number, number][]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += dist(a[i], b[i]);
  return sum / a.length;
}

function runParallelEdgeAnalysis(edges: EdgeFull[]) {
  const MAX_EDGES_FOR_QUADRATIC_TEST = 600;
  const truncated = edges.length > MAX_EDGES_FOR_QUADRATIC_TEST;
  const workingSet = truncated ? edges.slice(0, MAX_EDGES_FOR_QUADRATIC_TEST) : edges;

  const RESAMPLE_N = 8;
  const PARALLEL_TOLERANCE_M = 15;
  const resampled = workingSet.map((e) => resample(e.coords, RESAMPLE_N));

  function hasParallelTwin(i: number): boolean {
    const a = resampled[i];
    const aRev = [...a].reverse();
    for (let j = 0; j < workingSet.length; j++) {
      if (j === i) continue;
      const b = resampled[j];
      const forwardDist = avgPointwiseDistance(a, b);
      const reverseDist = avgPointwiseDistance(aRev, b);
      if (forwardDist < PARALLEL_TOLERANCE_M && reverseDist > PARALLEL_TOLERANCE_M) {
        return true;
      }
    }
    return false;
  }

  const byRijrichting: Record<string, { total: number; withTwin: number }> = {};
  for (let i = 0; i < workingSet.length; i++) {
    const rr = workingSet[i].rijrichting;
    byRijrichting[rr] ||= { total: 0, withTwin: 0 };
    byRijrichting[rr].total++;
    if (hasParallelTwin(i)) byRijrichting[rr].withTwin++;
  }

  const summary: Record<string, string> = {};
  for (const [rr, stats] of Object.entries(byRijrichting)) {
    summary[rr] = `${stats.withTwin}/${stats.total} (${((stats.withTwin / stats.total) * 100).toFixed(1)}%)`;
  }

  return {
    note:
      "Percentage edges per rijrichting-waarde met een nabije, gelijkgerichte (niet-omgekeerde) tweelingedge binnen 15m. Als rijrichting=1/2 systematisch vaker een tweeling heeft dan rijrichting=0, wijst dat op gescheiden banen per richting i.p.v. een simpele eenrichtingsbeperking op een gedeeld pad.",
    truncatedForPerformance: truncated,
    edgesAnalyzed: workingSet.length,
    parallelTwinPercentageByRijrichting: summary,
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

  const bboxStr = req.nextUrl.searchParams.get("bbox") || "140000,465000,155000,475000";
  const bbox = bboxStr.split(",").map(Number) as [number, number, number, number];
  const sampleSize = Math.min(parseInt(req.nextUrl.searchParams.get("sample") || "500", 10), 2000);
  const requestedTests = (req.nextUrl.searchParams.get("tests") || "tolerance,direction,fieldProfile,composite,thresholdSensitivity").split(",");

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
      bbox: `${bboxStr},urn:ogc:def:crs:EPSG::28992`,
      count: String(sampleSize),
    });
    const res = await fetch(`${baseUrl}?${params.toString()}`, { headers: commonHeaders, cache: "no-store" });
    if (!res.ok) throw new Error(`${typeName} gaf status ${res.status}`);
    return res.text();
  }

  try {
    const [nodesXml, edgesXml] = await Promise.all([
      fetchLayer("routedatabank:fietsknooppunten_vrij"),
      fetchLayer("routedatabank:fietsnetwerken_vrij"),
    ]);

    const nodes = parseNodes(nodesXml);
    const edges = parseEdgesFull(edgesXml);

    const result: Record<string, unknown> = {
      sample: { bbox: bboxStr, nodesFetched: nodes.length, edgesFetched: edges.length },
    };

    if (requestedTests.includes("tolerance")) {
      result.toleranceTest = runToleranceTest(nodes, edges, bbox);
    }
    if (requestedTests.includes("direction")) {
      result.directionTests = runDirectionTests(edges);
    }
    if (requestedTests.includes("fieldProfile")) {
      result.fieldProfile = runFieldProfile(nodes, edges);
    }
    if (requestedTests.includes("composite")) {
      result.compositeNodeAnalysis = runCompositeNodeAnalysis(nodes, edges);
    }
    if (requestedTests.includes("thresholdSensitivity")) {
      result.thresholdSensitivity = runThresholdSensitivity(nodes, edges);
    }
    if (requestedTests.includes("conflictDetail")) {
      const conflictThreshold = parseInt(req.nextUrl.searchParams.get("conflictThreshold") || "50", 10);
      result.conflictDetail = runConflictDetail(nodes, edges, conflictThreshold);
    }
    if (requestedTests.includes("semanticMerge")) {
      const semanticThreshold = parseInt(req.nextUrl.searchParams.get("conflictThreshold") || "50", 10);
      result.semanticMergeAnalysis = runSemanticMergeAnalysis(nodes, edges, semanticThreshold);
    }
    if (requestedTests.includes("parallelEdge")) {
      result.parallelEdgeAnalysis = runParallelEdgeAnalysis(edges);
    }

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Analyse mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
