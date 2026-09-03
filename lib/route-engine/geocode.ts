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

/**
 * Vertaalt coördinaten naar een herkenbare plaatsnaam (omgekeerde richting van
 * `geocodePlaceName`) -- Nominatim's `/reverse`-endpoint, GEOCODEN sectie 9.34
 * (30-8-2026, "automatische routenaam"). Zelfde gratis dienst, zelfde
 * User-Agent-verplichting.
 *
 * BELANGRIJKE GEBRUIKSGRENS (Nominatim's beleid verbiedt expliciet
 * "systematische" bevragingen, incl. "reverse queries in a grid"): deze
 * functie mag NOOIT voor elk knooppunt van een route worden aangeroepen --
 * uitsluitend voor een klein, zorgvuldig gekozen aantal punten per route
 * (zie `suggestRouteName` in `route-naming.ts`). Nooit in een lus over alle
 * knooppunten van een dataset.
 */
export async function reverseGeocode(lat: number, lon: number): Promise<{ placeName: string } | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: "jsonv2",
    zoom: "14", // "town/village"-niveau -- niet te grof (provincie) of te fijn (straatnaam)
  });

  let res: Response;
  try {
    res = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
      headers: {
        "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app)",
      },
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  let data: { address?: Record<string, string> };
  try {
    data = await res.json();
  } catch {
    return null;
  }

  // Nominatim's address-object heeft geen vast veld voor "de plaatsnaam" -- probeer de
  // meest voorkomende, van specifiek naar algemeen (dorp -> stad -> gemeente).
  const address = data.address;
  if (!address) return null;
  const placeName = address.village ?? address.town ?? address.city ?? address.municipality ?? null;
  return placeName ? { placeName } : null;
}
