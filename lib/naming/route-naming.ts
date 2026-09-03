/**
 * Automatische, herkenbare routenaam (GOKNOOP-MASTER.md sectie 9.34,
 * 30-8-2026) -- op basis van plaatsnamen langs de route, via Nominatim's
 * reverse-geocoding (`reverseGeocode`, `lib/route-engine/geocode.ts`).
 *
 * BELANGRIJKE GRENS: Nominatim's gebruiksbeleid verbiedt expliciet
 * "systematische" bevragingen. Deze module kiest daarom UITSLUITEND een
 * klein, vast aantal punten (2) uit de route-geometrie -- nooit een
 * bevraging per knooppunt.
 */

import type { Point } from "@/lib/route-engine/types";

/**
 * Kiest twee representatieve punten uit de route-geometrie voor naamgeving:
 * het beginpunt, en het punt dat er (hemelsbreed) het VERST vandaan ligt --
 * meestal de "overkant" van een rondje, wat een naam als "Edam -- Volendam"
 * oplevert i.p.v. twee keer bijna dezelfde plek.
 *
 * Puur, geen netwerkaanroep -- alleen het KIEZEN van de punten.
 */
export function pickNamingPoints(geometry: readonly Point[]): [Point, Point] | null {
  if (geometry.length === 0) return null;
  if (geometry.length === 1) return [geometry[0], geometry[0]];

  const start = geometry[0];
  let farthest = geometry[0];
  let farthestDistSq = -1;
  for (const p of geometry) {
    const distSq = (p.x - start.x) ** 2 + (p.y - start.y) ** 2;
    if (distSq > farthestDistSq) {
      farthestDistSq = distSq;
      farthest = p;
    }
  }
  return [start, farthest];
}

/**
 * Bouwt een naam uit 1 of 2 plaatsnamen (het resultaat van `reverseGeocode`
 * op de gekozen punten, sectie hierboven). Puur, geen netwerkaanroep.
 */
export function buildNameFromPlaces(places: (string | null)[]): string | null {
  const unique = Array.from(new Set(places.filter((p): p is string => p !== null)));
  if (unique.length === 0) return null;
  if (unique.length === 1) return `Rondje ${unique[0]}`;
  return unique.join(" -- ");
}

/**
 * Maakt een voorgestelde naam UNIEK binnen de bestaande, al opgeslagen
 * namen -- probeert eerst gewoon de naam, dan "(2)"/"(3)"/... als die al
 * bestaat. Puur, geen netwerkaanroep.
 */
export function makeNameUnique(proposedName: string, existingNames: readonly string[]): string {
  const existingSet = new Set(existingNames);
  if (!existingSet.has(proposedName)) return proposedName;
  let attempt = 2;
  while (existingSet.has(`${proposedName} (${attempt})`)) {
    attempt++;
  }
  return `${proposedName} (${attempt})`;
}
