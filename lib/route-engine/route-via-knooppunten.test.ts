import { describe, it, expect } from "vitest";
import { evaluateDetour, MAX_KNOOPPUNTEN_PER_ROUTE } from "./route-via-knooppunten";

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

describe("MAX_KNOOPPUNTEN_PER_ROUTE", () => {
  it("blijft op de eerder afgesproken waarde van 20 (de omweg-check komt ervoor, niet in plaats ervan)", () => {
    expect(MAX_KNOOPPUNTEN_PER_ROUTE).toBe(20);
  });
});
