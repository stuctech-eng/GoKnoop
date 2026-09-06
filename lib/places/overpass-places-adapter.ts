import type { LatLon, PlaceResult, PlacesProviderError, PlacesProvider } from "./places-provider";

/**
 * OverpassPlacesAdapter -- concrete `PlacesProvider`-implementatie voor de
 * Overpass API (OpenStreetMap), sectie 9.42. Gratis, geen API-key nodig --
 * geverifieerd (webzoekopdracht, 30-8-2026): ~10.000 aanvragen/dag zachte
 * richtlijn op de publieke server, 2 gelijktijdige aanvragen per IP.
 *
 * Query-vorm bevestigd via webzoekopdracht naar echte, werkende voorbeelden
 * (niet uit het geheugen gegokt): `nwr["amenity"="parking"](around:R,LAT,LON)`
 * -- `nwr` (node/way/relation) i.p.v. alleen `node`, want parkeerterreinen
 * staan vaak als vlak (way) in OSM, niet als los punt. `out center` geeft een
 * representatief punt terug voor ways/relations (die hebben geen directe
 * lat/lon).
 *
 * MIRROR-TERUGVAL (30-8-2026, na een ECHTE, herhaalde timeout op de hoofd-
 * server): `overpass.kumi.systems` is een gevestigde, onafhankelijk beheerde
 * alternatieve Overpass-spiegel (bevestigd via meerdere onafhankelijke
 * bronnen -- GitHub-issues, R-package-documentatie, OSM-communityblogs).
 * Geen CORS-probleem hier (dat speelt alleen bij browser-JS; dit draait
 * server-side in een Next.js API-route). Beide pogingen krijgen een kortere
 * (4s) individuele tijdslimiet dan voorheen (was 6s) zodat TWEE pogingen
 * samen (4+4=8s) ruim binnen Vercel Hobby's harde 10s-limiet blijven.
 */

const OVERPASS_ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const PER_ATTEMPT_TIMEOUT_MS = 4000;

/** Haversine-afstand in meters -- puur voor het sorteren/tonen van resultaten, geen routing. */
function haversineDistanceM(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

type OverpassElement = {
  type: "node" | "way" | "relation";
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: { name?: string };
};

export class OverpassPlacesAdapter implements PlacesProvider {
  async findNearby(center: LatLon, category: "parking", radiusM: number, limit: number): Promise<PlaceResult[] | PlacesProviderError> {
    let lastError: PlacesProviderError = { reason: "provider_error", message: "Geen enkele Overpass-server reageerde op tijd." };

    for (const endpoint of OVERPASS_ENDPOINTS) {
      const result = await this.attemptFindNearby(endpoint, center, category, radiusM, limit);
      if (!("reason" in result)) return result; // eerste succesvolle poging wint
      lastError = result;
    }

    return lastError;
  }

  private async attemptFindNearby(
    endpoint: string,
    center: LatLon,
    category: "parking",
    radiusM: number,
    limit: number
  ): Promise<PlaceResult[] | PlacesProviderError> {
    const query = `[out:json][timeout:3];nwr["amenity"="${category}"](around:${radiusM},${center.lat},${center.lon});out center ${limit};`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), PER_ATTEMPT_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
    } catch (err) {
      const isTimeout = err instanceof Error && err.name === "AbortError";
      return {
        reason: "provider_error",
        message: isTimeout
          ? `${endpoint} reageerde niet binnen ${PER_ATTEMPT_TIMEOUT_MS / 1000} seconden.`
          : `Kon ${endpoint} niet bereiken (${err instanceof Error ? err.message : String(err)}).`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      return {
        reason: "provider_error",
        message:
          res.status === 429
            ? `${endpoint} geeft momenteel "te veel aanvragen" (429) -- waarschijnlijk tijdelijk, probeer het over een minuutje opnieuw.`
            : `${endpoint} gaf status ${res.status}.`,
      };
    }

    let data: { elements?: OverpassElement[] };
    try {
      data = await res.json();
    } catch {
      return { reason: "invalid_response", message: "Overpass-respons kon niet als JSON gelezen worden." };
    }

    const elements = data.elements ?? [];
    const results: PlaceResult[] = [];
    for (const el of elements) {
      const point = el.type === "node" ? (el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lon: el.lon } : null) : (el.center ?? null);
      if (!point) continue;
      results.push({
        name: el.tags?.name ?? null,
        lat: point.lat,
        lon: point.lon,
        distanceM: haversineDistanceM(center, point),
      });
    }

    results.sort((a, b) => a.distanceM - b.distanceM);
    return results.slice(0, limit);
  }
}
