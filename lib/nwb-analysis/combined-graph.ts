/**
 * Gecombineerde-graafopbouw + Dijkstra -- TIJDELIJK, uitsluitend voor de
 * beslissende validatietest (8-9-2026). Volledig los van de productie
 * route-engine (lib/route-engine/) -- andere node-ID-ruimte (NWB-clusters
 * krijgen synthetische ID's), geen enkele overlap met productiecode.
 */

import type { GraphProvider } from "../route-engine/types";
import { classifySegment } from "./classify";

/**
 * TOEGEVOEGD 8-9-2026, ná een daadwerkelijke 413 FUNCTION_PAYLOAD_TOO_LARGE:
 * de volledige, gedetailleerde NWB-geometrie (soms tientallen punten per
 * segment) was te veel data voor één POST-aanvraag bij ~16.000 segmenten.
 * Deze graafopbouw heeft die volledige vorm niet nodig -- alleen de twee
 * eindpunten (voor het aan-elkaar-knopen) en de ECHTE lengte (voor de juiste
 * afstand in Dijkstra, vooraf berekend uit de volledige geometrie vóórdat
 * die geometrie zelf wordt weggelaten). Client-side (de orkestratiepagina)
 * zet de volledige NwbSegment hiernaar om vlak vóór het versturen.
 */
export type SlimNwbSegment = {
  id: string;
  bstCode: string | null;
  wegnummer: string | null;
  straatnaam: string | null;
  from: { x: number; y: number };
  to: { x: number; y: number };
  lengthM: number;
  /** TOEGEVOEGD 11-9-2026, Fase M6/M7 (vooraf-berekende clustering): als
   * beide gevuld zijn, slaat buildBaseGraph de dure union-find-clustering
   * voor dit punt over en gebruikt deze waarden direct. Optioneel -- data
   * zonder deze velden werkt nog steeds, via de bestaande, langzamere
   * live-clustering (onderzoeks-/testpagina's, of nog niet gemigreerde
   * datasets). */
  fromClusterId?: string;
  toClusterId?: string;
};

export type CombinedEdgeSource = "goknoop" | "nwb" | "connector";

export type CombinedEdge = {
  to: string;
  distanceM: number;
  source: CombinedEdgeSource;
  /** Voor sanity-checks: NWB bstCode/straatnaam indien van toepassing. */
  nwbInfo?: { bstCode: string | null; straatnaam: string | null; wegnummer: string | null; segmentId: string };
};

export type CombinedGraph = {
  adjacency: Map<string, CombinedEdge[]>;
  nodePosition: Map<string, { x: number; y: number; source: "goknoop" | "nwb" }>;
  /** TOEGEVOEGD 8-9-2026: totaal aantal connector-edges dat daadwerkelijk in
   * de graaf is aangemaakt (niet per se allemaal gebruikt door Dijkstra) --
   * onderscheidt "er ontstonden helemaal geen connectors" (dekkingsprobleem)
   * van "connectors bestaan, maar geen ervan levert een kortere route op"
   * (een legitieme, andere uitkomst). */
  totalConnectorsCreated: number;
};

export class UnionFind {
  private parent = new Map<string, string>();
  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) return id;
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/**
 * TOEGEVOEGD 11-9-2026, Fase M6/M7 (vooraf-berekende clustering, structurele
 * fix voor de resterende 10s-bottleneck). Losstaande versie van precies de
 * clustering-logica uit `buildBaseGraph` -- puur voor het EENMALIG,
 * vooraf berekenen van cluster-toewijzingen per segment, bedoeld om te
 * draaien als aparte admin-actie ná migratie (niet bij elke aanvraag).
 * Retourneert een Map<segmentId, {fromClusterId, toClusterId}> die daarna
 * direct in de NWB-segmentopslag geschreven kan worden.
 */
export async function computeNwbClusterAssignments(
  segments: SlimNwbSegment[],
  toleranceM: number,
  onProgress?: (label: string, extra?: Record<string, unknown>) => void
): Promise<Map<string, { fromClusterId: string; toClusterId: string }>> {
  const tBase = Date.now();
  const log = (label: string, extra?: Record<string, unknown>) => {
    onProgress?.(label, { elapsedMs: Date.now() - tBase, ...extra });
  };

  const setBSegments = segments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded");
  log("Set B-classificatie klaar", { setBSegments: setBSegments.length, totaal: segments.length });

  const uf = new UnionFind();
  const pointKey = (segId: string, end: "from" | "to") => `${segId}:${end}`;
  type RawPoint = { key: string; x: number; y: number; cx: number; cy: number };
  const rawPoints: RawPoint[] = [];
  for (const seg of setBSegments) {
    uf.add(pointKey(seg.id, "from"));
    uf.add(pointKey(seg.id, "to"));
    rawPoints.push({ key: pointKey(seg.id, "from"), x: seg.from.x, y: seg.from.y, cx: Math.floor(seg.from.x / toleranceM), cy: Math.floor(seg.from.y / toleranceM) });
    rawPoints.push({ key: pointKey(seg.id, "to"), x: seg.to.x, y: seg.to.y, cx: Math.floor(seg.to.x / toleranceM), cy: Math.floor(seg.to.y / toleranceM) });
  }
  log("Punten verzameld", { puntenAantal: rawPoints.length });

  const grid = new Map<string, RawPoint[]>();
  const cellKey = (cx: number, cy: number) => cx * 1000003 + cy;
  for (const p of rawPoints) {
    const cell = cellKey(p.cx, p.cy);
    let bucket = grid.get(String(cell));
    if (!bucket) {
      bucket = [];
      grid.set(String(cell), bucket);
    }
    bucket.push(p);
  }
  log("Grid gebouwd", { celAantal: grid.size });

  const YIELD_EVERY_N_POINTS = 5000;
  for (let idx = 0; idx < rawPoints.length; idx++) {
    const p = rawPoints[idx];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const candidates = grid.get(String(cellKey(p.cx + dx, p.cy + dy)));
        if (!candidates) continue;
        for (const q of candidates) {
          if (p === q) continue;
          if (uf.find(p.key) === uf.find(q.key)) continue;
          if (Math.hypot(p.x - q.x, p.y - q.y) <= toleranceM) uf.union(p.key, q.key);
        }
      }
    }
    if (idx > 0 && idx % YIELD_EVERY_N_POINTS === 0) {
      log("clustering voortgang", { verwerkt: idx, totaal: rawPoints.length });
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  log("Union-find-clustering klaar");

  const result = new Map<string, { fromClusterId: string; toClusterId: string }>();
  // KORTE ID's i.p.v. de ruwe pointKey-strings (die zijn ~50 tekens lang, want
  // ze bevatten het volledige NWB-segment-ID + ":from"/":to"). Performance-audit,
  // 12-9-2026: cluster-ID's namen 23,96% van de totale NWB-opslag in beslag
  // (10,91MB van 45,54MB) -- puur door de labellengte, niet door aantal.
  // Korte, opeenvolgende integer-strings ("0", "1", "2", ...) veranderen de
  // GROEPERING niet (elke unieke root krijgt gewoon een kortere naam) --
  // alleen de weergavevorm, geen inhoudelijke wijziging.
  const shortIdByRoot = new Map<string, string>();
  function shortIdFor(root: string): string {
    let id = shortIdByRoot.get(root);
    if (id === undefined) {
      id = String(shortIdByRoot.size);
      shortIdByRoot.set(root, id);
    }
    return id;
  }
  for (const seg of setBSegments) {
    result.set(seg.id, {
      fromClusterId: shortIdFor(uf.find(pointKey(seg.id, "from"))),
      toClusterId: shortIdFor(uf.find(pointKey(seg.id, "to"))),
    });
  }
  log("Clustertoewijzingen klaar", { aantalSegmenten: result.size, aantalUniekeClusters: shortIdByRoot.size });

  return result;
}

/**
 * Gedeelde opbouw voor stap 1-3 (GoKnoop-graaf + NWB-graaf + clustering) --
 * uitgesplitst zodat zowel de oorspronkelijke buildCombinedGraph (blinde
 * nabijheids-connectors, onderzoeksfase) als de nieuwe
 * buildValidatedCombinedGraph (Fase 4, echte gevalideerde connectors)
 * dezelfde, al-geteste snap-logica hergebruiken zonder duplicatie.
 */
async function buildBaseGraph(
  provider: GraphProvider,
  nwbSegments: SlimNwbSegment[],
  toleranceM: number,
  onProgress?: (label: string, extra?: Record<string, unknown>) => void
): Promise<{
  adjacency: Map<string, CombinedEdge[]>;
  nodePosition: Map<string, { x: number; y: number; source: "goknoop" | "nwb" }>;
  addEdge: (from: string, to: string, edge: CombinedEdge) => void;
  findNwbClusterNodeId: (segId: string, end: "from" | "to") => string;
  clusterList: { id: string; x: number; y: number }[];
}> {
  // TOEGEVOEGD 10-9-2026, Fase M6/M7-diagnose: voortgang per stap, via een
  // OPTIONELE, GEÏNJECTEERDE callback -- NIET via een directe Firestore-
  // afhankelijkheid hier. `combined-graph.ts` wordt ook door client-side
  // debugpagina's gebruikt (bijv. app/debug/fase4-combined-topology) -- een
  // (zelfs dynamische) import van `firebase-admin` hier brak de client-
  // build (webpack: "Module not found: Can't resolve 'net'", via
  // @grpc/grpc-js, een Node-only afhankelijkheid van firebase-admin).
  // De server-only aanroeper (cached-nwb-provider.ts) injecteert desgewenst
  // een Firestore-schrijvende callback; hier blijft dit bestand volledig
  // omgevingsagnostisch.
  const tBase = Date.now();
  const log = (label: string, extra?: Record<string, unknown>) => {
    console.log(`[buildBaseGraph] ${label}: ${Date.now() - tBase}ms`);
    onProgress?.(`buildBaseGraph: ${label}`, { elapsedMs: Date.now() - tBase, ...extra });
  };
  log("start");

  const adjacency = new Map<string, CombinedEdge[]>();
  const nodePosition = new Map<string, { x: number; y: number; source: "goknoop" | "nwb" }>();

  function addEdge(from: string, to: string, edge: CombinedEdge) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(edge);
  }

  const allNodeIds = provider.getAllNodeIds();
  for (const id of allNodeIds) {
    const n = provider.getNode(id);
    if (!n) continue;
    nodePosition.set(id, { x: n.x, y: n.y, source: "goknoop" });
    for (const e of provider.getEdgesFrom(id)) {
      const otherEnd = e.fromLogicalNodeId === id ? e.toLogicalNodeId : e.fromLogicalNodeId;
      addEdge(id, otherEnd, { to: otherEnd, distanceM: e.distanceM, source: "goknoop" });
    }
  }
  log("GoKnoop-basisgraaf klaar", { nodeCount: allNodeIds.length });

  const setBSegments = nwbSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded");
  log("Set B-classificatie klaar", { setBSegments: setBSegments.length, totaal: nwbSegments.length });

  const pointKey = (segId: string, end: "from" | "to") => `${segId}:${end}`;

  // TOEGEVOEGD 11-9-2026, Fase M6/M7 (structurele fix): als ALLE segmenten al
  // vooraf-berekende cluster-ID's hebben (via de nieuwe precompute-stap,
  // draait als eenmalige, aparte admin-actie na migratie), slaan we de hele
  // dure union-find-clustering over -- live gemeten: ~229k punten kostte
  // ~3,6s puur rekenwerk, DE bottleneck die overbleef na alle I/O-fixes.
  // Zonder vooraf-berekende data (onderzoekspagina's, testdata, een nog niet
  // geprecomputede dataset) blijft de bestaande, langzamere live-clustering
  // gewoon werken -- puur additief, geen bestaand gedrag gewijzigd.
  const allPrecomputed = setBSegments.length > 0 && setBSegments.every((s) => s.fromClusterId && s.toClusterId);
  log(allPrecomputed ? "Vooraf-berekende clusters gevonden -- clustering overgeslagen" : "Geen (volledig) vooraf-berekende clusters -- live clustering", {
    aantalMetPrecomputed: setBSegments.filter((s) => s.fromClusterId && s.toClusterId).length,
    totaal: setBSegments.length,
  });

  let resolveCluster: (segId: string, end: "from" | "to") => string;
  const clusterRepresentative = new Map<string, { x: number; y: number }>();

  if (allPrecomputed) {
    const clusterIdByPointKey = new Map<string, string>();
    for (const seg of setBSegments) {
      clusterIdByPointKey.set(pointKey(seg.id, "from"), seg.fromClusterId!);
      clusterIdByPointKey.set(pointKey(seg.id, "to"), seg.toClusterId!);
      if (!clusterRepresentative.has(seg.fromClusterId!)) clusterRepresentative.set(seg.fromClusterId!, { x: seg.from.x, y: seg.from.y });
      if (!clusterRepresentative.has(seg.toClusterId!)) clusterRepresentative.set(seg.toClusterId!, { x: seg.to.x, y: seg.to.y });
    }
    resolveCluster = (segId, end) => {
      const found = clusterIdByPointKey.get(pointKey(segId, end));
      if (found === undefined) {
        throw new Error(`Vooraf-berekende clustering: geen clusterId gevonden voor segment '${segId}' (${end}) -- dit zou niet moeten gebeuren als alle segmenten precomputed zijn. Mogelijk een inconsistentie tussen de gebruikte segmentenset en de eerder berekende toewijzingen.`);
      }
      return found;
    };
    for (const [root, pos] of clusterRepresentative) nodePosition.set(`nwb:${root}`, { x: pos.x, y: pos.y, source: "nwb" });
    log("Vooraf-berekende clusters toegepast", { clusterAantal: clusterRepresentative.size });
  } else {
    const uf = new UnionFind();
    type RawPoint = { key: string; x: number; y: number; cx: number; cy: number };
    const rawPoints: RawPoint[] = [];
    for (const seg of setBSegments) {
      uf.add(pointKey(seg.id, "from"));
      uf.add(pointKey(seg.id, "to"));
      rawPoints.push({ key: pointKey(seg.id, "from"), x: seg.from.x, y: seg.from.y, cx: Math.floor(seg.from.x / toleranceM), cy: Math.floor(seg.from.y / toleranceM) });
      rawPoints.push({ key: pointKey(seg.id, "to"), x: seg.to.x, y: seg.to.y, cx: Math.floor(seg.to.x / toleranceM), cy: Math.floor(seg.to.y / toleranceM) });
    }
    log("Punten verzameld", { puntenAantal: rawPoints.length });

    const grid = new Map<string, RawPoint[]>();
    const cellKey = (cx: number, cy: number) => cx * 1000003 + cy;
    for (const p of rawPoints) {
      const cell = cellKey(p.cx, p.cy);
      let bucket = grid.get(String(cell));
      if (!bucket) {
        bucket = [];
        grid.set(String(cell), bucket);
      }
      bucket.push(p);
    }
    log("Grid gebouwd", { celAantal: grid.size });

    const YIELD_EVERY_N_POINTS = 5000;
    for (let idx = 0; idx < rawPoints.length; idx++) {
      const p = rawPoints[idx];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const candidates = grid.get(String(cellKey(p.cx + dx, p.cy + dy)));
          if (!candidates) continue;
          for (const q of candidates) {
            if (p === q) continue;
            if (uf.find(p.key) === uf.find(q.key)) continue;
            if (Math.hypot(p.x - q.x, p.y - q.y) <= toleranceM) uf.union(p.key, q.key);
          }
        }
      }
      if (idx > 0 && idx % YIELD_EVERY_N_POINTS === 0) {
        log("clustering voortgang", { verwerkt: idx, totaal: rawPoints.length });
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
    log("Union-find-clustering klaar");

    resolveCluster = (segId, end) => uf.find(pointKey(segId, end));
    for (const p of rawPoints) {
      const root = uf.find(p.key);
      if (!clusterRepresentative.has(root)) {
        clusterRepresentative.set(root, { x: p.x, y: p.y });
        nodePosition.set(`nwb:${root}`, { x: p.x, y: p.y, source: "nwb" });
      }
    }
    log("Clusterrepresentanten bepaald", { clusterAantal: clusterRepresentative.size });
  }

  for (const seg of setBSegments) {
    const fromRoot = `nwb:${resolveCluster(seg.id, "from")}`;
    const toRoot = `nwb:${resolveCluster(seg.id, "to")}`;
    if (fromRoot === toRoot) continue;
    const len = seg.lengthM;
    const info = { bstCode: seg.bstCode, straatnaam: seg.straatnaam, wegnummer: seg.wegnummer, segmentId: seg.id };
    addEdge(fromRoot, toRoot, { to: toRoot, distanceM: len, source: "nwb", nwbInfo: info });
    addEdge(toRoot, fromRoot, { to: fromRoot, distanceM: len, source: "nwb", nwbInfo: info });
  }
  log("NWB-edges toegevoegd -- buildBaseGraph volledig klaar");

  return {
    adjacency,
    nodePosition,
    addEdge,
    findNwbClusterNodeId: (segId, end) => `nwb:${resolveCluster(segId, end)}`,
    clusterList: Array.from(clusterRepresentative.entries()).map(([root, pos]) => ({ id: `nwb:${root}`, ...pos })),
  };
}

/**
 * Bouwt de gecombineerde graaf. `nwbSegments` moet al Set B-geclassificeerd
 * zijn (of ruwer -- deze functie classificeert zelf nogmaals ter
 * zekerheid). `connectorSearchBbox` beperkt de dure GoKnoop<->NWB-
 * nabijheidscontrole tot een relevant gebied (i.p.v. alle 11.003 landelijke
 * knopen te vergelijken) -- puur een efficiëntiemaatregel, geen inhoudelijke
 * beperking (de volledige GoKnoop-graaf blijft wel altijd meedoen voor
 * Dijkstra zelf).
 */
export async function buildCombinedGraph(
  provider: GraphProvider,
  nwbSegments: SlimNwbSegment[],
  toleranceM: number,
  connectorSearchBbox: { minX: number; minY: number; maxX: number; maxY: number },
  onProgress?: (label: string, extra?: Record<string, unknown>) => void
): Promise<CombinedGraph> {
  const { adjacency, nodePosition, addEdge, clusterList } = await buildBaseGraph(provider, nwbSegments, toleranceM, onProgress);

  const allNodeIds = provider.getAllNodeIds();
  let connectorCount = 0;
  for (const id of allNodeIds) {
    const n = provider.getNode(id);
    if (!n) continue;
    if (n.x < connectorSearchBbox.minX || n.x > connectorSearchBbox.maxX || n.y < connectorSearchBbox.minY || n.y > connectorSearchBbox.maxY) continue;
    for (const cluster of clusterList) {
      const d = Math.hypot(n.x - cluster.x, n.y - cluster.y);
      if (d <= toleranceM) {
        addEdge(id, cluster.id, { to: cluster.id, distanceM: d, source: "connector" });
        addEdge(cluster.id, id, { to: id, distanceM: d, source: "connector" });
        connectorCount++;
      }
    }
  }

  return { adjacency, nodePosition, totalConnectorsCreated: connectorCount };
}

/**
 * TOEGEVOEGD 9-9-2026, Fase 4: bouwt de gecombineerde graaf met de reeds
 * GEVALIDEERDE connectorlaag (connector-candidates.ts) in plaats van blinde
 * nabijheid. Alleen niet-afgewezen kandidaten (high/lower) worden als
 * daadwerkelijke connector-edge toegevoegd -- elke edge draagt zijn
 * confidence-niveau mee voor latere rapportage.
 */
export type ValidatedConnectorInput = {
  goknoopNodeId: string;
  nwbSegmentId: string;
  nwbEndpoint: "from" | "to";
  distanceM: number;
  confidence: "high" | "lower";
};

export type ValidatedCombinedGraph = CombinedGraph & {
  connectorsUsed: { high: number; lower: number };
};

export async function buildValidatedCombinedGraph(
  provider: GraphProvider,
  nwbSegments: SlimNwbSegment[],
  toleranceM: number,
  validatedConnectors: ValidatedConnectorInput[],
  onProgress?: (label: string, extra?: Record<string, unknown>) => void
): Promise<ValidatedCombinedGraph> {
  const { adjacency, nodePosition, addEdge, findNwbClusterNodeId } = await buildBaseGraph(provider, nwbSegments, toleranceM, onProgress);

  let highCount = 0;
  let lowerCount = 0;
  for (const c of validatedConnectors) {
    const nwbNodeId = findNwbClusterNodeId(c.nwbSegmentId, c.nwbEndpoint);
    if (!nodePosition.has(nwbNodeId)) continue; // NWB-segment viel buiten Set B na classificatie -- veilig overslaan
    addEdge(c.goknoopNodeId, nwbNodeId, { to: nwbNodeId, distanceM: c.distanceM, source: "connector" });
    addEdge(nwbNodeId, c.goknoopNodeId, { to: c.goknoopNodeId, distanceM: c.distanceM, source: "connector" });
    if (c.confidence === "high") highCount++;
    else lowerCount++;
  }

  return { adjacency, nodePosition, totalConnectorsCreated: highCount + lowerCount, connectorsUsed: { high: highCount, lower: lowerCount } };
}

export type DijkstraStep = { nodeId: string; edgeSource: CombinedEdgeSource | "start"; distanceM: number; nwbInfo?: CombinedEdge["nwbInfo"] };

export type CombinedComponentStats = {
  totalNodes: number;
  componentCount: number;
  largestComponentSize: number;
  largestComponentPercent: number;
  componentOfNode: Map<string, string>; // node-ID -> component-root-ID, handig om specifieke knopen op te zoeken
};

/**
 * TOEGEVOEGD 9-9-2026, Fase 4: telt connected components op de VOLLEDIGE
 * gecombineerde graaf (GoKnoop + NWB + connectors samen) -- in tegenstelling
 * tot graph-analysis.ts's analyzeSlimNwbGraph (die uitsluitend NWB-interne
 * connectiviteit meet), dit gebruikt de daadwerkelijke adjacency-lijst van
 * de CombinedGraph, dus edges van elk type (goknoop/nwb/connector) tellen mee.
 */
export function computeConnectedComponents(graph: CombinedGraph): CombinedComponentStats {
  const uf = new UnionFind();
  for (const nodeId of graph.nodePosition.keys()) uf.add(nodeId);
  for (const [from, edges] of graph.adjacency.entries()) {
    for (const edge of edges) {
      uf.union(from, edge.to);
    }
  }

  const componentOfNode = new Map<string, string>();
  const sizeByRoot = new Map<string, number>();
  for (const nodeId of graph.nodePosition.keys()) {
    const root = uf.find(nodeId);
    componentOfNode.set(nodeId, root);
    sizeByRoot.set(root, (sizeByRoot.get(root) || 0) + 1);
  }

  const totalNodes = graph.nodePosition.size;
  const largestComponentSize = Math.max(0, ...Array.from(sizeByRoot.values()));

  return {
    totalNodes,
    componentCount: sizeByRoot.size,
    largestComponentSize,
    largestComponentPercent: totalNodes > 0 ? (largestComponentSize / totalNodes) * 100 : 0,
    componentOfNode,
  };
}

export type DijkstraResult =
  | {
      found: true;
      distanceM: number;
      steps: DijkstraStep[];
      goknoopEdgeCount: number;
      nwbEdgeCount: number;
      connectorCount: number;
    }
  | { found: false };

/**
 * Simpele binary min-heap, uitsluitend voor deze Dijkstra-implementatie.
 *
 * TOEGEVOEGD 8-9-2026, ná een daadwerkelijke Vercel-timeout op een graaf van
 * ~11.000 GoKnoop-knopen + ~33.000 NWB-punten: de eerdere aanpak
 * (`queue.sort()` bij elke stap) bleek in de praktijk te traag -- dat is
 * O(n log n) PER stap i.p.v. O(log n), een reëel prestatieprobleem bij deze
 * schaal, niet een toevallige hik. Niet gegokt op een snelheidsaanname,
 * hersteld op basis van het daadwerkelijke, waargenomen falen.
 */
class MinHeap {
  private heap: { id: string; d: number }[] = [];

  get size() {
    return this.heap.length;
  }

  push(item: { id: string; d: number }) {
    this.heap.push(item);
    let i = this.heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[parent].d <= this.heap[i].d) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  pop(): { id: string; d: number } | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = 2 * i + 2;
        let smallest = i;
        if (left < this.heap.length && this.heap[left].d < this.heap[smallest].d) smallest = left;
        if (right < this.heap.length && this.heap[right].d < this.heap[smallest].d) smallest = right;
        if (smallest === i) break;
        [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
        i = smallest;
      }
    }
    return top;
  }
}

/** Dijkstra op de gecombineerde graaf, met een echte binary heap (zie MinHeap hierboven). */
export function dijkstraOnCombinedGraph(graph: CombinedGraph, startId: string, endId: string): DijkstraResult {
  const dist = new Map<string, number>();
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, CombinedEdge>();
  const visited = new Set<string>();

  const queue = new MinHeap();
  queue.push({ id: startId, d: 0 });
  dist.set(startId, 0);

  while (queue.size > 0) {
    const current = queue.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.id === endId) break;

    const edges = graph.adjacency.get(current.id) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      const newDist = current.d + edge.distanceM;
      if (newDist < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, newDist);
        prevNode.set(edge.to, current.id);
        prevEdge.set(edge.to, edge);
        queue.push({ id: edge.to, d: newDist });
      }
    }
  }

  if (!dist.has(endId)) return { found: false };

  // Pad terugvolgen.
  const steps: DijkstraStep[] = [];
  let cur: string | undefined = endId;
  while (cur !== undefined) {
    const edge = prevEdge.get(cur);
    steps.unshift({ nodeId: cur, edgeSource: edge?.source ?? "start", distanceM: dist.get(cur)!, nwbInfo: edge?.nwbInfo });
    cur = prevNode.get(cur);
  }

  let goknoopEdgeCount = 0;
  let nwbEdgeCount = 0;
  let connectorCount = 0;
  for (const s of steps) {
    if (s.edgeSource === "goknoop") goknoopEdgeCount++;
    else if (s.edgeSource === "nwb") nwbEdgeCount++;
    else if (s.edgeSource === "connector") connectorCount++;
  }

  return { found: true, distanceM: dist.get(endId)!, steps, goknoopEdgeCount, nwbEdgeCount, connectorCount };
}

/**
 * TOEGEVOEGD 9-9-2026, Fase 5: kostenfunctie-fabriek. `fNwb`/`fConnector`
 * zijn multiplicatieve factoren op de WERKELIJKE afstand -- exact het
 * model dat in de architectuurreview is doorgerekend en bewezen begrensd
 * (D_g ≤ D_n × F). GEEN vooraf gekozen "standaardwaarde" hier -- de
 * aanroeper (het Fase 5-onderzoek) geeft expliciet de te testen waarden mee.
 */
export type CostFn = (edge: CombinedEdge) => number;

export function makeCostFn(fNwb: number, fConnector: number): CostFn {
  return (edge) => {
    if (edge.source === "nwb") return edge.distanceM * fNwb;
    if (edge.source === "connector") return edge.distanceM * fConnector;
    return edge.distanceM; // goknoop -- altijd de werkelijke afstand, nooit een factor
  };
}

export type CostAwareStep = { nodeId: string; edgeSource: CombinedEdgeSource | "start"; nwbSegmentId?: string };

export type CostAwareDijkstraResult =
  | {
      found: true;
      distanceM: number; // WERKELIJKE afstand van het gekozen pad (som van edge.distanceM, nooit vermenigvuldigd)
      costTotal: number; // de kosten die Dijkstra gebruikte om te kiezen (kan afwijken van distanceM)
      steps: CostAwareStep[];
      goknoopEdgeCount: number;
      nwbEdgeCount: number;
      connectorCount: number;
      goknoopDistanceM: number; // werkelijke afstand PER bron -- nodig voor "aandeel"-berekeningen
      nwbDistanceM: number;
      connectorDistanceM: number;
    }
  | { found: false };

/**
 * Kosten-bewuste Dijkstra. Kiest het pad met de LAAGSTE KOSTEN (via costFn),
 * maar rapporteert altijd de WERKELIJKE afstand van dat gekozen pad --
 * kosten en afstand worden nooit met elkaar verward, ook niet intern
 * (twee aparte accumulatoren, costSoFar voor de padkeuze, distSoFar voor
 * de rapportage van precies datzelfde pad).
 */
export function dijkstraWithCostModel(graph: CombinedGraph, startId: string, endId: string, costFn: CostFn): CostAwareDijkstraResult {
  const costSoFar = new Map<string, number>();
  const distSoFar = new Map<string, number>();
  const prevNode = new Map<string, string>();
  const prevEdge = new Map<string, CombinedEdge>();
  const visited = new Set<string>();

  const queue = new MinHeap();
  queue.push({ id: startId, d: 0 });
  costSoFar.set(startId, 0);
  distSoFar.set(startId, 0);

  while (queue.size > 0) {
    const current = queue.pop()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    if (current.id === endId) break;

    const edges = graph.adjacency.get(current.id) ?? [];
    for (const edge of edges) {
      if (visited.has(edge.to)) continue;
      const edgeCost = costFn(edge);
      const newCost = current.d + edgeCost;
      if (newCost < (costSoFar.get(edge.to) ?? Infinity)) {
        costSoFar.set(edge.to, newCost);
        distSoFar.set(edge.to, (distSoFar.get(current.id) ?? 0) + edge.distanceM);
        prevNode.set(edge.to, current.id);
        prevEdge.set(edge.to, edge);
        queue.push({ id: edge.to, d: newCost });
      }
    }
  }

  if (!costSoFar.has(endId)) return { found: false };

  const steps: CostAwareStep[] = [];
  let cur: string | undefined = endId;
  while (cur !== undefined) {
    const edge = prevEdge.get(cur);
    steps.unshift({ nodeId: cur, edgeSource: edge?.source ?? "start", nwbSegmentId: edge?.nwbInfo?.segmentId });
    cur = prevNode.get(cur);
  }

  let goknoopEdgeCount = 0;
  let nwbEdgeCount = 0;
  let connectorCount = 0;
  let goknoopDistanceM = 0;
  let nwbDistanceM = 0;
  let connectorDistanceM = 0;
  cur = endId;
  while (cur !== undefined) {
    const edge = prevEdge.get(cur);
    if (edge) {
      if (edge.source === "goknoop") {
        goknoopEdgeCount++;
        goknoopDistanceM += edge.distanceM;
      } else if (edge.source === "nwb") {
        nwbEdgeCount++;
        nwbDistanceM += edge.distanceM;
      } else if (edge.source === "connector") {
        connectorCount++;
        connectorDistanceM += edge.distanceM;
      }
    }
    cur = prevNode.get(cur);
  }

  return {
    found: true,
    distanceM: distSoFar.get(endId)!,
    costTotal: costSoFar.get(endId)!,
    steps,
    goknoopEdgeCount,
    nwbEdgeCount,
    connectorCount,
    goknoopDistanceM,
    nwbDistanceM,
    connectorDistanceM,
  };
}
