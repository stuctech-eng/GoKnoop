import { NextRequest, NextResponse } from "next/server";
import { geocodePlaceName } from "@/lib/route-engine/geocode";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/location/geocode
 * Body: { placeName }
 * Response: { lat, lon, displayName } | { error }
 *
 * BUGFIX (30-8-2026, "Vercel Runtime Timeout Error" bij parkeerplaats-zoeken, sectie 9.43):
 * `/api/location/resolve` laadt ALTIJD de volledige knooppuntengraaf (11.000+ knooppunten uit
 * Firestore) -- ook wanneer een aanroeper (zoals de parkeerplaats-zoekfunctie) uitsluitend de
 * geocodede coördinaten nodig heeft, geen knooppunt-kandidaten. Op een koude serverless-start
 * kon die onnodige graaf-laadstap samen met de Nominatim-aanroep de 10-seconden-limiet van
 * Vercel's Hobby-plan overschrijden. Dit endpoint doet UITSLUITEND geocoding (geen Firestore/
 * GraphProvider-aanroep) -- veel lichter, voor precies dit soort gebruik.
 */
export async function POST(req: NextRequest) {
  let body: { placeName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { placeName } = body;
  if (!placeName) {
    return NextResponse.json({ error: "placeName is verplicht." }, { status: 400 });
  }

  try {
    const result = await geocodePlaceName(placeName);
    if (!result) {
      return NextResponse.json({ error: `Kon '${placeName}' niet vinden.` }, { status: 404 });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: "Geocoding mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
