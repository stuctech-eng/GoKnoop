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
  let body: {
    originPlaceName?: string;
    originLat?: number;
    originLon?: number;
    destinationPlaceName?: string;
    destinationLat?: number;
    destinationLon?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  // TOEGEVOEGD (koppeling met de hoofd-app, "Fase B"): de bestaande "route naar een adres"-
  // flow gebruikt de live GPS-positie als herkomst, geen getypte plaatsnaam -- optioneel
  // originLat/originLon toestaan om die direct te gebruiken, geen overbodige geocode-stap.
  const { originPlaceName, originLat, originLon, destinationPlaceName, destinationLat, destinationLon } = body;
  const hasOrigin = originPlaceName || (originLat != null && originLon != null);
  const hasDestination = destinationPlaceName || (destinationLat != null && destinationLon != null);
  if (!hasOrigin || !hasDestination) {
    return NextResponse.json(
      { error: "origin (plaatsnaam of lat+lon) en destination (plaatsnaam of lat+lon) zijn verplicht." },
      { status: 400 }
    );
  }

  const origin =
    originLat != null && originLon != null
      ? { lat: originLat, lon: originLon, displayName: "Mijn locatie" }
      : await geocodePlaceName(originPlaceName!);
  if (!origin) {
    return NextResponse.json({ error: `Kon herkomst '${originPlaceName}' niet vinden.`, leg: "origin" }, { status: 404 });
  }

  // TOEGEVOEGD ("aanrijroute naar het beginpunt van een berekende route", 19-9-2026): de
  // bestemming kan nu ook direct als coördinaat gegeven worden -- nodig om naar het EXACTE
  // beginpunt van een al berekende route te routeren, dat is geen adres om te geocoderen.
  const destination =
    destinationLat != null && destinationLon != null
      ? { lat: destinationLat, lon: destinationLon, displayName: "Routestart" }
      : await geocodePlaceName(destinationPlaceName!);
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
