import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { fetchAllNwbSegmentsInBbox } from "@/lib/nwb-analysis/nwb-client";
import { splitIntoQuadrants, shouldSplit, childTileId, type Bbox } from "@/lib/nwb-analysis/quad-collector";
import { COLLECTOR_REGIONS, regionRootBbox } from "@/lib/nwb-analysis/collector-regions";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const TILES_COLLECTION = "nwbResearchTiles";
const SEGMENTS_PER_CHUNK = 500;

/** Zelfde reden als de eerdere 413-payloadfout bij de routetest: volledige
 * NWB-geometrie (soms tientallen punten per segment) is te veel data om
 * rechtstreeks op te slaan -- hier zou dat tegen Firestore's
 * documentgrootte-limiet (1MB) aanlopen bij grote tegels. Sla daarom alleen
 * de twee eindpunten + vooraf-berekende echte lengte op. */
function toSlim(seg: { id: string; bstCode: string | null; wegnummer: string | null; straatnaam: string | null; coordinates: { x: number; y: number }[] }): SlimNwbSegment {
  let lengthM = 0;
  for (let i = 1; i < seg.coordinates.length; i++) {
    lengthM += Math.hypot(seg.coordinates[i].x - seg.coordinates[i - 1].x, seg.coordinates[i].y - seg.coordinates[i - 1].y);
  }
  return {
    id: seg.id,
    bstCode: seg.bstCode,
    wegnummer: seg.wegnummer,
    straatnaam: seg.straatnaam,
    from: seg.coordinates[0],
    to: seg.coordinates[seg.coordinates.length - 1],
    lengthM,
  };
}

/**
 * POST /api/debug/nwb-collector-tick?region=hilversum|lochem|volendam
 *
 * TIJDELIJKE, éénmalige onderzoeksinfrastructuur (8-9-2026,
 * "achtergrond-verzamelaar"). GEEN productiefeature -- schrijft uitsluitend
 * naar een aparte, duidelijk gemarkeerde Firestore-collectie
 * (nwbResearchTiles), nooit naar bestaande GoKnoop-productiecollecties.
 *
 * Verwerkt ÉÉN wachtende tegel per aanroep (voor herhaald aanroepen vanuit
 * de runner-pagina, zelfde patroon als de Bridge Layer-generator): haalt
 * NWB op voor die tegel, en beslist op basis van afkapping/grootte of de
 * tegel compleet is (opslaan) of verder gesplitst moet worden (4
 * kindtegels aanmaken).
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const regionKey = req.nextUrl.searchParams.get("region");
  const region = regionKey ? COLLECTOR_REGIONS[regionKey] : undefined;
  if (!region) {
    return NextResponse.json({ error: `region-parameter verplicht: ${Object.keys(COLLECTOR_REGIONS).join(", ")}` }, { status: 400 });
  }

  try {
    const db = getDb();
    const tilesRef = db.collection(TILES_COLLECTION);

    // Root-tegel aanmaken als deze regio nog niet begonnen is.
    const rootId = `${regionKey}__root`;
    const rootDoc = await tilesRef.doc(rootId).get();
    if (!rootDoc.exists) {
      const rootBbox = regionRootBbox(region);
      await tilesRef.doc(rootId).set({
        region: regionKey,
        tileId: "root",
        bbox: rootBbox,
        status: "pending",
        depth: 0,
        createdAt: new Date().toISOString(),
      });
    }

    // Eén wachtende tegel pakken.
    const pendingSnap = await tilesRef.where("region", "==", regionKey).where("status", "==", "pending").limit(1).get();

    if (pendingSnap.empty) {
      const [completeCount, splitCount] = await Promise.all([
        tilesRef.where("region", "==", regionKey).where("status", "==", "complete").count().get(),
        tilesRef.where("region", "==", regionKey).where("status", "==", "split").count().get(),
      ]);
      return NextResponse.json({
        region: regionKey,
        done: true,
        message: "Geen wachtende tegels meer -- verzameling compleet voor deze regio.",
        completeTiles: completeCount.data().count,
        splitTiles: splitCount.data().count,
      });
    }

    const tileDoc = pendingSnap.docs[0];
    const tileData = tileDoc.data() as { region: string; tileId: string; bbox: Bbox; depth: number };

    const { segments, pagesRetrieved, truncated } = await fetchAllNwbSegmentsInBbox(tileData.bbox, 4);
    const decision = shouldSplit(tileData.bbox, truncated);

    if (decision.split) {
      const quadrants = splitIntoQuadrants(tileData.bbox);
      const batch = db.batch();
      batch.update(tileDoc.ref, { status: "split", reason: decision.reason, pagesRetrieved, segmentsSeenBeforeSplit: segments.length });
      quadrants.forEach((qBbox, i) => {
        const childId = childTileId(tileData.tileId, i as 0 | 1 | 2 | 3);
        batch.set(tilesRef.doc(`${regionKey}__${childId}`), {
          region: regionKey,
          tileId: childId,
          bbox: qBbox,
          status: "pending",
          depth: tileData.depth + 1,
          parentTileId: tileData.tileId,
          createdAt: new Date().toISOString(),
        });
      });
      await batch.commit();

      return NextResponse.json({
        region: regionKey,
        done: false,
        action: "split",
        tileId: tileData.tileId,
        reason: decision.reason,
        segmentsSeen: segments.length,
        pagesRetrieved,
      });
    }

    // Compleet: segmenten omzetten naar slank formaat en opslaan in stukken
    // (subcollectie), tegel als compleet markeren.
    const slimSegments = segments.map(toSlim);
    const batch = db.batch();
    const chunkCount = Math.ceil(slimSegments.length / SEGMENTS_PER_CHUNK) || 0;
    for (let c = 0; c < chunkCount; c++) {
      const chunk = slimSegments.slice(c * SEGMENTS_PER_CHUNK, (c + 1) * SEGMENTS_PER_CHUNK);
      batch.set(tileDoc.ref.collection("segments").doc(`chunk-${c}`), { segments: chunk });
    }
    batch.update(tileDoc.ref, { status: "complete", segmentCount: slimSegments.length, chunkCount, pagesRetrieved });
    await batch.commit();

    return NextResponse.json({
      region: regionKey,
      done: false,
      action: "complete",
      tileId: tileData.tileId,
      segmentCount: slimSegments.length,
      chunkCount,
      pagesRetrieved,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Verzamel-stap mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
