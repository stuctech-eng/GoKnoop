import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/read-nwb-connectors?nwbDatasetVersionId=...&datasetVersionId=...
 *
 * Gerichte trace, 9-9-2026 (337km-anomalie-onderzoek). Leest de daadwerkelijk
 * OPGESLAGEN productie-connectoren -- niet opnieuw gegenereerd, de exacte set
 * die /api/route/combined ook echt gebruikt.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const nwbDatasetVersionId = req.nextUrl.searchParams.get("nwbDatasetVersionId");
  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!nwbDatasetVersionId || !datasetVersionId) {
    return NextResponse.json({ error: "nwbDatasetVersionId en datasetVersionId zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    const key = `${nwbDatasetVersionId}_${datasetVersionId}`;
    const snap = await db.collection("nwbConnectors").doc(key).collection("connectors").get();
    const connectors = snap.docs.map((d) => d.data() as ValidatedConnectorInput);
    return NextResponse.json({ key, connectorCount: connectors.length, connectors });
  } catch (err) {
    return NextResponse.json(
      { error: "Productie-connectoren lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
