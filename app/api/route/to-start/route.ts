import { NextRequest, NextResponse } from "next/server";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/to-start
 * Body: { origin: {lat, lon}, destination: {lat, lon} }
 * Response bij succes: { geometry: {lat,lon}[], distanceM, durationS }
 * Response bij falen: { error, reason } (404/502 afhankelijk van het type fout)
 *
 * FASE 4 (GOKNOOP-MASTER.md sectie 9.11/9.12, 30-8-2026) -- HERSCHREVEN,
 * NIET meer additief naast het oude gedrag: dit endpoint routeerde eerder
 * via `computeRouteWithFallback()` (het knooppuntennetwerk zelf, Layer A).
 * Dat was zelf al een noodgreep -- geen straten, alleen knooppunt-edges.
 * Nu vervangen door `LocalBikeRouter` (Layer B, sectie 9.3): een fysiek
 * vertrekpunt (parkeerplaats, of gewoon de live positie) hoeft namelijk
 * helemaal geen knooppunt-kandidaat te zijn -- `LocalBikeRouter` routeert
 * rechtstreeks tussen twee willekeurige GPS-punten via gewone straten.
 *
 * Geen wijziging aan `lib/route-engine/` (Fase 4-eis, sectie 9.12 punt 8):
 * dit bestand importeert er zelfs niets meer uit. De client
 * (`NavigationScreen.tsx`) bepaalt `destination` zelf (de coördinaten van
 * `route.nodes[0]`, al lokaal bekend via `model.geometry[0]`) -- dit
 * endpoint heeft dus geen Firestore/GraphProvider-toegang meer nodig voor
 * deze specifieke aanroep.
 */
export async function POST(req: NextRequest) {
  let body: { origin?: { lat: number; lon: number }; destination?: { lat: number; lon: number } };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { origin, destination } = body;
  if (
    !origin ||
    !destination ||
    typeof origin.lat !== "number" ||
    typeof origin.lon !== "number" ||
    typeof destination.lat !== "number" ||
    typeof destination.lon !== "number"
  ) {
    return NextResponse.json({ error: "origin en destination ({lat, lon}) zijn verplicht." }, { status: 400 });
  }

  try {
    const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
    const result = await router.route(origin, destination, "cycling");

    if ("reason" in result) {
      const status = result.reason === "no_route_found" ? 404 : 502;
      return NextResponse.json({ error: result.message, reason: result.reason }, { status });
    }

    return NextResponse.json(result);
  } catch (err) {
    // Vangt o.a. de "OPENROUTESERVICE_API_KEY ontbreekt"-fout op (constructor van
    // OpenRouteServiceAdapter) -- graceful 500 i.p.v. een onafgevangen crash, zodat de app
    // bruikbaar blijft (fase A valt terug op de hemelsbrede afstand/richting) totdat er een
    // echte ORS-sleutel geconfigureerd is.
    return NextResponse.json(
      { error: "Route-naar-startpunt-berekening mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
