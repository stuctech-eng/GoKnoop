import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/activate-nwb-dataset
 *
 * Fase F, 9-9-2026. Bewust een APARTE, expliciete stap t.o.v. de migratie
 * zelf (/api/admin/migrate-nwb-to-production) -- "data staat klaar" en "data
 * is live voor /api/route/combined" zijn twee verschillende beslissingen.
 *
 * Body: { nwbDatasetVersionId }
 *
 * Rollback: roep dit eindpunt simpelweg opnieuw aan met een eerdere
 * nwbDatasetVersionId -- geen data wordt ooit verwijderd (zelfde
 * rollback-mechanisme als het bestaande config/activeDataset voor GoKnoop).
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { nwbDatasetVersionId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { nwbDatasetVersionId } = body;
  if (!nwbDatasetVersionId) {
    return NextResponse.json({ error: "nwbDatasetVersionId is verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();

    const versionSnap = await db.collection("nwbDatasetVersions").doc(nwbDatasetVersionId).get();
    if (!versionSnap.exists) {
      return NextResponse.json({ error: `nwbDatasetVersions/${nwbDatasetVersionId} bestaat niet -- eerst migreren.` }, { status: 404 });
    }

    await db.collection("config").doc("activeNwbDataset").set({
      nwbDatasetVersionId,
      activatedAt: new Date().toISOString(),
    });
    await db.collection("nwbDatasetVersions").doc(nwbDatasetVersionId).update({ status: "active" });

    return NextResponse.json({ ok: true, nwbDatasetVersionId, message: "Geactiveerd -- /api/route/combined gebruikt deze versie nu." });
  } catch (err) {
    return NextResponse.json(
      { error: "Activatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
