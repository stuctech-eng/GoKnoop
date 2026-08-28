export type GeocodeResult = { lat: number; lon: number; displayName: string };

/**
 * Vertaalt een plaatsnaam naar coördinaten via Nominatim (OpenStreetMap).
 * Gratis, geen API-key nodig -- wel een duidelijke User-Agent verplicht
 * volgens Nominatim's gebruiksvoorwaarden, en gelimiteerd tot NL.
 */
export async function geocodePlaceName(placeName: string): Promise<GeocodeResult | null> {
  const params = new URLSearchParams({
    q: placeName,
    format: "json",
    countrycodes: "nl",
    limit: "1",
  });

  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: {
      "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app)",
    },
  });

  if (!res.ok) return null;

  const data = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (!data || data.length === 0) return null;

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    displayName: data[0].display_name,
  };
}
