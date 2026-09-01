import { describe, it, expect } from "vitest";
import { buildRouteProgressModel } from "./route-progress-model";
import type { GraphEdge } from "../../route-engine/types";

/**
 * Sanity-check voor de client-side routeomkering (linksom/rechtsom,
 * `reverseLoopCandidate` in app/page.tsx, 29-8-2026): bevestigt dat het
 * simpelweg omkeren van edges[]/nodes[] -- zonder handmatige edge-geometrie-
 * bewerking -- door de bestaande richtingscorrectie (Naarden-bugfix)
 * correct wordt afgehandeld.
 */
describe("Omgekeerde nodes/edges-volgorde -> buildRouteProgressModel geeft de exact omgekeerde geometrie", () => {
  it("een lus omgekeerd doorlopen levert de voorwaartse geometrie in omgekeerde volgorde op", () => {
    const edges: GraphEdge[] = [
      { id: "e1", fromLogicalNodeId: "n1", toLogicalNodeId: "n2", distanceM: 100, directionality: "unknown", geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] },
      { id: "e2", fromLogicalNodeId: "n2", toLogicalNodeId: "n3", distanceM: 100, directionality: "unknown", geometry: [{ x: 0, y: 100 }, { x: 100, y: 100 }] },
      { id: "e3", fromLogicalNodeId: "n3", toLogicalNodeId: "n1", distanceM: 141, directionality: "unknown", geometry: [{ x: 100, y: 100 }, { x: 0, y: 0 }] },
    ];
    const nodes = ["n1", "n2", "n3", "n1"];

    const forward = buildRouteProgressModel(edges, nodes);
    const backward = buildRouteProgressModel([...edges].reverse(), [...nodes].reverse());

    expect(backward.geometry).toEqual([...forward.geometry].reverse());
    expect(backward.totalDistanceM).toBe(forward.totalDistanceM); // zelfde route, zelfde totale afstand
  });
});
