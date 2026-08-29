import { describe, it, expect } from "vitest";
import { buildRouteProgressModel, calculateProgress, getNodeSegmentIndex, calculateNextNodeInfo } from "./route-progress-model";
import type { GraphEdge } from "../../route-engine/types";
import type { MatchedPosition } from "../types";

function edge(overrides: Partial<GraphEdge> & Pick<GraphEdge, "id" | "distanceM" | "geometry">): GraphEdge {
  return {
    fromLogicalNodeId: "from",
    toLogicalNodeId: "to",
    directionality: "unknown",
    ...overrides,
  };
}

function matched(overrides: Partial<MatchedPosition>): MatchedPosition {
  return {
    segmentIndex: 0,
    segmentT: 0,
    point: { x: 0, y: 0 },
    perpendicularDistanceM: 0,
    cumulativeDistanceM: 0,
    ...overrides,
  };
}

describe("buildRouteProgressModel", () => {
  it("gooit een fout bij een lege edges-array (geen geldige route, Phase 2-contract)", () => {
    expect(() => buildRouteProgressModel([])).toThrow();
  });

  it("voegt de geometrie van opeenvolgende edges samen, zonder het gedeelde grenspunt te dupliceren", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
      edge({ id: "e2", distanceM: 50, geometry: [{ x: 0, y: 100 }, { x: 0, y: 150 }] }),
    ];
    const model = buildRouteProgressModel(edges);
    expect(model.geometry).toEqual([{ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 0, y: 150 }]);
  });

  it("totalDistanceM is de som van edge.distanceM -- de ECHTE afstand, niet de rauwe geometrieafstand", () => {
    // Deze edge heeft een rauwe (Euclidische) geometrieafstand van 100m tussen de 2 punten,
    // maar een gedeclareerde distanceM van 130m (bijv. een bochtige brongeometrie,
    // hier vereenvoudigd weergegeven met een rechte lijn tussen de eindpunten).
    const edges: GraphEdge[] = [
      edge({ id: "e1", distanceM: 130, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
    ];
    const model = buildRouteProgressModel(edges);
    expect(model.totalDistanceM).toBe(130); // NIET 100
  });

  it("edgeCumulativeEndM gebruikt cumulatieve ECHTE afstanden", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
      edge({ id: "e2", distanceM: 50, geometry: [{ x: 0, y: 100 }, { x: 0, y: 150 }] }),
      edge({ id: "e3", distanceM: 75, geometry: [{ x: 0, y: 150 }, { x: 0, y: 225 }] }),
    ];
    const model = buildRouteProgressModel(edges);
    expect(model.edgeCumulativeEndM).toEqual([100, 150, 225]);
    expect(model.totalDistanceM).toBe(225);
  });

  it("edgeSegmentRanges wijst elke edge een correct, niet-overlappend segmentbereik toe", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }] }), // 2 segmenten
      edge({ id: "e2", distanceM: 50, geometry: [{ x: 0, y: 100 }, { x: 0, y: 150 }] }), // 1 segment
    ];
    const model = buildRouteProgressModel(edges);
    expect(model.edgeSegmentRanges).toEqual([
      { startSegmentIndex: 0, endSegmentIndexExclusive: 2 },
      { startSegmentIndex: 2, endSegmentIndexExclusive: 3 },
    ]);
  });
});

describe("calculateProgress — basisgevallen en de drie invarianten", () => {
  const edges: GraphEdge[] = [
    edge({ id: "e1", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
    edge({ id: "e2", distanceM: 50, geometry: [{ x: 0, y: 100 }, { x: 0, y: 150 }] }),
  ];
  const model = buildRouteProgressModel(edges);

  it("invariant: begin van de route geeft progressRatio 0 en distanceAlongRouteM 0", () => {
    const result = calculateProgress(model, matched({ segmentIndex: 0, segmentT: 0, cumulativeDistanceM: 0 }));
    expect(result.distanceAlongRouteM).toBeCloseTo(0, 6);
    expect(result.progressRatio).toBeCloseTo(0, 6);
    expect(result.remainingDistanceM).toBeCloseTo(150, 6);
    expect(result.currentEdgeIndex).toBe(0);
    expect(result.currentEdgeId).toBe("e1");
  });

  it("invariant: einde van de route geeft progressRatio 1 (binnen tolerantie) en remainingDistanceM ~0", () => {
    // Laatste segment (index 1, edge e2), t=1 -> cumulatieve rauwe afstand = 150 (einde van de geometrie).
    const result = calculateProgress(model, matched({ segmentIndex: 1, segmentT: 1, cumulativeDistanceM: 150 }));
    expect(result.progressRatio).toBeCloseTo(1, 6);
    expect(result.remainingDistanceM).toBeCloseTo(0, 6);
    expect(result.currentEdgeIndex).toBe(1);
    expect(result.currentEdgeId).toBe("e2");
  });

  it("invariant: remainingDistanceM + distanceAlongRouteM === totalDistanceM, voor meerdere posities langs de route", () => {
    const positions = [
      matched({ segmentIndex: 0, segmentT: 0.25, cumulativeDistanceM: 25 }),
      matched({ segmentIndex: 0, segmentT: 0.9, cumulativeDistanceM: 90 }),
      matched({ segmentIndex: 1, segmentT: 0.5, cumulativeDistanceM: 125 }),
    ];
    for (const pos of positions) {
      const result = calculateProgress(model, pos);
      expect(result.distanceAlongRouteM + result.remainingDistanceM).toBeCloseTo(model.totalDistanceM, 6);
    }
  });

  it("een matched positie op de edge-grens wordt correct aan de juiste edge toegekend", () => {
    // segmentIndex 0 (binnen edge e1's segmentbereik [0,1)), segmentT=1 -> einde van e1.
    const result = calculateProgress(model, matched({ segmentIndex: 0, segmentT: 1, cumulativeDistanceM: 100 }));
    expect(result.currentEdgeIndex).toBe(0);
    expect(result.distanceAlongRouteM).toBeCloseTo(100, 6);
  });

  it("gooit een expliciete fout bij een segmentIndex buiten het bereik van het model (geen stille foutieve output)", () => {
    expect(() => calculateProgress(model, matched({ segmentIndex: 99, cumulativeDistanceM: 0 }))).toThrow();
  });
});

describe("calculateProgress — edge.distanceM is leidend, niet de rauwe geometrieafstand", () => {
  it("interpoleert PROPORTIONEEL binnen een edge, geschaald naar de ECHTE edge.distanceM", () => {
    // Edge met rauwe geometrieafstand 100m, maar gedeclareerde (echte) distanceM van 200m
    // (bijv. een bochtig fietspad, hier als rechte lijn benaderd voor de test).
    const edges: GraphEdge[] = [
      edge({ id: "e1", distanceM: 200, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }),
    ];
    const model = buildRouteProgressModel(edges);

    // Positie op 50% van de rauwe geometrie (cumulatieve rauwe afstand 50 van de 100).
    const result = calculateProgress(model, matched({ segmentIndex: 0, segmentT: 0.5, cumulativeDistanceM: 50 }));

    // Verwacht: 50% van de ECHTE 200m = 100m, NIET 50m (de rauwe geometrieafstand zelf).
    expect(result.distanceAlongRouteM).toBeCloseTo(100, 6);
    expect(result.progressRatio).toBeCloseTo(0.5, 6);
  });

  it("een edge met een tweede, kortere edge erna: cumulatieve afstand blijft edge.distanceM-gebaseerd over de hele route", () => {
    const edges: GraphEdge[] = [
      edge({ id: "e1", distanceM: 200, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }), // rauw 100m, echt 200m
      edge({ id: "e2", distanceM: 10, geometry: [{ x: 0, y: 100 }, { x: 0, y: 110 }] }), // rauw 10m, echt 10m
    ];
    const model = buildRouteProgressModel(edges);

    // Halverwege edge e2 (rauw: segmentIndex 1, cumulatief 105 van de rauwe 110 totaal).
    const result = calculateProgress(model, matched({ segmentIndex: 1, segmentT: 0.5, cumulativeDistanceM: 105 }));

    // Verwacht: volledige e1 (200m echt) + 50% van e2 (5m echt) = 205m.
    expect(result.distanceAlongRouteM).toBeCloseTo(205, 6);
    expect(model.totalDistanceM).toBe(210);
  });
});

describe("getNodeSegmentIndex — gedeelde knooppunt-naar-segment-index-helper", () => {
  const edges: GraphEdge[] = [
    edge({ id: "e1", distanceM: 100, geometry: [{ x: 0, y: 0 }, { x: 0, y: 50 }, { x: 0, y: 100 }] }), // 2 segmenten
    edge({ id: "e2", distanceM: 50, geometry: [{ x: 0, y: 100 }, { x: 0, y: 150 }] }), // 1 segment
  ];
  const model = buildRouteProgressModel(edges);

  it("geeft 0 voor het eerste knooppunt", () => {
    expect(getNodeSegmentIndex(model, 0)).toBe(0);
  });
  it("geeft de laatste geometrie-index voor het laatste knooppunt", () => {
    expect(getNodeSegmentIndex(model, 2)).toBe(model.geometry.length - 1);
  });
  it("geeft de juiste tussenliggende grensindex voor een middelste knooppunt", () => {
    expect(getNodeSegmentIndex(model, 1)).toBe(model.edgeSegmentRanges[1].startSegmentIndex);
  });
});

describe("calculateNextNodeInfo — huidig/volgend knooppunt, afstand, richting (stap 12.5)", () => {
  const edges: GraphEdge[] = [
    edge({ id: "e1", distanceM: 200, geometry: [{ x: 0, y: 0 }, { x: 0, y: 100 }] }), // echt 200m, rauw 100m
    edge({ id: "e2", distanceM: 100, geometry: [{ x: 0, y: 100 }, { x: 100, y: 100 }] }), // oostwaarts
  ];
  const model = buildRouteProgressModel(edges);
  const nodeIds = ["n1", "n2", "n3"];

  it("levert het juiste huidige/volgende knooppunt op basis van currentEdgeIndex", () => {
    const progress = calculateProgress(model, matched({ segmentIndex: 0, segmentT: 0.5, cumulativeDistanceM: 50 }));
    const info = calculateNextNodeInfo(model, progress, matched({ segmentIndex: 0, cumulativeDistanceM: 50 }), nodeIds);
    expect(info.currentNodeId).toBe("n1");
    expect(info.nextNodeId).toBe("n2");
  });

  it("distanceToNextNodeM gebruikt de ECHTE edge.distanceM, niet de rauwe geometrieafstand", () => {
    // Halverwege de rauwe geometrie (50 van de 100) van edge e1 (echt 200m) --
    // dus 50% van 200m = 100m afgelegd, nog 100m te gaan tot n2.
    const progress = calculateProgress(model, matched({ segmentIndex: 0, segmentT: 0.5, cumulativeDistanceM: 50 }));
    const info = calculateNextNodeInfo(model, progress, matched({ segmentIndex: 0, cumulativeDistanceM: 50 }), nodeIds);
    expect(info.distanceToNextNodeM).toBeCloseTo(100, 6); // NIET 50 (de rauwe resterende afstand)
  });

  it("distanceToNextNodeM is nooit negatief (geclampt)", () => {
    const progress = calculateProgress(model, matched({ segmentIndex: 0, segmentT: 1, cumulativeDistanceM: 100 }));
    const info = calculateNextNodeInfo(model, progress, matched({ segmentIndex: 0, cumulativeDistanceM: 100 }), nodeIds);
    expect(info.distanceToNextNodeM).toBeGreaterThanOrEqual(0);
  });

  it("bearingToNextNodeDeg wijst correct oostwaarts (90°) wanneer het volgende knooppunt recht ten oosten ligt", () => {
    const progress = calculateProgress(model, matched({ segmentIndex: 1, segmentT: 0, cumulativeDistanceM: 100 }));
    const info = calculateNextNodeInfo(
      model,
      progress,
      matched({ segmentIndex: 1, point: { x: 0, y: 100 }, cumulativeDistanceM: 100 }),
      nodeIds
    );
    expect(info.bearingToNextNodeDeg).toBeCloseTo(90, 6);
  });

  it("gooit een expliciete fout als nodeIds niet overeenkomt met edges.length + 1", () => {
    const progress = calculateProgress(model, matched({ segmentIndex: 0, cumulativeDistanceM: 0 }));
    expect(() => calculateNextNodeInfo(model, progress, matched({ segmentIndex: 0, cumulativeDistanceM: 0 }), ["te-weinig"])).toThrow(
      /nodeIds\.length/
    );
  });
});

describe("calculateProgress — gebaseerd op routegeometrie, niet hemelsbrede afstand tussen GPS-punten", () => {
  it("een positie die fysiek dicht bij de start ligt, maar ver in de route (na een lus), krijgt hoge progress", () => {
    // Lus die vlak bij het beginpunt terugkomt: (0,0) -> (0,1000) -> (1,1000) -> (1,0).
    // Fysieke afstand tussen start (0,0) en eindpunt (1,0) is slechts 1m (hemelsbreed),
    // maar de routeafstand is ~2001m.
    const edges: GraphEdge[] = [
      edge({
        id: "loop",
        distanceM: 2001,
        geometry: [
          { x: 0, y: 0 },
          { x: 0, y: 1000 },
          { x: 1, y: 1000 },
          { x: 1, y: 0 },
        ],
      }),
    ];
    const model = buildRouteProgressModel(edges);

    // Matched positie aan het einde van de lus (segment 2: (1,1000)->(1,0), t=1, rauwe cumulatief = 1000+1+1000=2001).
    const result = calculateProgress(model, matched({ segmentIndex: 2, segmentT: 1, cumulativeDistanceM: 2001 }));

    // Ondanks de fysieke nabijheid van de start (1m hemelsbreed): progress is bijna 100%, niet bijna 0%.
    expect(result.progressRatio).toBeCloseTo(1, 6);
    expect(result.remainingDistanceM).toBeCloseTo(0, 6);
  });
});
