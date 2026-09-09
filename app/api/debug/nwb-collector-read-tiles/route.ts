import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const TILES_COLLECTION = "nwbResearchTiles";
const TILES_PER_PAGE = 10;

/**
 * GET /api/debug/nwb-collector-read-tiles?region=...&offset=0
 *
 * TIJDELIJKE onderzoeksinfrastructuur (9-9-2026). HERZIEN: het vorige
 * finalize-components-eindpunt gaf bij Hilversum (103 tegels) nog steeds een
 * 504, ook na de eerdere prestatiefix -- vermoedelijk omdat 103 tegels
 * TEGELIJK uit Firestore lezen (Promise.all) zelf al te veel is, los van de
 * daaropvolgende berekening. Dit eindpunt leest daarom maar een klein aantal
 * tegels per aanroep (TILES_PER_PAGE), zodat de client dit herhaald kan
 * aanroepen (zelfde patroon als nwb-corridor-tile) en alle segmenten client-
 * side verzamelt, vóórdat de (aparte, snelle) berekening draait.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const regionKey = req.nextUrl.searchParams.get("region");
  if (!regionKey) {
    return NextResponse.json({ error: "region-parameter verplicht." }, { status: 400 });
  }
  const offset = Number(req.nextUrl.searchParams.get("offset") ?? "0");

  try {
    const db = getDb();
    const tilesRef = db.collection(TILES_COLLECTION);

    const [pendingSnap, completeSnap] = await Promise.all([
      tilesRef.where("region", "==", regionKey).where("status", "==", "pending").limit(1).get(),
      tilesRef.where("region", "==", regionKey).where("status", "==", "complete").get(),
    ]);

    if (!pendingSnap.empty) {
      return NextResponse.json({ error: "Verzameling voor deze regio is nog niet compleet." }, { status: 409 });
    }
    if (completeSnap.empty) {
      return NextResponse.json({ error: "Geen complete tegels gevonden voor deze regio." }, { status: 404 });
    }

    const allTileDocs = completeSnap.docs;
    const pageDocs = allTileDocs.slice(offset, offset + TILES_PER_PAGE);

    const segments: SlimNwbSegment[] = [];
    await Promise.all(
      pageDocs.map(async (tileDoc) => {
        const chunksSnap = await tileDoc.ref.collection("segments").get();
        for (const chunkDoc of chunksSnap.docs) {
          const chunkData = chunkDoc.data() as { segments: SlimNwbSegment[] };
          segments.push(...chunkData.segments);
        }
      })
    );

    return NextResponse.json({
      region: regionKey,
      offset,
      tilesInPage: pageDocs.length,
      totalTiles: allTileDocs.length,
      done: offset + TILES_PER_PAGE >= allTileDocs.length,
      segments,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Tegels lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
