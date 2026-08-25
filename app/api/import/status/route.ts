import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

/**
 * Telt hoeveel sourceNodes/edges daadwerkelijk in Firestore staan voor een
 * datasetVersionId — onafhankelijke controle, los van wat de importer-routes
 * zelf rapporteren (belangrijk na een time-out of onderbroken import).
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

    const [nodesSnap, edgesSnap] = await Promise.all([
      db.collection("sourceNodes").where("datasetVersionId", "==", datasetVersionId).count().get(),
      db.collection("edges").where("datasetVersionId", "==", datasetVersionId).count().get(),
    ]);

    return NextResponse.json({
      datasetVersionId,
      sourceNodesCount: nodesSnap.data().count,
      edgesCount: edgesSnap.data().count,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Tellen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
