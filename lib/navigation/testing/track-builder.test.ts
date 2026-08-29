import { describe, it, expect } from "vitest";
import { buildTrackAlongGeometry, addNoise, offsetSubrange } from "./track-builder";
import { rdToWgs84, wgs84ToRd } from "../../route-engine/coordinate-transform";
import type { Point } from "../../route-engine/types";

/** RD-afstand tussen twee WGS84-punten (via terugconversie), voor testcontroles op meterschaal. */
function rdDistance(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rdA = wgs84ToRd(a.lat, a.lon);
  const rdB = wgs84ToRd(b.lat, b.lon);
  return Math.sqrt((rdA.x - rdB.x) ** 2 + (rdA.y - rdB.y) ** 2);
}

// Een simpele, 1000m lange rechte lijn in RD New (ergens rond Utrecht), voor voorspelbare tests.
const START: Point = { x: 136000, y: 456000 };
const END: Point = { x: 137000, y: 456000 };

describe("buildTrackAlongGeometry", () => {
  it("geeft een lege reeks bij minder dan 2 punten", () => {
    expect(buildTrackAlongGeometry([], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 })).toEqual([]);
    expect(buildTrackAlongGeometry([START], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 })).toEqual([]);
  });

  it("geeft een lege reeks als de geometrie geen lengte heeft (identieke punten)", () => {
    const result = buildTrackAlongGeometry([START, START], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 });
    expect(result).toEqual([]);
  });

  it("de eerste sample staat op het startpunt, met de opgegeven starttijd en snelheid", () => {
    const track = buildTrackAlongGeometry([START, END], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 5000 });
    expect(track.length).toBeGreaterThan(0);

    const expectedStart = rdToWgs84(START.x, START.y);
    expect(track[0].lat).toBeCloseTo(expectedStart.lat, 6);
    expect(track[0].lon).toBeCloseTo(expectedStart.lon, 6);
    expect(track[0].timestamp).toBe(5000);
    expect(track[0].speedMps).toBe(5);
    expect(track[0].headingDeg).toBeNull(); // koers pas in een latere implementatiestap (ontwerp sectie 13)
  });

  it("de laatste sample ligt dicht bij het eindpunt (binnen één sample-interval se afstand)", () => {
    const speedMps = 5;
    const sampleIntervalS = 10;
    const track = buildTrackAlongGeometry([START, END], { speedMps, sampleIntervalS, startTimestamp: 0 });

    const last = track[track.length - 1];
    const expectedEnd = rdToWgs84(END.x, END.y);
    const gapM = rdDistance(last, expectedEnd);

    // De laatste sample kan tot één sample-stap vóór het eindpunt liggen
    // (geen extrapolatie voorbij de laatste emitted sample) -- vandaar deze marge.
    expect(gapM).toBeLessThanOrEqual(speedMps * sampleIntervalS + 1);
  });

  it("timestamps lopen consistent op met sampleIntervalS", () => {
    const track = buildTrackAlongGeometry([START, END], { speedMps: 4, sampleIntervalS: 15, startTimestamp: 1000 });
    for (let i = 1; i < track.length; i++) {
      expect(track[i].timestamp - track[i - 1].timestamp).toBe(15000);
    }
  });

  it("positie beweegt monotoon in de richting van het eindpunt (geen sprongen terug)", () => {
    const track = buildTrackAlongGeometry([START, END], { speedMps: 5, sampleIntervalS: 20, startTimestamp: 0 });
    for (let i = 1; i < track.length; i++) {
      // Traject loopt puur in x-richting (START/END hebben gelijke y) -- lon moet dus monotoon stijgen.
      expect(track[i].lon).toBeGreaterThanOrEqual(track[i - 1].lon);
    }
  });

  it("gebruikt de standaard accuracyM (5) als er geen wordt opgegeven, anders de opgegeven waarde", () => {
    const withDefault = buildTrackAlongGeometry([START, END], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 });
    expect(withDefault[0].accuracyM).toBe(5);

    const withCustom = buildTrackAlongGeometry([START, END], {
      speedMps: 5,
      sampleIntervalS: 10,
      startTimestamp: 0,
      accuracyM: 12,
    });
    expect(withCustom[0].accuracyM).toBe(12);
  });

  it("volgt ook een geometrie met meerdere segmenten (geknikte lijn), niet alleen een rechte", () => {
    const bend: Point = { x: 136500, y: 456500 };
    const track = buildTrackAlongGeometry([START, bend, END], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 });
    expect(track.length).toBeGreaterThan(0);
    const last = track[track.length - 1];
    const expectedEnd = rdToWgs84(END.x, END.y);
    expect(rdDistance(last, expectedEnd)).toBeLessThan(500); // ruime marge, alleen testen dat het einde genaderd wordt
  });
});

describe("addNoise", () => {
  const baseTrack = buildTrackAlongGeometry([START, END], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 });

  it("is deterministisch: dezelfde seed geeft exact hetzelfde resultaat", () => {
    const a = addNoise(baseTrack, { maxOffsetM: 8, seed: 7 });
    const b = addNoise(baseTrack, { maxOffsetM: 8, seed: 7 });
    expect(a).toEqual(b);
  });

  it("een andere seed geeft (met overweldigende waarschijnlijkheid) een ander resultaat", () => {
    const a = addNoise(baseTrack, { maxOffsetM: 8, seed: 1 });
    const b = addNoise(baseTrack, { maxOffsetM: 8, seed: 2 });
    expect(a).not.toEqual(b);
  });

  it("houdt elke sample binnen maxOffsetM van de originele positie", () => {
    const noisy = addNoise(baseTrack, { maxOffsetM: 10, seed: 3 });
    for (let i = 0; i < baseTrack.length; i++) {
      const gapM = rdDistance(baseTrack[i], noisy[i]);
      expect(gapM).toBeLessThanOrEqual(10 + 0.01); // kleine marge voor afrondingsfouten in de projectie
    }
  });

  it("wijzigt timestamp/accuracyM/speedMps niet -- alleen de positie", () => {
    const noisy = addNoise(baseTrack, { maxOffsetM: 5, seed: 1 });
    for (let i = 0; i < baseTrack.length; i++) {
      expect(noisy[i].timestamp).toBe(baseTrack[i].timestamp);
      expect(noisy[i].accuracyM).toBe(baseTrack[i].accuracyM);
      expect(noisy[i].speedMps).toBe(baseTrack[i].speedMps);
    }
  });
});

describe("offsetSubrange", () => {
  const baseTrack = buildTrackAlongGeometry([START, END], { speedMps: 5, sampleIntervalS: 10, startTimestamp: 0 });

  it("laat samples buiten het bereik volledig ongewijzigd", () => {
    const shifted = offsetSubrange(baseTrack, { startIndex: 2, endIndex: 4, offsetM: 30 });
    for (let i = 0; i < baseTrack.length; i++) {
      if (i < 2 || i >= 4) {
        expect(shifted[i]).toEqual(baseTrack[i]);
      }
    }
  });

  it("verschuift samples binnen het bereik met ongeveer offsetM, in een vaste richting", () => {
    const shifted = offsetSubrange(baseTrack, { startIndex: 1, endIndex: 3, offsetM: 25 });
    for (const i of [1, 2]) {
      const gapM = rdDistance(baseTrack[i], shifted[i]);
      expect(gapM).toBeGreaterThan(20);
      expect(gapM).toBeLessThan(30);
    }
  });

  it("verschuift alle samples binnen het bereik in dezelfde richting (geen willekeur, in tegenstelling tot addNoise)", () => {
    const shifted = offsetSubrange(baseTrack, { startIndex: 0, endIndex: baseTrack.length, offsetM: 15 });
    // Alle lon-verschuivingen moeten hetzelfde teken hebben.
    const deltas = shifted.map((s, i) => s.lon - baseTrack[i].lon);
    const signs = new Set(deltas.map((d) => Math.sign(d)));
    expect(signs.size).toBe(1);
  });
});
