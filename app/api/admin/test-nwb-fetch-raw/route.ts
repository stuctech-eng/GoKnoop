import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/test-nwb-fetch-raw?limit=2000
 *
 * Fase M6/M7-diagnose, 10-9-2026. Meet UITSLUITEND het tempo van het
 * uitlezen van NWB-segment-documenten uit Firestore -- met een LIMIET, om
 * niet weer een volledige 504 te riskeren. Extrapoleerbaar naar de
 * volledige ~144k-collectie.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "2000");
  const timings: Record<string, number> = {};
  const t0 = Date.now();

  try {
    const db = getDb();
    const activeSnap = await db.collection("config").doc("activeNwbDataset").get();
    timings.activeNwbLookup = Date.now() - t0;
    if (!activeSnap.exists) {
      return NextResponse.json({ error: "config/activeNwbDataset bestaat niet.", timings }, { status: 404 });
    }
    const nwbDatasetVersionId = activeSnap.data()!.nwbDatasetVersionId as string;

    const tFetchStart = Date.now();
    const snap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("segments").limit(limit).get();
    timings.firestoreFetchMs = Date.now() - tFetchStart;
    timings.totalMs = Date.now() - t0;

    // Ook de ruwe grootte van de opgehaalde data, ter indicatie.
    const docs = snap.docs.map((d) => d.data());
    const approxBytes = JSON.stringify(docs).length;

    return NextResponse.json({
      ok: true,
      nwbDatasetVersionId,
      gevraagdLimit: limit,
      daadwerkelijkOpgehaald: snap.size,
      approxBytes,
      approxBytesPerDoc: snap.size > 0 ? Math.round(approxBytes / snap.size) : null,
      timings,
      geëxtrapoleerdVoor144000Documenten: {
        geschatteFirestoreFetchMs: snap.size > 0 ? Math.round((timings.firestoreFetchMs / snap.size) * 144000) : null,
        toelichting: "Lineaire extrapolatie -- ruwe indicatie, geen garantie (Firestore-doorvoer kan niet-lineair schalen).",
      },
    });
  } catch (err) {
    timings.totalMs = Date.now() - t0;
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : String(err), timings }, { status: 500 });
  }
}
