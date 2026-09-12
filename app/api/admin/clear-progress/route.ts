import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/clear-progress
 *
 * De `_diagnostics/progress/runs/latest/checkpoints`-collectie groeit
 * ongelimiteerd (elke reportProgress-aanroep voegt een nieuw document toe,
 * nooit opgeruimd) -- na dagen debuggen bevatte die duizenden documenten,
 * waardoor `read-progress` (zelfs met de nieuwste-eerst-fix) trage, volle
 * responses gaf. Ruimt in batches op (max 500 per aanroep, roep zo nodig
 * herhaald aan).
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();
    const coll = db.collection("_diagnostics").doc("progress").collection("runs").doc("latest").collection("checkpoints");
    const snap = await coll.limit(500).get();

    await Promise.all(snap.docs.map((d) => d.ref.delete()));

    return NextResponse.json({ verwijderd: snap.docs.length, mogelijkMeerOver: snap.docs.length === 500 });
  } catch (err) {
    return NextResponse.json(
      { error: "Opruimen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
