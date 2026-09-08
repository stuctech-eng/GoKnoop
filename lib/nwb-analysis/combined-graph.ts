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
};

export type CombinedEdgeSource = "goknoop" | "nwb" | "connector";

export type CombinedEdge = {
  to: string;
  distanceM: number;
  source: CombinedEdgeSource;
  /** Voor sanity-checks: NWB bstCode/straatnaam indien van toepassing. */
  nwbInfo?: { bstCode: string | null; straatnaam: string | null; wegnummer: string | null };
};

export type CombinedGraph = {
  adjacency: Map<string, CombinedEdge[]>;
  nodePosition: Map<string, { x: number; y: number; source: "goknoop" | "nwb" }>;
};

class UnionFind {
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
 * Bouwt de gecombineerde graaf. `nwbSegments` moet al Set B-geclassificeerd
 * zijn (of ruwer -- deze functie classificeert zelf nogmaals ter
 * zekerheid). `connectorSearchBbox` beperkt de dure GoKnoop<->NWB-
 * nabijheidscontrole tot een relevant gebied (i.p.v. alle 11.003 landelijke
 * knopen te vergelijken) -- puur een efficiëntiemaatregel, geen inhoudelijke
 * beperking (de volledige GoKnoop-graaf blijft wel altijd meedoen voor
 * Dijkstra zelf).
 */
export function buildCombinedGraph(
  provider: GraphProvider,
  nwbSegments: SlimNwbSegment[],
  toleranceM: number,
  connectorSearchBbox: { minX: number; minY: number; maxX: number; maxY: number }
): CombinedGraph {
  const adjacency = new Map<string, CombinedEdge[]>();
  const nodePosition = new Map<string, { x: number; y: number; source: "goknoop" | "nwb" }>();

  function addEdge(from: string, to: string, edge: CombinedEdge) {
    if (!adjacency.has(from)) adjacency.set(from, []);
    adjacency.get(from)!.push(edge);
  }

  // 1. Volledige GoKnoop-graaf toevoegen (ongewijzigd, alle 11.003 knopen).
  const allNodeIds = provider.getAllNodeIds();
  for (const id of allNodeIds) {
    const n = provider.getNode(id);
    if (!n) continue;
    nodePosition.set(id, { x: n.x, y: n.y, source: "goknoop" });
    for (const e of provider.getEdgesFrom(id)) {
      // KRITIEKE FIX (8-9-2026): de bestaande FirestoreGraphProvider indexeert
      // elke edge onder ZOWEL fromLogicalNodeId als toLogicalNodeId (voor
      // bidirectionele toegang). Blind e.toLogicalNodeId als bestemming
      // aannemen is dus fout zodra je de edge van de "to"-kant bekijkt -- dan
      // IS e.toLogicalNodeId gewoon het huidige knooppunt zelf, en ontstaat
      // een lus naar zichzelf i.p.v. een echte verbinding naar de overkant.
      // Dit brak grofweg de helft van alle GoKnoop-verbindingen in deze
      // tijdelijke graaf (ontdekt na een onverklaarbare "geen route
      // gevonden"-uitkomst bij alle drie de toleranties).
      const otherEnd = e.fromLogicalNodeId === id ? e.toLogicalNodeId : e.fromLogicalNodeId;
      addEdge(id, otherEnd, { to: otherEnd, distanceM: e.distanceM, source: "goknoop" });
    }
  }

  // 2. NWB-segmenten classificeren (Set B) en eindpunten snappen (Union-Find).
  const setBSegments = nwbSegments.filter((s) => classifySegment(s.bstCode, s.wegnummer) !== "excluded");
  const uf = new UnionFind();
  const pointKey = (segId: string, end: "from" | "to") => `${segId}:${end}`;
  const rawPoints: { key: string; x: number; y: number }[] = [];
  for (const seg of setBSegments) {
    uf.add(pointKey(seg.id, "from"));
    uf.add(pointKey(seg.id, "to"));
    rawPoints.push({ key: pointKey(seg.id, "from"), x: seg.from.x, y: seg.from.y });
    rawPoints.push({ key: pointKey(seg.id, "to"), x: seg.to.x, y: seg.to.y });
  }
  // Grid-bucketing voor efficiënte snap-vergelijking (zelfde patroon als graph-analysis.ts).
  const grid = new Map<string, typeof rawPoints>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / toleranceM)}:${Math.floor(y / toleranceM)}`;
  for (const p of rawPoints) {
    const cell = cellOf(p.x, p.y);
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell)!.push(p);
  }
  for (const p of rawPoints) {
    const [cx, cy] = cellOf(p.x, p.y).split(":").map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const candidates = grid.get(`${cx + dx}:${cy + dy}`);
        if (!candidates) continue;
        for (const q of candidates) {
          if (p === q) continue;
          if (Math.hypot(p.x - q.x, p.y - q.y) <= toleranceM) uf.union(p.key, q.key);
        }
      }
    }
  }

  // NWB-clusterknopen registreren (representatief punt = eerste punt van de cluster).
  const clusterRepresentative = new Map<string, { x: number; y: number }>();
  for (const p of rawPoints) {
    const root = uf.find(p.key);
    if (!clusterRepresentative.has(root)) {
      clusterRepresentative.set(root, { x: p.x, y: p.y });
      nodePosition.set(`nwb:${root}`, { x: p.x, y: p.y, source: "nwb" });
    }
  }

  // 3. NWB-edges toevoegen (elk segment = edge tussen zijn twee cluster-ID's).
  for (const seg of setBSegments) {
    const fromRoot = `nwb:${uf.find(pointKey(seg.id, "from"))}`;
    const toRoot = `nwb:${uf.find(pointKey(seg.id, "to"))}`;
    if (fromRoot === toRoot) continue; // lus op zichzelf, niet nuttig voor routering
    const len = seg.lengthM;
    const info = { bstCode: seg.bstCode, straatnaam: seg.straatnaam, wegnummer: seg.wegnummer };
    addEdge(fromRoot, toRoot, { to: toRoot, distanceM: len, source: "nwb", nwbInfo: info });
    addEdge(toRoot, fromRoot, { to: fromRoot, distanceM: len, source: "nwb", nwbInfo: info });
  }

  // 4. Connectors: GoKnoop-knopen binnen het zoekgebied koppelen aan nabije NWB-clusters.
  const nwbClusterList = Array.from(clusterRepresentative.entries()).map(([root, pos]) => ({ id: `nwb:${root}`, ...pos }));
  let connectorCount = 0;
  for (const id of allNodeIds) {
    const n = provider.getNode(id);
    if (!n) continue;
    if (n.x < connectorSearchBbox.minX || n.x > connectorSearchBbox.maxX || n.y < connectorSearchBbox.minY || n.y > connectorSearchBbox.maxY) continue;
    for (const cluster of nwbClusterList) {
      const d = Math.hypot(n.x - cluster.x, n.y - cluster.y);
      if (d <= toleranceM) {
        addEdge(id, cluster.id, { to: cluster.id, distanceM: d, source: "connector" });
        addEdge(cluster.id, id, { to: id, distanceM: d, source: "connector" });
        connectorCount++;
      }
    }
  }

  return { adjacency, nodePosition };
}

export type DijkstraStep = { nodeId: string; edgeSource: CombinedEdgeSource | "start"; distanceM: number; nwbInfo?: CombinedEdge["nwbInfo"] };

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
