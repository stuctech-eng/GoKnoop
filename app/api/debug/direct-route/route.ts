import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/debug/direct-route
 * Body: { fromDisplayNumber, toDisplayNumber }
 * Response: { attempts: {fromNodeId, toNodeId, result: "ok"|"failed", distanceM?, reason?}[], computeTimeMs }
 *
 * Diagnose-tool (30-8-2026, "Hilversum doet een omweg", sectie 9.52) -- test DIRECT tussen
 * twee weergavenummers, ZONDER geocoding of kandidaat-selectie ertussen. Zoekt knooppunten
 * die het gevraagde weergavenummer hebben (er kunnen duplicaten zijn, al eerder gezien bij
 * "98"/"98" rond Volendam) en test de EERSTE combinatie -- ÉÉN per aanvraag (sectie 9.54:
 * meerdere combinaties tegelijk testen kan zelf traag genoeg zijn om tegen Vercel Hobby's
 * 10s-limiet aan te lopen, als er geen verbinding bestaat en Dijkstra het hele bereikbare
 * netwerkdeel moet doorzoeken). `computeTimeMs` laat zien of de berekening zelf traag was.
 */
export async function POST(req: NextRequest) {
  let body: { fromDisplayNumber?: string; toDisplayNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { fromDisplayNumber, toDisplayNumber } = body;
  if (!fromDisplayNumber || !toDisplayNumber) {
    return NextResponse.json({ error: "fromDisplayNumber en toDisplayNumber zijn verplicht." }, { status: 400 });
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

    const fromNodeIds = provider.getAllNodeIds().filter((id) => provider.getNode(id)?.displayNumber === fromDisplayNumber);
    const toNodeIds = provider.getAllNodeIds().filter((id) => provider.getNode(id)?.displayNumber === toDisplayNumber);

    if (fromNodeIds.length === 0 || toNodeIds.length === 0) {
      return NextResponse.json({
        error: `Weergavenummer niet gevonden: ${fromNodeIds.length === 0 ? fromDisplayNumber : toDisplayNumber}.`,
      }, { status: 404 });
    }

    // BUGFIX (30-8-2026, "Er ging iets mis" bij het testen): een NIET-bestaande verbinding kan
    // Dijkstra dwingen het HELE bereikbare netwerkdeel te doorzoeken voordat "geen route"
    // geconcludeerd wordt -- mogelijk traag genoeg om zelf tegen Vercel Hobby's 10s-limiet aan
    // te lopen (ironisch: het diagnose-tool zou dan precies vastlopen op het probleem dat het
    // probeert te bewijzen). Daarom: ÉÉN combinatie per aanvraag, niet alle tegelijk -- de
    // client kan meerdere aanvragen doen als er duplicaten zijn.
    const fromNodeId = fromNodeIds[0];
    const toNodeId = toNodeIds[0];
    const attempts: { fromNodeId: string; toNodeId: string; result: "ok" | "failed"; distanceM?: number; reason?: string }[] = [];
    const t0 = Date.now();
    const result = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId);
    const computeTimeMs = Date.now() - t0;
    if ("reason" in result) {
      attempts.push({ fromNodeId, toNodeId, result: "failed", reason: result.reason });
    } else {
      attempts.push({ fromNodeId, toNodeId, result: "ok", distanceM: result.distanceM });
    }

    return NextResponse.json({ attempts, fromNodeIdsFound: fromNodeIds.length, toNodeIdsFound: toNodeIds.length, computeTimeMs });
  } catch (err) {
    return NextResponse.json(
      { error: "Diagnose mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
