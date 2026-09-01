"use client";

/**
 * Debugharness voor NavigationScreen (stap 12.4-12.7 + Start-knop-koppeling).
 *
 * Dunne wrapper -- alle navigatielogica staat in
 * `components/navigation/NavigationScreen.tsx`, gedeeld met de echte
 * Phase 3-flow (`app/page.tsx`). Deze pagina voedt het component alleen met
 * een vaste testroute, zodat er zonder een echte routekeuze getest kan
 * worden.
 */

import NavigationScreen from "@/components/navigation/NavigationScreen";
import type { GraphEdge } from "@/lib/route-engine/types";

const TEST_EDGES: GraphEdge[] = [
  {
    id: "test-e1",
    fromLogicalNodeId: "12",
    toLogicalNodeId: "34",
    distanceM: 620,
    directionality: "bidirectional",
    geometry: [
      { x: 136000, y: 456000 },
      { x: 136050, y: 456300 },
      { x: 136000, y: 456600 },
    ],
  },
  {
    id: "test-e2",
    fromLogicalNodeId: "34",
    toLogicalNodeId: "56",
    distanceM: 450,
    directionality: "bidirectional",
    geometry: [
      { x: 136000, y: 456600 },
      { x: 136400, y: 456750 },
    ],
  },
  {
    id: "test-e3",
    fromLogicalNodeId: "56",
    toLogicalNodeId: "78",
    distanceM: 380,
    directionality: "bidirectional",
    geometry: [
      { x: 136400, y: 456750 },
      { x: 136400, y: 457130 },
    ],
  },
];
const TEST_NODE_IDS = ["12", "34", "56", "78"];

export default function MapLiveDebugPage() {
  return <NavigationScreen edges={TEST_EDGES} nodeSequence={TEST_NODE_IDS} nodeDisplayNumbers={TEST_NODE_IDS} datasetVersionId="debug-fixture" />;
}
