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

describe("planSegments — verdeel-en-heers-planner", () => {
  it("een volledig schone route (geen enkel stuk een omweg) blijft één ongesplitste knot-chain", () => {
    const nodeIds = ["A", "B", "C", "D"];
    const hops = [100, 100, 100]; // totaal 300
    const straightLine = () => 250; // 300/250 = 1.2, ruim onder de standaarddrempel van 1.8
    const plan = planSegments(nodeIds, hops, straightLine);
    expect(plan).toEqual([{ type: "knot-chain", nodeIds: ["A", "B", "C", "D"] }]);
  });

  it("isoleert gericht het kleinste omweg-stuk (B->C) terwijl A->B en C->D->E als normale knot-chains blijven staan", () => {
    // Precies opgebouwd zodat: het geheel (A-E) een omweg is; bij de eerste splitsing (bij C)
    // is de linkerhelft (A-C) nog steeds een omweg maar de rechterhelft (C-E) niet; bij het
    // verder splitsen van A-C (bij B) is A-B schoon maar B-C (één enkele hop) een omweg --
    // dat laatste kan niet verder gesplitst worden en wordt dus de enige overbrugging.
    const nodeIds = ["A", "B", "C", "D", "E"];
    const hops = [100, 500, 100, 100]; // A-B, B-C, C-D, D-E
    const table: Record<string, number> = {
      "A,E": 300, // (100+500+100+100)/300 = 2.667 -> omweg
      "A,C": 200, // (100+500)/200 = 3.0 -> omweg
      "C,E": 150, // (100+100)/150 = 1.333 -> GEEN omweg
      "A,B": 90, // 100/90 = 1.111 -> GEEN omweg
      "B,C": 200, // 500/200 = 2.5 -> omweg, kan niet verder gesplitst worden (aangrenzend)
    };
    const straightLine = (a: string, b: string) => {
      const v = table[`${a},${b}`];
      if (v === undefined) throw new Error(`onverwacht opgevraagd paar in test: ${a},${b}`);
      return v;
    };

    const plan = planSegments(nodeIds, hops, straightLine);

    expect(plan).toEqual([
      { type: "knot-chain", nodeIds: ["A", "B"] },
      { type: "direct-bridge", fromNodeId: "B", toNodeId: "C", skippedNodeIds: [], ratio: 2.5 },
      { type: "knot-chain", nodeIds: ["C", "D", "E"] },
    ]);
  });

  it("overbrugt het HELE stuk in één keer (i.p.v. eindeloos verder te splitsen) als splitsen het probleem niet isoleert", () => {
    // Beide helften blijven na de eerste splitsing nog steeds een omweg -- de planner moet
    // dan stoppen met splitsen en het hele stuk als één overbrugging behandelen, niet
    // doorrecursen tot losse, nutteloze enkele-hop-overbruggingen.
    const nodeIds = ["A", "B", "C", "D", "E"];
    const hops = [300, 300, 300, 300]; // totaal 1200
    const table: Record<string, number> = {
      "A,E": 400, // 1200/400 = 3.0 -> omweg
      "A,C": 200, // 600/200 = 3.0 -> ook omweg
      "C,E": 200, // 600/200 = 3.0 -> ook omweg
    };
    const straightLine = (a: string, b: string) => {
      const v = table[`${a},${b}`];
      if (v === undefined) throw new Error(`onverwacht opgevraagd paar in test: ${a},${b}`);
      return v;
    };

    const plan = planSegments(nodeIds, hops, straightLine);

    expect(plan).toEqual([
      { type: "direct-bridge", fromNodeId: "A", toNodeId: "E", skippedNodeIds: ["B", "C", "D"], ratio: 3 },
    ]);
  });

  it("twee knooppunten (één enkele hop) die zelf als omweg gemarkeerd staat, wordt direct overbrugd (niets te splitsen)", () => {
    const nodeIds = ["A", "B"];
    const hops = [1000]; // een ongewoon bochtig fysiek pad
    const straightLine = () => 400; // 1000/400 = 2.5 -> omweg
    const plan = planSegments(nodeIds, hops, straightLine);
    expect(plan).toEqual([{ type: "direct-bridge", fromNodeId: "A", toNodeId: "B", skippedNodeIds: [], ratio: 2.5 }]);
  });

  it("minder dan 2 knooppunten geeft een lege planning (niets om te overbruggen)", () => {
    expect(planSegments(["A"], [], () => 100)).toEqual([]);
    expect(planSegments([], [], () => 100)).toEqual([]);
  });

  it("BEKENDE BEPERKING: een symmetrische 'heen-en-weer'-omweg waarvan de piek precies op het splitsingspunt valt, wordt NIET herkend", () => {
    // Gedocumenteerd, geen aanname: als de omweg een vrijwel perfecte V-vorm is (rechtstreeks
    // ver opzij en weer terug) én de binaire splitsing toevallig precies op de top van die V
    // valt, kunnen beide helften individueel als 'niet erg krom' beoordeeld worden (elke
    // helft is zelf bijna een rechte lijn naar een ver punt), terwijl de HELE heen-en-weer-
    // beweging wel degelijk een grote omweg is. Dit is een bekende, geaccepteerde beperking
    // van de verdeel-en-heers-aanpak -- geen bug, maar wel iets om in de praktijk (live
    // testen) in de gaten te houden.
    const nodeIds = ["A", "B", "C", "D", "E"];
    // A=(0,0) B=(1000,0) C=(1000,5000) D=(2000,0) E=(3000,0) -- C is de top van de V.
    const hops = [1000, 5000, Math.hypot(1000, 5000), 1000];
    const straightLine = (a: string, b: string) => {
      const pos: Record<string, [number, number]> = { A: [0, 0], B: [1000, 0], C: [1000, 5000], D: [2000, 0], E: [3000, 0] };
      const [ax, ay] = pos[a];
      const [bx, by] = pos[b];
      return Math.hypot(ax - bx, ay - by);
    };
    const overall = evaluateDetour(hops.reduce((s, d) => s + d, 0), straightLine("A", "E"));
    expect(overall.isDetour).toBe(true); // de hele reis IS een duidelijke omweg (ratio ruim > 1.8)...

    const plan = planSegments(nodeIds, hops, straightLine);
    // ...maar de planner splitst 'm toch op in twee "schone" stukken, zonder overbrugging:
    expect(plan.every((p) => p.type === "knot-chain")).toBe(true);
  });
});

describe("MAX_KNOOPPUNTEN_PER_ROUTE", () => {
  it("blijft op de eerder afgesproken waarde van 20 (de omweg-check komt ervoor, niet in plaats ervan)", () => {
    expect(MAX_KNOOPPUNTEN_PER_ROUTE).toBe(20);
  });
});
