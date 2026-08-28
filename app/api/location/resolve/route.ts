import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { resolveFromWgs84, resolveFromPlaceName } from "@/lib/route-engine/location-resolver";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * POST /api/location/resolve
 * Body: { lat, lon } OF { placeName }, optioneel { limit }
 * Response: { candidates: LocationCandidate[], geocodedAs?: string }
 */

export async function POST(req: NextRequest) {
  let body: { lat?: number; lon?: number; placeName?: string; limit?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { lat, lon, placeName, limit = 5 } = body;
  if ((lat === undefined || lon === undefined) && !placeName) {
    return NextResponse.json({ error: "Geef lat+lon of placeName op." }, { status: 400 });
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    if (placeName) {
      const { candidates, geocodedAs } = await resolveFromPlaceName(provider, placeName, limit);
      if (!geocodedAs) {
        return NextResponse.json({ error: `Kon '${placeName}' niet vinden.` }, { status: 404 });
      }
      return NextResponse.json({ candidates, geocodedAs, datasetVersionId });
    }

    const candidates = resolveFromWgs84(provider, lat!, lon!, limit);
    return NextResponse.json({ candidates, datasetVersionId });
  } catch (err) {
    return NextResponse.json(
      { error: "Locatie-resolutie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
