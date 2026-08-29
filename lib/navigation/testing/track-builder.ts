import { Point } from "../../route-engine/types";
import { rdToWgs84 } from "../../route-engine/coordinate-transform";
import { GpsSample } from "../types";

/**
 * Testhulpmiddelen om GpsSample-reeksen te construeren voor de test-eerst-
 * strategie (ontwerp sectie 20). Hoort bij implementatiestap 1 (GPS-
 * simulator) -- zonder een manier om realistische tracks op te bouwen heeft
 * SimulatedGpsSource weinig waarde voor de latere scenario's (route volgen,
 * ruis, aanhoudende afwijking).
 *
 * Bewust GEEN matching/deviation-logica hier -- dat hoort bij latere
 * implementatiestappen (sectie 23, stap 4/6). Dit bestand bouwt alleen
 * GpsSample-reeksen, het interpreteert ze niet.
 */

const METERS_PER_DEGREE_LAT = 111_320; // benadering, voldoende voor testruis/-offsets van enkele meters

function distance(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Interpoleert het punt op de polyline op `distanceAlongM` vanaf het begin. */
function pointAtDistance(geometry: readonly Point[], segmentLengths: readonly number[], distanceAlongM: number): Point {
  let remaining = distanceAlongM;
  for (let i = 0; i < segmentLengths.length; i++) {
    const segLen = segmentLengths[i];
    if (remaining <= segLen || i === segmentLengths.length - 1) {
      const t = segLen === 0 ? 0 : Math.min(1, remaining / segLen);
      const a = geometry[i];
      const b = geometry[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segLen;
  }
  return geometry[geometry.length - 1];
}

export type BuildTrackOptions = {
  /** M/s, constante snelheid over het hele traject (MVP: geen versnelling/vertraging). */
  speedMps: number;
  /** Seconden tussen twee samples. */
  sampleIntervalS: number;
  /** Epoch ms van de eerste sample. */
  startTimestamp: number;
  /** Nauwkeurigheid voor elke sample. Standaard 5m. */
  accuracyM?: number;
};

/**
 * Bouwt een GpsSample-reeks die exact een gegeven RD-lijngeometrie volgt, op
 * constante snelheid. Basis voor scenario 1 uit de test-eerst-strategie
 * (ontwerp sectie 20): "een fietser die exact de route volgt".
 *
 * Bewust geen versnelling/vertraging-model (MVP) -- een latere test kan dat
 * toevoegen zonder deze functie te wijzigen.
 */
export function buildTrackAlongGeometry(geometry: readonly Point[], options: BuildTrackOptions): GpsSample[] {
  if (geometry.length < 2) return [];

  const segmentLengths: number[] = [];
  let totalLengthM = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    const len = distance(geometry[i], geometry[i + 1]);
    segmentLengths.push(len);
    totalLengthM += len;
  }
  if (totalLengthM === 0) return [];

  const totalDurationS = totalLengthM / options.speedMps;
  const sampleCount = Math.max(1, Math.floor(totalDurationS / options.sampleIntervalS) + 1);

  const samples: GpsSample[] = [];
  for (let i = 0; i < sampleCount; i++) {
    const elapsedS = i * options.sampleIntervalS;
    const distanceAlongM = Math.min(elapsedS * options.speedMps, totalLengthM);
    const point = pointAtDistance(geometry, segmentLengths, distanceAlongM);
    const wgs84 = rdToWgs84(point.x, point.y);
    samples.push({
      lat: wgs84.lat,
      lon: wgs84.lon,
      accuracyM: options.accuracyM ?? 5,
      headingDeg: null, // koers wordt pas in een latere implementatiestap afgeleid (ontwerp sectie 13)
      speedMps: options.speedMps,
      timestamp: options.startTimestamp + elapsedS * 1000,
    });
  }
  return samples;
}

/**
 * Simpele, deterministische PRNG (mulberry32) -- bewust GEEN Math.random().
 * Elke testrun moet exact hetzelfde resultaat geven (ontwerp sectie 20/21),
 * anders is een falende test niet reproduceerbaar te onderzoeken.
 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type AddNoiseOptions = {
  /** Max. laterale afwijking in meter, willekeurig per sample binnen [-max, max]. */
  maxOffsetM: number;
  /** Seed voor de deterministische PRNG. Standaard 42 (vaste waarde = reproduceerbaar). */
  seed?: number;
};

/**
 * Voegt kleine, deterministische laterale ruis toe aan een bestaande track --
 * scenario 2 uit de test-eerst-strategie (ontwerp sectie 20): GPS-ruis die
 * NIET tot OFF_ROUTE/herberekening mag leiden (ontwerp sectie 11).
 *
 * Willekeurige richting per sample (in tegenstelling tot `offsetSubrange`,
 * die een vaste richting gebruikt) -- dat is precies het verschil tussen
 * "ruis" en "een bewuste, aanhoudende afwijking".
 */
export function addNoise(track: readonly GpsSample[], options: AddNoiseOptions): GpsSample[] {
  const rand = mulberry32(options.seed ?? 42);
  return track.map((sample) => {
    const offsetM = (rand() * 2 - 1) * options.maxOffsetM;
    const bearingRad = rand() * 2 * Math.PI;
    const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((sample.lat * Math.PI) / 180);
    return {
      ...sample,
      lat: sample.lat + (offsetM * Math.cos(bearingRad)) / METERS_PER_DEGREE_LAT,
      lon: sample.lon + (offsetM * Math.sin(bearingRad)) / metersPerDegreeLon,
    };
  });
}

export type OffsetRangeOptions = {
  /** Inclusief. */
  startIndex: number;
  /** Exclusief. */
  endIndex: number;
  /** Laterale verschuiving in meter, één vaste richting (geen willekeur). */
  offsetM: number;
};

/**
 * Verschuift een aaneengesloten deel van de track lateraal met een vaste
 * afstand -- scenario 3 uit de test-eerst-strategie (ontwerp sectie 20): een
 * bewuste, aanhoudende afwijking simuleren (bijv. een parallelle straat), in
 * tegenstelling tot `addNoise`'s willekeurige, kortstondige ruis.
 */
export function offsetSubrange(track: readonly GpsSample[], options: OffsetRangeOptions): GpsSample[] {
  return track.map((sample, i) => {
    if (i < options.startIndex || i >= options.endIndex) return sample;
    const metersPerDegreeLon = METERS_PER_DEGREE_LAT * Math.cos((sample.lat * Math.PI) / 180);
    // Vaste richting (oost/west) -- voldoende voor een gecontroleerd testscenario,
    // geen poging om een realistische "parallelle weg"-geometrie na te bootsen.
    return {
      ...sample,
      lon: sample.lon + options.offsetM / metersPerDegreeLon,
    };
  });
}
