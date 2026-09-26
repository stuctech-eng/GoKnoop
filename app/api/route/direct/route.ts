import { NextRequest, NextResponse } from "next/server";
import { geocodePlaceName } from "@/lib/route-engine/geocode";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/direct
 * Body: { originPlaceName, destinationPlaceName }
 * Response bij succes: { origin, destination, geometry, distanceM, durationS, steps }
 * Response bij falen: { error, reason?, leg? }
 *
 * TOEGEVOEGD 19-9-2026 ("eerst normale A->B-navigatie via fietspaden laten werken",
 * GO van Te): een VOLLEDIGE, rechtstreekse fietsroute tussen twee adressen, uitsluitend
 * via de bestaande `LocalBikeRouter`/`OpenRouteServiceAdapter` -- GEEN knooppuntennetwerk,
 * GEEN `KnotRouteEngine`, GEEN NWB/connectors/kostenmodel. Bewust een NIEUW, apart
 * endpoint i.p.v. `/api/route/to-destination` uitbreiden: dat endpoint is en blijft de
 * knooppunten+last-mile-hybride (ongewijzigd, zie dat bestand); dit is de eerste, losse
 * bouwsteen voor een echte "normale" modus, nog niet in de hoofd-UI gekoppeld.
 *
 * Hergebruikt bewust de al bestaande, lichte geocoding (`geocodePlaceName`, dezelfde
 * functie als `/api/location/geocode`) -- geen tweede geocoding-implementatie.
 */
export async function POST(req: NextRequest) {
  let body: { originPlaceName?: string; destinationPlaceName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { originPlaceName, destinationPlaceName } = body;
  if (!originPlaceName || !destinationPlaceName) {
    return NextResponse.json({ error: "originPlaceName en destinationPlaceName zijn verplicht." }, { status: 400 });
  }

  const origin = await geocodePlaceName(originPlaceName);
  if (!origin) {
    return NextResponse.json({ error: `Kon herkomst '${originPlaceName}' niet vinden.`, leg: "origin" }, { status: 404 });
  }

  const destination = await geocodePlaceName(destinationPlaceName);
  if (!destination) {
    return NextResponse.json({ error: `Kon bestemming '${destinationPlaceName}' niet vinden.`, leg: "destination" }, { status: 404 });
  }

  let router: LocalBikeRouter;
  try {
    router = new LocalBikeRouter(new OpenRouteServiceAdapter());
  } catch (err) {
    return NextResponse.json(
      { error: "Fietsrouter kon niet gestart worden.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }

  const result = await router.route(
    { lat: origin.lat, lon: origin.lon },
    { lat: destination.lat, lon: destination.lon },
    "cycling",
    { includeSteps: true }
  );

  if ("reason" in result) {
    return NextResponse.json({ error: result.message, reason: result.reason, leg: "route" }, { status: 502 });
  }

  return NextResponse.json({
    origin: { lat: origin.lat, lon: origin.lon, displayName: origin.displayName },
    destination: { lat: destination.lat, lon: destination.lon, displayName: destination.displayName },
    geometry: result.geometry,
    distanceM: result.distanceM,
    durationS: result.durationS,
    steps: result.steps ?? [],
  });
}
