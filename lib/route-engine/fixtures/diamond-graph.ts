import { GraphEdge, GraphNode } from "../types";

/**
 * Ruit-topologie, specifiek gebouwd om routediversiteit te testen (de lineaire
 * simple-graph-fixture heeft daar geen twee echt verschillende paden voor).
 *
 *        N2
 *       /   \
 *     E1     E2
 *     /       \
 *   N1         N4
 *     \       /
 *     E3     E4
 *       \   /
 *        N3
 *
 * Pad A (via N2): E1(100) + E2(100) = 200 -- kortste, wordt Route 1
 * Pad B (via N3): E3(110) + E4(110) = 220 -- enige alternatief, wordt Route 2
 * Geen derde onafhankelijk pad aanwezig -- test dat de planner eerlijk
 * foundCount < requestedCount teruggeeft in plaats van te padden met duplicaten.
 */

export const diamondNodes: GraphNode[] = [
  { id: "N1", x: 0, y: 0 },
  { id: "N2", x: 50, y: 50 },
  { id: "N3", x: 50, y: -50 },
  { id: "N4", x: 100, y: 0 },
];

export const diamondEdges: GraphEdge[] = [
  {
    id: "E1",
    fromLogicalNodeId: "N1",
    toLogicalNodeId: "N2",
    distanceM: 100,
    directionality: "unknown",
    geometry: [
      { x: 0, y: 0 },
      { x: 50, y: 50 },
    ],
  },
  {
    id: "E2",
    fromLogicalNodeId: "N2",
    toLogicalNodeId: "N4",
    distanceM: 100,
    directionality: "unknown",
    geometry: [
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ],
  },
  {
    id: "E3",
    fromLogicalNodeId: "N1",
    toLogicalNodeId: "N3",
    distanceM: 110,
    directionality: "unknown",
    geometry: [
      { x: 0, y: 0 },
      { x: 50, y: -50 },
    ],
  },
  {
    id: "E4",
    fromLogicalNodeId: "N3",
    toLogicalNodeId: "N4",
    distanceM: 110,
    directionality: "unknown",
    geometry: [
      { x: 50, y: -50 },
      { x: 100, y: 0 },
    ],
  },
];
