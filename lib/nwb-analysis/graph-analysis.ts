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
 *
 * KRITIEKE FIX (9-9-2026): naast nabijheid TUSSEN verschillende segmenten
 * moet ook het begin- en eindpunt van HETZELFDE segment aan elkaar verbonden
 * worden -- je kunt het segment zelf immers afleggen, dus dat is altijd een
 * geldige verbinding, ongeacht hoe ver from en to uit elkaar liggen. Dit
 * ontbrak volledig en onderschatte de connectiviteit stelselmatig (bv. twee
 * exact aansluitende segmenten leverden componentCount=3 op i.p.v. de
 * juiste 1 -- ontdekt via een test die dit expliciet controleerde).
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

  // Elk segment verbindt sowieso zijn eigen from/to.
  const segIds = new Set(points.map((p) => p.segId));
  for (const segId of segIds) {
    uf.union(`${segId}:from`, `${segId}:to`);
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

/**
 * Telt hoeveel punten uit `pointsA` binnen `toleranceM` van TEN MINSTE ÉÉN
 * punt uit `pointsB` liggen -- grid-gebaseerd (O(n+m) i.p.v. O(n*m)).
 *
 * TOEGEVOEGD 9-9-2026, ná een echte 504-timeout bij Hilversum: de eerdere
 * naïeve geneste lus (elk punt in A tegen elk punt in B) was te traag bij
 * honderden × tienduizenden punten. Geëxtraheerd als losse functie zodat dit
 * apart getest kan worden, niet alleen aangenomen.
 */
export function countPointsNearAnyOther(pointsA: { x: number; y: number }[], pointsB: { x: number; y: number }[], toleranceM: number): number {
  const grid = new Map<string, { x: number; y: number }[]>();
  const cellOf = (x: number, y: number) => `${Math.floor(x / toleranceM)}:${Math.floor(y / toleranceM)}`;
  for (const p of pointsB) {
    const cell = cellOf(p.x, p.y);
    if (!grid.has(cell)) grid.set(cell, []);
    grid.get(cell)!.push(p);
  }
  let count = 0;
  for (const a of pointsA) {
    const [cx, cy] = cellOf(a.x, a.y).split(":").map(Number);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        const candidates = grid.get(`${cx + dx}:${cy + dy}`);
        if (!candidates) continue;
        for (const b of candidates) {
          if (Math.hypot(b.x - a.x, b.y - a.y) <= toleranceM) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) count++;
  }
  return count;
}

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

/**
 * TOEGEVOEGD 8-9-2026: variant van analyzeNwbGraph voor het "slanke"
 * segmentformaat (from/to/lengthM, geen volledige geometrie -- zie
 * combined-graph.ts SlimNwbSegment, ingevoerd om de 413-payloadfout en
 * Firestore-documentgrootte-limiet te vermijden). Hergebruikt dezelfde
 * snapPoints-logica hierboven; de enige wijziging is hoe punten/lengte uit
 * het segment gehaald worden. Bewust een aparte functie i.p.v. de
 * bestaande analyzeNwbGraph aan te passen, om niets te wijzigen aan een
 * al-werkend, al-gebruikt eindpunt (nwb-validation-test).
 */
export function analyzeSlimNwbGraph(
  segments: { id: string; from: { x: number; y: number }; to: { x: number; y: number }; lengthM: number }[],
  toleranceM: number
): ComponentStats {
  const points: { x: number; y: number; segId: string; end: "from" | "to" }[] = [];
  for (const seg of segments) {
    points.push({ x: seg.from.x, y: seg.from.y, segId: seg.id, end: "from" });
    points.push({ x: seg.to.x, y: seg.to.y, segId: seg.id, end: "to" });
  }

  const uf = snapPoints(points, toleranceM);

  const rootLength = new Map<string, number>();
  const rootNodeIds = new Map<string, Set<string>>();
  for (const seg of segments) {
    const fromRoot = uf.find(`${seg.id}:from`);
    rootLength.set(fromRoot, (rootLength.get(fromRoot) || 0) + seg.lengthM);
    if (!rootNodeIds.has(fromRoot)) rootNodeIds.set(fromRoot, new Set());
    rootNodeIds.get(fromRoot)!.add(`${seg.id}:from`);
    rootNodeIds.get(fromRoot)!.add(`${seg.id}:to`);
  }

  const sizes2 = Array.from(rootNodeIds.values()).map((s) => s.size).sort((a, b) => b - a);
  const largestRoot2 = Array.from(rootLength.entries()).sort((a, b) => b[1] - a[1])[0];

  return {
    segmentCount: segments.length,
    nodeCount: uf.allIds().length,
    edgeCount: segments.length,
    componentCount: new Set(uf.allIds().map((id) => uf.find(id))).size,
    largestComponentSize: sizes2[0] ?? 0,
    largestComponentLengthM: largestRoot2 ? largestRoot2[1] : 0,
    isolatedComponentCount: sizes2.filter((s) => s === 2).length,
  };
}
