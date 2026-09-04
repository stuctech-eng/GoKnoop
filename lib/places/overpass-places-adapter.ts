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
 */

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";

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
    // BUGFIX (30-8-2026, herhaalde "Vercel Runtime Timeout Error" ook na het verlagen van
    // Overpass' EIGEN queryinterne `[timeout:X]`): dat interne timeout dekt alleen de tijd
    // NADAT Overpass de query daadwerkelijk is gaan uitvoeren -- een trage verbinding,
    // TLS-handshake, of wachtrij aan de kant van Overpass (bevestigd: de publieke server heeft
    // gedocumenteerde, terugkerende beschikbaarheidsproblemen) valt daar NIET onder. Nu een
    // eigen, hard afgedwongen `AbortController`-tijdslimiet (6s) rond de HELE aanvraag --
    // beschermt tegen elke soort traagheid, niet alleen trage query-verwerking, en blijft ruim
    // binnen Vercel Hobby's harde 10s-limiet.
    const query = `[out:json][timeout:5];nwr["amenity"="${category}"](around:${radiusM},${center.lat},${center.lon});out center ${limit};`;

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), 6000);

    let res: Response;
    try {
      res = await fetch(OVERPASS_ENDPOINT, {
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
          ? "Overpass reageerde niet binnen 6 seconden -- de gratis server is soms overbelast. Probeer het opnieuw."
          : `Kon de Overpass-server niet bereiken (${err instanceof Error ? err.message : String(err)}).`,
      };
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (!res.ok) {
      return { reason: "provider_error", message: `Overpass API gaf status ${res.status}.` };
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
