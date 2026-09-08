/**
 * Tijdelijke graafopbouw + component-analyse -- TIJDELIJK, alleen voor de
 * validatietest (8-9-2026). Geen relatie met de productie route-engine
 * (lib/route-engine/) -- volledig gescheiden, puur voor deze meting.
 */

import type { NwbSegment } from "./nwb-client";

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
  allIds(): string[] {
    return Array.from(this.parent.keys());
  }
}

/**
 * Groepeert punten binnen `toleranceM` van elkaar tot dezelfde graaf-node,
 * via grid-bucketing (voorkomt een trage O(n²)-vergelijking bij duizenden
 * punten): elk punt wordt in een rastercel van toleranceM geplaatst, en
 * alleen punten in dezelfde of aangrenzende cel worden met elkaar vergeleken.
 */
function snapPoints(points: { x: number; y: number; segId: string; end: "from" | "to" }[], toleranceM: number) {
  const uf = new UnionFind();
  const grid = new Map<string, typeof points>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / toleranceM)}:${Math.floor(y / toleranceM)}`;

  for (const p of points) {
    const key = `${p.segId}:${p.end}`;
    uf.add(key);
    const cell = cellOf(p.x, p.y);
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell)!.push(p);
  }

  for (const p of points) {
    const [cx, cy] = cellOf(p.x, p.y).split(":").map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const neighborCell = `${cx + dx}:${cy + dy}`;
        const candidates = grid.get(neighborCell);
        if (!candidates) continue;
        for (const q of candidates) {
          if (p === q) continue;
          const dist = Math.hypot(p.x - q.x, p.y - q.y);
          if (dist <= toleranceM) {
            uf.union(`${p.segId}:${p.end}`, `${q.segId}:${q.end}`);
          }
        }
      }
    }
  }

  return uf;
}

export type ComponentStats = {
  segmentCount: number;
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  largestComponentSize: number;
  largestComponentLengthM: number;
  isolatedComponentCount: number; // componenten met precies 1 node (geen enkele verbinding)
};

function segmentLengthM(coords: { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += Math.hypot(coords[i].x - coords[i - 1].x, coords[i].y - coords[i - 1].y);
  }
  return total;
}

/** Bouwt een graaf uit NWB-segmenten bij een gegeven snap-tolerantie en berekent connected components. */
export function analyzeNwbGraph(segments: NwbSegment[], toleranceM: number): ComponentStats {
  const points: { x: number; y: number; segId: string; end: "from" | "to" }[] = [];
  for (const seg of segments) {
    if (seg.coordinates.length < 2) continue;
    const from = seg.coordinates[0];
    const to = seg.coordinates[seg.coordinates.length - 1];
    points.push({ x: from.x, y: from.y, segId: seg.id, end: "from" });
    points.push({ x: to.x, y: to.y, segId: seg.id, end: "to" });
  }

  const uf = snapPoints(points, toleranceM);

  const rootLength = new Map<string, number>();
  const rootNodeIds = new Map<string, Set<string>>();
  for (const seg of segments) {
    if (seg.coordinates.length < 2) continue;
    const fromRoot = uf.find(`${seg.id}:from`);
    const len = segmentLengthM(seg.coordinates);
    rootLength.set(fromRoot, (rootLength.get(fromRoot) || 0) + len);
    if (!rootNodeIds.has(fromRoot)) rootNodeIds.set(fromRoot, new Set());
    rootNodeIds.get(fromRoot)!.add(`${seg.id}:from`);
    rootNodeIds.get(fromRoot)!.add(`${seg.id}:to`);
  }

  const sizes = Array.from(rootNodeIds.values()).map((s) => s.size).sort((a, b) => b - a);
  const largestRoot = Array.from(rootLength.entries()).sort((a, b) => b[1] - a[1])[0];

  return {
    segmentCount: segments.length,
    nodeCount: uf.allIds().length,
    edgeCount: segments.filter((s) => s.coordinates.length >= 2).length,
    componentCount: new Set(uf.allIds().map((id) => uf.find(id))).size,
    largestComponentSize: sizes[0] ?? 0,
    largestComponentLengthM: largestRoot ? largestRoot[1] : 0,
    isolatedComponentCount: sizes.filter((s) => s === 2).length, // 1 segment, 2 (from+to) node-ids, geen enkele andere verbinding
  };
}
