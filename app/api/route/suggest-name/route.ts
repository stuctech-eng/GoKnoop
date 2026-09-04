import { NextRequest, NextResponse } from "next/server";
import { reverseGeocode } from "@/lib/route-engine/geocode";
import { buildNameFromPlaces } from "@/lib/naming/route-naming";

export const maxDuration = 10; // BUGFIX 30-8-2026: Vercel Hobby-plan kapt hoe dan ook af bij 10s, ongeacht wat hier stond -- gecorrigeerd naar de echte limiet.
export const dynamic = "force-dynamic";

/**
 * POST /api/route/suggest-name
 * Body: { points: {lat, lon}[] } -- ALTIJD maximaal 2 punten (client kiest ze via
 * `pickNamingPoints`, sectie 9.34), nooit meer -- respecteert Nominatim's verbod op
 * systematische bevragingen.
 * Response: { name: string | null }
 *
 * Automatische routenaam (sectie 9.34, 30-8-2026). SEQUENTIEEL (niet parallel) aangeroepen,
 * met een korte pauze ertussen -- Nominatim's gebruiksbeleid staat maximaal 1 aanvraag/seconde
 * toe.
 */
export async function POST(req: NextRequest) {
  let body: { points?: { lat: number; lon: number }[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { points } = body;
  if (!points || points.length === 0) {
    return NextResponse.json({ error: "points is verplicht." }, { status: 400 });
  }
  // Harde grens, ongeacht wat de client stuurt -- nooit meer dan 2 Nominatim-aanvragen per
  // naamsuggestie (sectie 9.34's gebruiksgrens).
  const limitedPoints = points.slice(0, 2);

  try {
    const places: (string | null)[] = [];
    for (const point of limitedPoints) {
      const result = await reverseGeocode(point.lat, point.lon);
      places.push(result?.placeName ?? null);
      // Respecteer Nominatim's 1 aanvraag/seconde-grens tussen de (hooguit 2) aanvragen.
      if (limitedPoints.indexOf(point) < limitedPoints.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1100));
      }
    }
    const name = buildNameFromPlaces(places);
    return NextResponse.json({ name });
  } catch {
    // Best-effort: als naamgeving mislukt, geen harde fout -- de gebruiker kan altijd zelf een
    // naam intypen of de datum-gebaseerde standaardnaam gebruiken.
    return NextResponse.json({ name: null });
  }
}
