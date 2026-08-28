import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

/**
 * Atomische activatie (Phase 1B ontwerp sectie 8, pipeline-stap 9/10) --
 * ontbrekende laatste stap: config/activeDataset was nooit daadwerkelijk
 * aangemaakt tijdens de Phase 1-import. Nodig vóór de Route Engine tegen de
 * echte dataset kan draaien (die route leest config/activeDataset).
 */

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();

    const versionDoc = await db.collection("datasetVersions").doc(datasetVersionId).get();
    if (!versionDoc.exists) {
      return NextResponse.json({ error: `datasetVersions/${datasetVersionId} bestaat niet.` }, { status: 404 });
    }

    await db.collection("config").doc("activeDataset").set({
      datasetVersionId,
      activatedAt: new Date().toISOString(),
    });

    await db.collection("datasetVersions").doc(datasetVersionId).update({
      status: "active",
    });

    return NextResponse.json({
      datasetVersionId,
      status: "active",
      message: "config/activeDataset bijgewerkt.",
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Activatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
