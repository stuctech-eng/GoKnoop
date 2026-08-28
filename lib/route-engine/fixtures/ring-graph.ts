import { GraphEdge, GraphNode } from "../types";

/**
 * Ring-topologie, specifiek gebouwd om de loop-route-generator te testen.
 * Een lineaire of ruit-fixture heeft geen "rondom een startpunt"-structuur.
 *
 *          R0
 *      R7 /  \ R1
 *        |    |
 *    R6--+ S  +--R2
 *        |    |
 *      R5 \  / R3
 *          R4
 *
 * S = startpunt (0,0). R0..R7 = ring op straal 200m, elke 45°.
 * Elke Ri heeft een spaak naar S (lengte ~200m) EN een ringverbinding naar
 * de buren Ri-1/Ri+1 (lengte ~153m, koorde bij 45° op straal 200m).
 *
 * Kortste lus vanaf S via bijv. R0: S-R0 (spaak) + R0-R1 (ring) + R1-S
 * (spaak) = 200 + 153 + 200 = 553m. Grotere lussen ontstaan door verder
 * over de ring te lopen vóór de terugkerende spaak.
 */

const RADIUS = 200;
const RING_COUNT = 8;

function ringNodeId(i: number): string {
  return `R${i % RING_COUNT}`;
}

function ringPos(i: number): { x: number; y: number } {
  const angle = (i / RING_COUNT) * 2 * Math.PI;
  return { x: RADIUS * Math.cos(angle), y: RADIUS * Math.sin(angle) };
}

export const ringNodes: GraphNode[] = [
  { id: "S", x: 0, y: 0 },
  ...Array.from({ length: RING_COUNT }, (_, i) => ({ id: ringNodeId(i), ...ringPos(i) })),
];

function edgeDistance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

export const ringEdges: GraphEdge[] = [
  // Spaken: S <-> elke ring-node
  ...Array.from({ length: RING_COUNT }, (_, i) => {
    const pos = ringPos(i);
    return {
      id: `spoke_${i}`,
      fromLogicalNodeId: "S",
      toLogicalNodeId: ringNodeId(i),
      distanceM: edgeDistance({ x: 0, y: 0 }, pos),
      directionality: "unknown" as const,
      geometry: [
        { x: 0, y: 0 },
        pos,
      ],
    };
  }),
  // Ring: elke node <-> de volgende (cyclisch)
  ...Array.from({ length: RING_COUNT }, (_, i) => {
    const a = ringPos(i);
    const b = ringPos(i + 1);
    return {
      id: `ring_${i}`,
      fromLogicalNodeId: ringNodeId(i),
      toLogicalNodeId: ringNodeId(i + 1),
      distanceM: edgeDistance(a, b),
      directionality: "unknown" as const,
      geometry: [a, b],
    };
  }),
];
