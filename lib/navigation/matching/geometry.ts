import { Point } from "../../route-engine/types";

/**
 * Gedeelde polyline-wiskunde (RD New, meter-eenheden). Hergebruikt door zowel
 * de testtrack-builder (implementatiestap 1) als de candidate-matcher
 * (implementatiestap 4) -- geen dubbele implementaties van dezelfde
 * geometrie-berekeningen (TypeScript-regel, ontwerp/Master System sectie 10).
 */

/** Euclidische afstand tussen twee RD-punten, in meter. */
export function distanceBetween(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Lengte van elk segment in de polyline, in volgorde. */
export function segmentLengths(geometry: readonly Point[]): number[] {
  const lengths: number[] = [];
  for (let i = 0; i < geometry.length - 1; i++) {
    lengths.push(distanceBetween(geometry[i], geometry[i + 1]));
  }
  return lengths;
}

/** Cumulatieve afstand vanaf het begin van de polyline tot en met het EINDE van elk segment (index i = einde van segment i). */
export function cumulativeDistances(lengths: readonly number[]): number[] {
  const cum: number[] = [];
  let total = 0;
  for (const len of lengths) {
    total += len;
    cum.push(total);
  }
  return cum;
}

/** Interpoleert het punt op de polyline op `distanceAlongM` vanaf het begin. */
export function pointAtDistance(geometry: readonly Point[], lengths: readonly number[], distanceAlongM: number): Point {
  let remaining = distanceAlongM;
  for (let i = 0; i < lengths.length; i++) {
    const segLen = lengths[i];
    if (remaining <= segLen || i === lengths.length - 1) {
      const t = segLen === 0 ? 0 : Math.min(1, Math.max(0, remaining / segLen));
      const a = geometry[i];
      const b = geometry[i + 1];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= segLen;
  }
  return geometry[geometry.length - 1];
}

/** Bearing (0-360°, 0 = noord, met de klok mee) van punt a naar punt b, in RD-coördinaten (x = oost, y = noord). */
export function bearingDegrees(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Kleinste hoekverschil tussen twee bearings (elk 0-360°), altijd in het bereik [0, 180]. */
export function angleDifferenceDegrees(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Projecteert `point` loodrecht op het lijnsegment [a,b].
 * Retourneert het geprojecteerde punt en t (0..1, geclampt aan het segment --
 * geen extrapolatie voorbij de segment-uiteinden).
 */
export function projectOntoSegment(point: Point, a: Point, b: Point): { point: Point; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lengthSq = abx * abx + aby * aby;
  if (lengthSq === 0) return { point: a, t: 0 };
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const rawT = (apx * abx + apy * aby) / lengthSq;
  const t = Math.min(1, Math.max(0, rawT));
  return { point: { x: a.x + abx * t, y: a.y + aby * t }, t };
}
