import { describe, it, expect } from "vitest";
import { evaluateDetour, planSegments, MAX_KNOOPPUNTEN_PER_ROUTE } from "./route-via-knooppunten";
import type { PlannedSegment } from "./route-via-knooppunten";

/**
 * TOEGEVOEGD 19-9-2026 ("werk alles uit... totdat je de oplossing hebt", GO van Te).
 * De rest van `route-via-knooppunten.ts` raakt Firestore (knot-segment-cache, GraphProvider)
 * en OpenRouteService aan -- consistent met dit project (API-routes/Firestore-orkestratie
 * worden via de live debugpagina's geverifieerd, niet unit-gemockt, zie eerdere sessie-
 * beslissing). Maar `evaluateDetour()` is bewust pure logica, losgetrokken juist om 'm
 * hier, zonder mocks, hard te kunnen testen -- dit IS de kern van de oplossing voor het
 * Volendam-Hoorn-type probleem (landelijke connected-components-analyse: 1.111 losse
 * componenten, waarvan sommige gaten een enorme, onnodige omweg veroorzaken i.p.v. een
 * volledige blokkade).
 */

describe("evaluateDetour", () => {
  it("een normale, licht kronkelende fietsroute (ruim onder de drempel) is GEEN omweg", () => {
    // 10km hemelsbreed, 12km fietsend -- 1,2x, heel normaal voor een fietsroute.
    const result = evaluateDetour(12000, 10000);
    expect(result.isDetour).toBe(false);
    expect(result.ratio).toBeCloseTo(1.2, 5);
  });

  it("precies op de standaarddrempel (1,8x) is NOG GEEN omweg (strikt groter-dan, geen groter-of-gelijk)", () => {
    const result = evaluateDetour(1800, 1000);
    expect(result.ratio).toBeCloseTo(1.8, 5);
    expect(result.isDetour).toBe(false);
  });

  it("net boven de standaarddrempel IS een omweg", () => {
    const result = evaluateDetour(1801, 1000);
    expect(result.isDetour).toBe(true);
  });

  it("het daadwerkelijke Volendam-Hoorn-geval (29 knooppunten, gevonden omweg via Alkmaar) wordt herkend als omweg", () => {
    // Uit de live diagnose: kuststrook Volendam-Hoorn is hemelsbreed ~13km; de gevonden
    // Dijkstra-omweg via Alkmaar was een veelvoud daarvan (illustratief, gebaseerd op de
    // zichtbare vorm op de kaart -- een driehoekige omweg westwaarts en weer terug).
    const result = evaluateDetour(38000, 13000); // ~2,9x
    expect(result.isDetour).toBe(true);
    expect(result.ratio).toBeCloseTo(2.92, 1);
  });

  it("straightLineM van 0 (zelfde punt, of ontbrekende coördinaten) wordt NOOIT als omweg gezien (geen deling door nul)", () => {
    const result = evaluateDetour(500, 0);
    expect(result.isDetour).toBe(false);
    expect(result.ratio).toBe(1);
  });

  it("een expliciet meegegeven, aangepaste drempel wordt gebruikt i.p.v. de standaardwaarde", () => {
    const strict = evaluateDetour(1300, 1000, 1.2); // 1,3x, boven een strengere drempel van 1,2
    expect(strict.isDetour).toBe(true);

    const lenient = evaluateDetour(1300, 1000, 1.5); // dezelfde 1,3x, onder een soepelere drempel
    expect(lenient.isDetour).toBe(false);
  });

  it("een pad dat KORTER is dan de hemelsbrede afstand (zou niet moeten kunnen, maar defensief) is geen omweg", () => {
    // Afgeronde/onnauwkeurige coördinaten zouden dit in theorie kunnen veroorzaken --
    // moet in elk geval niet crashen of een absurde 'omweg'-classificatie geven.
    const result = evaluateDetour(900, 1000);
    expect(result.isDetour).toBe(false);
    expect(result.ratio).toBeLessThan(1);
  });
});

describe("planSegments — exhaustieve worst-pair-first planner (19-9-2026, derde, meest robuuste correctie)", () => {
  it("een volledig schone route (afstand-tot-bestemming daalt overal) blijft één ongesplitste knot-chain", () => {
    const nodeIds = ["A", "B", "C", "D"];
    const hops = [100, 100, 100];
    // Elk knooppunt ligt dichter bij D dan het vorige -- alles is frontier, geen gaten.
    const distToD: Record<string, number> = { A: 300, B: 200, C: 100, D: 0 };
    const straightLine = (a: string, b: string) => distToD[b] !== undefined && b === "D" ? distToD[a] : Math.abs(distToD[a] - distToD[b]);
    const plan = planSegments(nodeIds, hops, straightLine);
    expect(plan).toEqual([{ type: "knot-chain", nodeIds: ["A", "B", "C", "D"] }]);
  });

  it("isoleert exact het live-gevonden Volendam-Hoorn-patroon: een V-vormige omweg naar een ver punt (C) die de OUDE aanpak (vergelijk-met-eigen-uiteinden) miste, wordt nu WEL gevonden en overbrugd, met alleen C overgeslagen", () => {
    // A=(0,0) B=(1000,0) C=(1000,5000) D=(2000,0) E=(3000,0) -- C is de top van de V, het
    // exacte scenario dat live daadwerkelijk misging (splitsing viel precies op het verste
    // punt, waardoor beide helften er t.o.v. ZICHZELF redelijk recht uitzagen).
    const pos: Record<string, [number, number]> = { A: [0, 0], B: [1000, 0], C: [1000, 5000], D: [2000, 0], E: [3000, 0] };
    const nodeIds = ["A", "B", "C", "D", "E"];
    const hops = [1000, 5000, Math.hypot(1000, 5000), 1000];
    const straightLine = (a: string, b: string) => {
      const [ax, ay] = pos[a];
      const [bx, by] = pos[b];
      return Math.hypot(ax - bx, ay - by);
    };

    const plan = planSegments(nodeIds, hops, straightLine);

    expect(plan).toEqual([
      { type: "knot-chain", nodeIds: ["A", "B"] },
      { type: "direct-bridge", fromNodeId: "B", toNodeId: "D", skippedNodeIds: ["C"], ratio: expect.any(Number) },
      { type: "knot-chain", nodeIds: ["D", "E"] },
    ]);
    // De overbrugde omweg-verhouding moet daadwerkelijk (en flink) boven de drempel liggen.
    const bridge = plan[1];
    if (bridge.type === "direct-bridge") {
      expect(bridge.ratio).toBeGreaterThan(1.8);
    }
  });

  it("twee losse omwegen in dezelfde reeks worden allebei apart gevonden en overbrugd, met een schone knot-chain ertussenin", () => {
    // A -> B -> C(omweg-top 1) -> D -> E -> F(omweg-top 2) -> G -> H
    const pos: Record<string, [number, number]> = {
      A: [0, 0],
      B: [1000, 0],
      C: [1000, 5000],
      D: [2000, 0],
      E: [3000, 0],
      F: [3000, 5000],
      G: [4000, 0],
      H: [5000, 0],
    };
    const nodeIds = ["A", "B", "C", "D", "E", "F", "G", "H"];
    const hops = [
      1000, // A-B
      5000, // B-C
      Math.hypot(1000, 5000), // C-D
      1000, // D-E
      5000, // E-F
      Math.hypot(1000, 5000), // F-G
      1000, // G-H
    ];
    const straightLine = (a: string, b: string) => {
      const [ax, ay] = pos[a];
      const [bx, by] = pos[b];
      return Math.hypot(ax - bx, ay - by);
    };

    const plan = planSegments(nodeIds, hops, straightLine);
    const bridges = plan.filter((p) => p.type === "direct-bridge");
    expect(bridges).toHaveLength(2);
    expect(plan).toEqual([
      { type: "knot-chain", nodeIds: ["A", "B"] },
      { type: "direct-bridge", fromNodeId: "B", toNodeId: "D", skippedNodeIds: ["C"], ratio: expect.any(Number) },
      { type: "knot-chain", nodeIds: ["D", "E"] },
      { type: "direct-bridge", fromNodeId: "E", toNodeId: "G", skippedNodeIds: ["F"], ratio: expect.any(Number) },
      { type: "knot-chain", nodeIds: ["G", "H"] },
    ]);
  });

  it("een lichtjes kronkelend, maar overal redelijk direct pad wordt gewoon in één chain gelaten (geen onnodige overbrugging)", () => {
    // A=(0,0) B=(110,10) C=(220,0) -- B ligt net iets naast de rechte lijn A-C, een heel
    // normale, lichte bocht. Elk deelstuk (A-B, B-C, A-C) blijft ruim onder de drempel.
    const pos: Record<string, [number, number]> = { A: [0, 0], B: [110, 10], C: [220, 0] };
    const nodeIds = ["A", "B", "C"];
    const straightLine = (a: string, b: string) => {
      const [ax, ay] = pos[a];
      const [bx, by] = pos[b];
      return Math.hypot(ax - bx, ay - by);
    };
    const hops = [straightLine("A", "B"), straightLine("B", "C")]; // de hops volgen hier exact de rechte stukjes, dus per definitie geen omweg
    const plan = planSegments(nodeIds, hops, straightLine);
    expect(plan).toEqual([{ type: "knot-chain", nodeIds: ["A", "B", "C"] }]);
  });

  it("minder dan 2 knooppunten geeft een lege planning", () => {
    expect(planSegments(["A"], [], () => 100)).toEqual([]);
    expect(planSegments([], [], () => 100)).toEqual([]);
  });

  it("een reeks van precies 2 knooppunten (één enkele, echte edge) blijft altijd een knot-chain -- er is niets te overbruggen/over te slaan bij een enkele hop", () => {
    const plan = planSegments(["A", "B"], [1000], () => 400); // zelfs een 'kromme' enkele hop
    expect(plan).toEqual([{ type: "knot-chain", nodeIds: ["A", "B"] }]);
  });
});

describe("MAX_KNOOPPUNTEN_PER_ROUTE", () => {
  it("blijft op de eerder afgesproken waarde van 20 (de omweg-check komt ervoor, niet in plaats ervan)", () => {
    expect(MAX_KNOOPPUNTEN_PER_ROUTE).toBe(20);
  });
});
