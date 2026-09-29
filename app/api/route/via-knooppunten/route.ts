import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { resolveFromWgs84 } from "@/lib/route-engine/location-resolver";
import { geocodePlaceName } from "@/lib/route-engine/geocode";
import { routeViaKnooppunten } from "@/lib/route-engine/route-via-knooppunten";

// Ruimte voor meerdere sequentiële ORS-aanroepen (~1,6s pauze + responstijd per NIEUW
// segment, cache-hits zijn nagenoeg instant) -- 60s is de bevestigde Vercel Hobby-limiet
// zonder Fluid Compute (zie eerdere, geverifieerde correctie op de vroegere 10s-aanname).
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * POST /api/route/via-knooppunten
 * Body: { originPlaceName, destinationPlaceName }
 * Response bij succes: { nodeIds, displayNumbers, geometry, distanceM, durationS, steps, segmentSources }
 * Response bij falen: { error, reason?, ... }
 *
 * "Functie 2" (19-9-2026, GO + overleg met Te): kortste knooppuntvolgorde (pure,
 * NWB-vrije Dijkstra) + per tussenstap de echte-fietspad-motor (functie 1, ORS,
 * met permanente Firestore-cache) -- zie `lib/route-engine/route-via-knooppunten.ts`
 * voor de volledige toelichting/ontwerpbeslissingen. NIEUW, LOS endpoint --
 * `/api/route/to-destination` (het oude NWB/connector-systeem) blijft ongewijzigd
 * ernaast bestaan, wordt hier niet aangeraakt.
 *
 * UITGEBREID (landelijke connected-components-analyse: 1.111 losse componenten in de
 * pure knooppuntengraaf): als de gevonden knooppuntvolgorde ergens een onredelijke omweg
 * blijkt, wordt NIET de hele reis naar functie 1 teruggeworpen -- verdeel-en-heers
 * (`planSegments()`) isoleert het kleinst mogelijke, coherente omweg-stuk en overbrugt
 * uitsluitend dát rechtstreeks; de rest van de reis blijft gewoon via de knooppunten
 * lopen. Zichtbaar in de response via `usedDirectFallback`/`bridgedSpans`/`overallDetourRatio`.
 *
 * Gebruikt bewust de LICHTE `CachedGraphProvider` (uitsluitend het officiële
 * knooppuntennetwerk uit Firestore) -- GEEN `loadPrecomputedOrBuildGraph`/NWB-laag.
 */
export async function POST(req: NextRequest) {
  let body: { originPlaceName?: string; originLat?: number; originLon?: number; destinationPlaceName?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  // Zelfde reden als bij functie 1 (/api/route/direct): de hoofd-app geeft de live
  // GPS-positie mee, geen getypte plaatsnaam.
  const { originPlaceName, originLat, originLon, destinationPlaceName } = body;
  if ((!originPlaceName && (originLat == null || originLon == null)) || !destinationPlaceName) {
    return NextResponse.json(
      { error: "originPlaceName (of originLat+originLon) en destinationPlaceName zijn verplicht." },
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
  const destination = await geocodePlaceName(destinationPlaceName);
  if (!destination) {
    return NextResponse.json({ error: `Kon bestemming '${destinationPlaceName}' niet vinden.`, leg: "destination" }, { status: 404 });
  }

  const db = getDb();
  const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
  if (!activeDatasetSnap.exists) {
    return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
  }
  const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

  const provider = new CachedGraphProvider(datasetVersionId);
  await provider.load();

  const originCandidates = resolveFromWgs84(provider, origin.lat, origin.lon, 1);
  const destinationCandidates = resolveFromWgs84(provider, destination.lat, destination.lon, 1);
  if (originCandidates.length === 0) {
    return NextResponse.json({ error: "Geen bruikbaar knooppunt gevonden bij de herkomst.", leg: "origin" }, { status: 404 });
  }
  if (destinationCandidates.length === 0) {
    return NextResponse.json({ error: "Geen bruikbaar knooppunt gevonden bij de bestemming.", leg: "destination" }, { status: 404 });
  }

  const result = await routeViaKnooppunten(
    provider,
    datasetVersionId,
    originCandidates[0].logicalNodeId,
    destinationCandidates[0].logicalNodeId
  );

  if ("reason" in result) {
    if (result.reason === "too_many_knooppunten") {
      // 422, geen serverfout: een bewust geweigerde, te lange reeks -- de volgorde zelf komt
      // gewoon mee voor inspectie (zie de toelichting in route-via-knooppunten.ts).
      return NextResponse.json(
        { error: `Te veel knooppunten (${result.knooppuntenCount}, limiet ${result.limit}).`, ...result },
        { status: 422 }
      );
    }
    return NextResponse.json({ error: result.message, ...result }, { status: 502 });
  }

  return NextResponse.json({
    origin: { lat: origin.lat, lon: origin.lon, displayName: origin.displayName },
    destination: { lat: destination.lat, lon: destination.lon, displayName: destination.displayName },
    ...result,
  });
}
