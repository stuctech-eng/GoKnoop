import { describe, it, expect } from "vitest";
import { matchPosition } from "./candidate-matcher";
import type { MatchInput, MatchOptions } from "./candidate-matcher";
import type { MatchedPosition } from "../types";
import type { Point } from "../../route-engine/types";

const DEFAULT_OPTIONS: MatchOptions = {
  baseWindowM: 100,
  windowMarginPerMps: 10,
  weights: { distance: 1, heading: 0.1, continuity: 0.5 },
};

function input(overrides: Partial<MatchInput> = {}): MatchInput {
  return {
    position: { x: 0, y: 0 },
    headingDeg: null,
    speedMps: null,
    previousMatch: null,
    ...overrides,
  };
}

describe("matchPosition — basisgevallen", () => {
  it("geeft null bij een geometrie met minder dan 2 punten", () => {
    expect(matchPosition([], input(), DEFAULT_OPTIONS)).toBeNull();
    expect(matchPosition([{ x: 0, y: 0 }], input(), DEFAULT_OPTIONS)).toBeNull();
  });

  it("geeft null bij een geometrie met lengte 0 (identieke punten)", () => {
    const geometry: Point[] = [{ x: 5, y: 5 }, { x: 5, y: 5 }];
    expect(matchPosition(geometry, input(), DEFAULT_OPTIONS)).toBeNull();
  });

  it("matcht een positie exact op de lijn", () => {
    const geometry: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const result = matchPosition(geometry, input({ position: { x: 0, y: 40 } }), DEFAULT_OPTIONS);
    expect(result).not.toBeNull();
    expect(result!.perpendicularDistanceM).toBeCloseTo(0, 6);
    expect(result!.cumulativeDistanceM).toBeCloseTo(40, 6);
    expect(result!.segmentIndex).toBe(0);
  });

  it("matcht een positie naast de lijn, met de correcte perpendiculaire afstand", () => {
    const geometry: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const result = matchPosition(geometry, input({ position: { x: 7, y: 40 } }), DEFAULT_OPTIONS);
    expect(result!.perpendicularDistanceM).toBeCloseTo(7, 6);
    expect(result!.cumulativeDistanceM).toBeCloseTo(40, 6);
  });

  it("kiest het juiste segment op een polyline met meerdere segmenten (geen vorige match, geen venster)", () => {
    const geometry: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 100 },
      { x: 100, y: 100 },
    ];
    const result = matchPosition(geometry, input({ position: { x: 50, y: 105 } }), DEFAULT_OPTIONS);
    expect(result!.segmentIndex).toBe(1); // het tweede segment, (0,100)->(100,100)
    expect(result!.perpendicularDistanceM).toBeCloseTo(5, 6);
  });

  it("zonder vorige match zijn ALLE segmenten kandidaat (ontwerp sectie 6, randgeval sessiestart)", () => {
    // Geometrie waar het dichtstbijzijnde punt ver van het begin van de polyline ligt --
    // zou bij een (onterecht) venster rond "positie 0" gemist worden.
    const geometry: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 1000 },
    ];
    const result = matchPosition(geometry, input({ position: { x: 0, y: 950 } }), DEFAULT_OPTIONS);
    expect(result!.cumulativeDistanceM).toBeCloseTo(950, 6);
  });
});

describe("matchPosition — venster rond de vorige match", () => {
  it("sluit een geometrisch dichtbij, maar qua routevoortgang ver gelegen segment uit buiten het venster", () => {
    // Twee parallelle, vlak bij elkaar liggende segmenten (20m uit elkaar), maar ver
    // uit elkaar in cumulatieve afstand (0-1000 vs. 1020-2020).
    const geometry: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 1000 }, // segment 0: outbound
      { x: 20, y: 1000 }, // segment 1: korte connector
      { x: 20, y: 0 }, // segment 2: parallel retourtraject, 20m van segment 0
    ];
    const previousMatch: MatchedPosition = {
      segmentIndex: 0,
      segmentT: 0.4,
      point: { x: 0, y: 400 },
      perpendicularDistanceM: 0,
      cumulativeDistanceM: 400,
    };
    // Positie fysiek dicht bij het retourtraject op vergelijkbare hoogte (y=420) --
    // geometrisch dichterbij segment 2, maar dat ligt cumulatief rond de 1600m,
    // ver buiten een venster van 100m rond de vorige positie (400m).
    const narrowOptions: MatchOptions = { baseWindowM: 100, windowMarginPerMps: 0, weights: { distance: 1, heading: 0, continuity: 0 } };
    const result = matchPosition(geometry, input({ position: { x: 12, y: 420 }, previousMatch }), narrowOptions);

    // Zonder venster zou dit segment 2 zijn (8m < 12m). Mét venster: segment 0.
    expect(result!.segmentIndex).toBe(0);
  });

  it("venstergrootte schaalt mee met speedMps (ontwerp sectie 5)", () => {
    // Twee segmenten: seg0 (0,0)->(0,15), cumEnd 15; seg1 (0,15)->(0,115), cumEnd 115.
    // GPS-positie (0,60) ligt precies OP seg1, ver voorbij seg0. Bij lage snelheid
    // (klein venster) valt seg1 net buiten het venster (segStart 15 > window 10) en
    // is seg0 de enige kandidaat (geclampte, verre match). Bij hogere snelheid
    // (groter venster) wordt seg1 wél kandidaat en wint die terecht (exacte match).
    const geometry: Point[] = [
      { x: 0, y: 0 },
      { x: 0, y: 15 }, // segment 0, cumEnd 15
      { x: 0, y: 115 }, // segment 1, cumEnd 115
    ];
    const previousMatch: MatchedPosition = {
      segmentIndex: 0,
      segmentT: 0,
      point: { x: 0, y: 0 },
      perpendicularDistanceM: 0,
      cumulativeDistanceM: 0,
    };
    const options: MatchOptions = { baseWindowM: 10, windowMarginPerMps: 10, weights: { distance: 1, heading: 0, continuity: 0 } };
    const position = { x: 0, y: 60 };

    const resultSlow = matchPosition(geometry, input({ position, speedMps: 0, previousMatch }), options);
    // Venster = 10m: segment 1 (start bij cumulatief 15) valt erbuiten -> alleen segment 0 kandidaat.
    expect(resultSlow!.segmentIndex).toBe(0);
    expect(resultSlow!.cumulativeDistanceM).toBeCloseTo(15, 6); // geclampt aan het einde van segment 0

    const resultFast = matchPosition(geometry, input({ position, speedMps: 1, previousMatch }), options);
    // Venster = 10 + 1*10 = 20m: segment 1 wordt nu kandidaat en wint terecht (exacte match, afstand 0).
    expect(resultFast!.segmentIndex).toBe(1);
    expect(resultFast!.perpendicularDistanceM).toBeCloseTo(0, 6);
    expect(resultFast!.cumulativeDistanceM).toBeCloseTo(60, 6);
  });
});

describe("matchPosition — kern-testcase: parallelle trajecten, niet zomaar de geometrisch dichtstbijzijnde lijn", () => {
  // Een "haarspeldbocht"-geometrie: het heentraject (segment 0) en het retourtraject
  // (segment 2) lopen maar 10m uit elkaar EN liggen dicht bij elkaar in cumulatieve
  // afstand (binnen eenzelfde, realistisch venster) -- precies het scenario waarin
  // pure afstandsmatching zou kunnen falen.
  //
  //   (0,0) ──segment 0──> (0,100) ──segment 1──> (10,100) ──segment 2──> (10,0)
  //
  const geometry: Point[] = [
    { x: 0, y: 0 },
    { x: 0, y: 100 }, // segment 0: naar het noorden
    { x: 10, y: 100 }, // segment 1: korte connector naar het oosten
    { x: 10, y: 0 }, // segment 2: terug naar het zuiden, 10m van segment 0
  ];

  const previousMatch: MatchedPosition = {
    segmentIndex: 0,
    segmentT: 0.8,
    point: { x: 0, y: 80 },
    perpendicularDistanceM: 0,
    cumulativeDistanceM: 80,
  };

  // Positie die geometrisch iets DICHTER bij het (verkeerde) retourtraject ligt
  // (4.5m) dan bij het heentraject (5.5m) -- een pure "dichtstbijzijnde lijn"-matcher
  // zou hier het verkeerde segment kiezen.
  const ambiguousPosition = { x: 5.5, y: 80 };

  it("een gewicht dat ALLEEN afstand meeweegt, kiest de geometrisch dichtstbijzijnde (verkeerde) lijn", () => {
    const distanceOnlyOptions: MatchOptions = {
      baseWindowM: 100, // ruim genoeg zodat beide segmenten kandidaat zijn -- de test isoleert het scoregedrag, niet het venster
      windowMarginPerMps: 0,
      weights: { distance: 1, heading: 0, continuity: 0 },
    };
    const result = matchPosition(geometry, input({ position: ambiguousPosition, previousMatch }), distanceOnlyOptions);
    // Bevestigt de aanname die de multi-signal-aanpak rechtvaardigt: puur op afstand
    // wordt hier het retourtraject (segment 2, 4.5m) gekozen -- de verkeerde tak.
    expect(result!.segmentIndex).toBe(2);
  });

  it("heading + continuiteit corrigeren dit: de correcte tak (segment 0) wordt gekozen ondanks de kleinere afstand van segment 2", () => {
    const combinedOptions: MatchOptions = {
      baseWindowM: 100,
      windowMarginPerMps: 0,
      weights: { distance: 1, heading: 0.1, continuity: 0.5 },
    };
    // Rider beweegt noordwaarts (bearing 0°) -- consistent met voortzetting van segment 0,
    // tegengesteld aan de richting van segment 2 (bearing 180°, zuidwaarts).
    const result = matchPosition(
      geometry,
      input({ position: ambiguousPosition, headingDeg: 0, previousMatch }),
      combinedOptions
    );
    expect(result!.segmentIndex).toBe(0);
    expect(result!.cumulativeDistanceM).toBeCloseTo(80, 6); // sluit vloeiend aan op de vorige match (80m), geen sprong
  });

  it("continuïteit alleen (geen heading-signaal) is al voldoende om de juiste tak te kiezen in dit scenario", () => {
    const continuityOnlyOptions: MatchOptions = {
      baseWindowM: 100,
      windowMarginPerMps: 0,
      weights: { distance: 1, heading: 0, continuity: 0.5 },
    };
    const result = matchPosition(
      geometry,
      input({ position: ambiguousPosition, headingDeg: null, previousMatch }), // geen heading beschikbaar
      continuityOnlyOptions
    );
    expect(result!.segmentIndex).toBe(0);
  });

  it("bij een exacte afstandsgelijkstand beslissen heading + continuïteit ondubbelzinnig", () => {
    const tiedPosition = { x: 5, y: 80 }; // exact 5m van beide trajecten
    const combinedOptions: MatchOptions = {
      baseWindowM: 100,
      windowMarginPerMps: 0,
      weights: { distance: 1, heading: 0.1, continuity: 0.5 },
    };
    const result = matchPosition(
      geometry,
      input({ position: tiedPosition, headingDeg: 0, previousMatch }),
      combinedOptions
    );
    expect(result!.segmentIndex).toBe(0);
  });
});

describe("matchPosition — headingDeg is nullable (ontwerp sectie 13)", () => {
  it("zonder heading wordt alleen op afstand + continuïteit gescoord, geen crash, geen straf", () => {
    const geometry: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const result = matchPosition(geometry, input({ position: { x: 3, y: 50 }, headingDeg: null }), DEFAULT_OPTIONS);
    expect(result).not.toBeNull();
    expect(result!.perpendicularDistanceM).toBeCloseTo(3, 6);
  });
});

describe("matchPosition — continuïteit zonder vorige match", () => {
  it("bij de eerste match (previousMatch = null) is er geen continuïteitsstraf, ongeacht het continuity-gewicht", () => {
    const geometry: Point[] = [{ x: 0, y: 0 }, { x: 0, y: 100 }];
    const highContinuityWeight: MatchOptions = { baseWindowM: 100, windowMarginPerMps: 0, weights: { distance: 1, heading: 0, continuity: 1000 } };
    const result = matchPosition(geometry, input({ position: { x: 2, y: 50 }, previousMatch: null }), highContinuityWeight);
    expect(result).not.toBeNull();
    expect(result!.cumulativeDistanceM).toBeCloseTo(50, 6);
  });
});
