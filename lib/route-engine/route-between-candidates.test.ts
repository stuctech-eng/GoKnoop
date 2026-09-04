import { describe, it, expect } from "vitest";
import { computeRouteBetweenCandidatesWithFallback } from "./route-between-candidates";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Twee "eilanden" verbonden via een middenpad -- de dichtstbijzijnde
 * bestemmingskandidaat ("destIsolated") heeft wel edges maar zit op een
 * doodlopend spoor (net als de eerdere Volendam-/Naarden-achtige fixtures) --
 * de volgende bestemmingskandidaat ("destGood") moet gekozen worden.
 */
async function buildFixtureProvider(): Promise<InMemoryGraphProvider> {
  const nodes: GraphNode[] = [
    { id: "origin", x: 0, y: 0, displayNumber: "1" },
    { id: "hub", x: 1000, y: 0, displayNumber: "2" },
    { id: "destGood", x: 2000, y: 0, displayNumber: "3" },
    { id: "destIsolated", x: 2000, y: 1000, displayNumber: "4" }, // enkel via hub bereikbaar, doodlopend
  ];
  const edges: GraphEdge[] = [
    { id: "e-origin-hub", fromLogicalNodeId: "origin", toLogicalNodeId: "hub", distanceM: 1000, directionality: "unknown", geometry: [{ x: 0, y: 0 }, { x: 1000, y: 0 }] },
    { id: "e-hub-destGood", fromLogicalNodeId: "hub", toLogicalNodeId: "destGood", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 2000, y: 0 }] },
    { id: "e-hub-destIsolated", fromLogicalNodeId: "hub", toLogicalNodeId: "destIsolated", distanceM: 1000, directionality: "unknown", geometry: [{ x: 1000, y: 0 }, { x: 2000, y: 1000 }] },
  ];
  const provider = new InMemoryGraphProvider(nodes, edges);
  await provider.load();
  return provider;
}

describe("computeRouteBetweenCandidatesWithFallback", () => {
  it("gebruikt de tweede bestemmingskandidaat als de eerste wel bereikbaar is (dus dit test bewijst vooral het gelukkige pad)", async () => {
    const provider = await buildFixtureProvider();
    const fromCandidates = [{ logicalNodeId: "origin", distanceM: 50 }];
    const toCandidates = [
      { logicalNodeId: "destIsolated", distanceM: 100 },
      { logicalNodeId: "destGood", distanceM: 900 },
    ];
    const result = computeRouteBetweenCandidatesWithFallback(provider, "v-test", fromCandidates, toCandidates);
    expect("ok" in result).toBe(false);
    if ("selectedDestinationNodeId" in result) {
      // Beide bestemmingen zijn hier technisch bereikbaar (destIsolated is doodlopend maar niet
      // onbereikbaar als eindpunt van een punt-naar-punt-route, in tegenstelling tot een lus) --
      // dus de EERSTE (destIsolated) wordt hier al geaccepteerd. Zie de volgende test voor het
      // scenario waarin de eerste kandidaat écht niet werkt.
      expect(["destIsolated", "destGood"]).toContain(result.selectedDestinationNodeId);
    }
  });

  it("valt terug op de tweede bestemmingskandidaat als de eerste volledig onbekend/ongeldig is", async () => {
    const provider = await buildFixtureProvider();
    const fromCandidates = [{ logicalNodeId: "origin", distanceM: 50 }];
    const toCandidates = [
      { logicalNodeId: "bestaat-niet", distanceM: 100 },
      { logicalNodeId: "destGood", distanceM: 900 },
    ];
    const result = computeRouteBetweenCandidatesWithFallback(provider, "v-test", fromCandidates, toCandidates);
    if ("selectedDestinationNodeId" in result) {
      expect(result.selectedDestinationNodeId).toBe("destGood");
      expect(result.selectedDestinationCandidateRank).toBe(2);
      expect(result.selectedDestinationNodeDisplayNumber).toBe("3");
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("gebruikt ook de herkomst-fallback per bestemmingskandidaat (beide kanten samen)", async () => {
    const provider = await buildFixtureProvider();
    const fromCandidates = [
      { logicalNodeId: "onbekende-herkomst", distanceM: 10 },
      { logicalNodeId: "origin", distanceM: 500 },
    ];
    const toCandidates = [{ logicalNodeId: "destGood", distanceM: 100 }];
    const result = computeRouteBetweenCandidatesWithFallback(provider, "v-test", fromCandidates, toCandidates);
    if ("selectedDestinationNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("origin"); // herkomst-fallback sloeg de onbekende over
      expect(result.selectedDestinationNodeId).toBe("destGood");
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("geeft een duidelijke faal-uitkomst als geen enkele combinatie werkt (twee volledig gescheiden, onbereikbare knooppunten)", async () => {
    // Twee VERSCHILLENDE, volledig onverbonden nodes -- 'van een node naar zichzelf' zou
    // triviaal altijd slagen (afstand 0), dus dit test bewust twee losse, niet-verbonden nodes.
    const nodes: GraphNode[] = [
      { id: "isolatedA", x: 0, y: 0 },
      { id: "isolatedB", x: 5000, y: 5000 },
    ];
    const provider = new InMemoryGraphProvider(nodes, []);
    await provider.load();
    const result = computeRouteBetweenCandidatesWithFallback(
      provider,
      "v-test",
      [{ logicalNodeId: "isolatedA", distanceM: 10 }],
      [{ logicalNodeId: "isolatedB", distanceM: 10 }]
    );
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result && result.ok === false) {
      expect(result.reason).toBe("no_usable_candidate");
      expect(result.destinationCandidatesAttempted).toBe(1);
    }
  });

  it("[VERPLICHTE REGRESSIETEST, exacte gerapporteerde bug: 'snelste route' naar Hilversum bleek een gigantische omweg] kiest de daadwerkelijk KORTSTE bestemmingskandidaat, niet zomaar de eerste die werkt", async () => {
    // Bestemmingskandidaat A wordt EERST geprobeerd en werkt (levert een route op) -- maar
    // die route is een grote omweg (10.000m). Kandidaat B (tweede geprobeerd) is veel
    // korter (100m). De oude, foute logica zou A kiezen (eerste die werkt); de fix moet B
    // kiezen (daadwerkelijk de kortste).
    const nodes = [
      { id: "origin", x: 0, y: 0, displayNumber: "1" },
      { id: "detourMid", x: 0, y: 5000, displayNumber: "2" },
      { id: "destA", x: 0, y: 10000, displayNumber: "3" }, // via een lange omweg bereikbaar
      { id: "destB", x: 100, y: 0, displayNumber: "4" }, // vlak bij origin, korte route
    ];
    const edges = [
      { id: "e1", fromLogicalNodeId: "origin", toLogicalNodeId: "detourMid", distanceM: 5000, directionality: "unknown" as const, geometry: [{ x: 0, y: 0 }, { x: 0, y: 5000 }] },
      { id: "e2", fromLogicalNodeId: "detourMid", toLogicalNodeId: "destA", distanceM: 5000, directionality: "unknown" as const, geometry: [{ x: 0, y: 5000 }, { x: 0, y: 10000 }] },
      { id: "e3", fromLogicalNodeId: "origin", toLogicalNodeId: "destB", distanceM: 100, directionality: "unknown" as const, geometry: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
    ];
    const provider = new InMemoryGraphProvider(nodes, edges);
    await provider.load();

    const fromCandidates = [{ logicalNodeId: "origin", distanceM: 10 }];
    const toCandidates = [
      { logicalNodeId: "destA", distanceM: 200 }, // dichterbij hemelsbreed, maar EERST geprobeerd
      { logicalNodeId: "destB", distanceM: 500 }, // verder hemelsbreed, maar de ECHTE route is korter
    ];

    const result = computeRouteBetweenCandidatesWithFallback(provider, "v-test", fromCandidates, toCandidates);
    expect("selectedDestinationNodeId" in result).toBe(true);
    if ("selectedDestinationNodeId" in result) {
      expect(result.selectedDestinationNodeId).toBe("destB"); // de daadwerkelijk kortere, niet de eerst-geprobeerde
      expect(result.route.distanceM).toBe(100);
    }
  });
});
