import { GraphEdge, GraphNode } from "../types";

/**
 * Kleine, handmatig samengestelde testgraaf. Coördinaten zijn fictief maar
 * consistent (eenvoudige rechte lijnen tussen nodes, voor duidelijke
 * geometrie-invarianttests).
 *
 * Topologie:
 *
 *   N1 --E1(100m)-- N2 --E2(100m)-- N3 --E4(50m)-- N4 --E6(60m)-- N5
 *    \                                /
 *     \--------E3(250m)--------------/
 *   N1 --E5(80m, parallel aan E1)-- N2
 *
 *   N6 (volledig geïsoleerd, geen enkele edge)
 *
 * Bekende kortste paden (met de hand berekend, voor assertions):
 * - N1 -> N3: via N1-N2(E5,80m)-N3(E2,100m) = 180m (niet via E1=100m -> 200m,
 *   en niet via directe E3=250m). Test dat Dijkstra de goedkopere van twee
 *   parallelle edges (E1 vs E5) kiest.
 * - N1 -> N5: N1-N2(E5)-N3(E2)-N4(E4)-N5(E6) = 80+100+50+60 = 290m
 * - N1 -> N6: geen pad (disconnected) -> reason 'disconnected'
 * - N4 -> N6: geen pad (disconnected) -> reason 'disconnected'
 */

export const fixtureNodes: GraphNode[] = [
  { id: "N1", displayNumber: "1", displayRegio: "Fixture", x: 0, y: 0 },
  { id: "N2", displayNumber: "2", displayRegio: "Fixture", x: 100, y: 0 },
  { id: "N3", displayNumber: "3", displayRegio: "Fixture", x: 200, y: 0 },
  { id: "N4", displayNumber: "4", displayRegio: "Fixture", x: 250, y: 0 },
  { id: "N5", displayNumber: "5", displayRegio: "Fixture", x: 310, y: 0 },
  { id: "N6", displayNumber: "6", displayRegio: "Fixture-isolated", x: 1000, y: 1000 },
];

export const fixtureEdges: GraphEdge[] = [
  {
    id: "E1",
    fromLogicalNodeId: "N1",
    toLogicalNodeId: "N2",
    distanceM: 100,
    directionality: "unknown",
    geometry: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
  },
  {
    id: "E5",
    fromLogicalNodeId: "N1",
    toLogicalNodeId: "N2",
    distanceM: 80, // parallel aan E1, goedkoper
    directionality: "unknown",
    geometry: [
      { x: 0, y: 0 },
      { x: 50, y: -10 }, // licht afwijkend tracé, om te bewijzen dat de juiste geometrie wordt gebruikt
      { x: 100, y: 0 },
    ],
  },
  {
    id: "E2",
    fromLogicalNodeId: "N2",
    toLogicalNodeId: "N3",
    distanceM: 100,
    directionality: "unknown",
    geometry: [
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ],
  },
  {
    id: "E3",
    fromLogicalNodeId: "N1",
    toLogicalNodeId: "N3",
    distanceM: 250, // directe maar langere route
    directionality: "unknown",
    geometry: [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
    ],
  },
  {
    id: "E4",
    fromLogicalNodeId: "N3",
    toLogicalNodeId: "N4",
    distanceM: 50,
    directionality: "unknown",
    geometry: [
      { x: 200, y: 0 },
      { x: 250, y: 0 },
    ],
  },
  {
    id: "E6",
    fromLogicalNodeId: "N4",
    toLogicalNodeId: "N5",
    distanceM: 60,
    directionality: "unknown",
    geometry: [
      { x: 250, y: 0 },
      { x: 310, y: 0 },
    ],
  },
  // N6 bewust zonder edges -- geïsoleerde node
];
