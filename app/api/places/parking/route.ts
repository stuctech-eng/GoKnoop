import { NextRequest, NextResponse } from "next/server";
import { PlacesFinder } from "@/lib/places/places-finder";
import { OverpassPlacesAdapter } from "@/lib/places/overpass-places-adapter";

export const maxDuration = 10; // BUGFIX 30-8-2026: Vercel Hobby-plan kapt hoe dan ook af bij 10s, ongeacht wat hier stond -- gecorrigeerd naar de echte limiet.
export const dynamic = "force-dynamic";

/**
 * POST /api/places/parking
 * Body: { lat, lon, radiusM? }
 * Response: { results: PlaceResult[] } | { error, reason }
 *
 * Parkeerplaats-zoekfunctie (sectie 9.42, 30-8-2026) -- vastgelegd/onderzocht in sectie 9.23,
 * nu gebouwd. `radiusM` standaard 1500m, maximaal 3000m (voorkomt te brede/trage aanvragen).
 */
export async function POST(req: NextRequest) {
  let body: { lat?: number; lon?: number; radiusM?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { lat, lon } = body;
  if (lat === undefined || lon === undefined) {
    return NextResponse.json({ error: "lat en lon zijn verplicht." }, { status: 400 });
  }
  const radiusM = Math.min(body.radiusM ?? 1500, 3000);

  try {
    const finder = new PlacesFinder(new OverpassPlacesAdapter());
    const result = await finder.findNearby({ lat, lon }, "parking", radiusM, 5);

    if ("reason" in result) {
      return NextResponse.json({ error: result.message, reason: result.reason }, { status: 502 });
    }

    return NextResponse.json({ results: result });
  } catch (err) {
    return NextResponse.json(
      { error: "Parkeerplaats-zoekopdracht mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
