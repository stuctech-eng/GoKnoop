import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const FIRESTORE_BATCH_LIMIT = 450;

/**
 * POST /api/admin/save-nwb-connectors
 *
 * Fase G (connector-generatie), 9-9-2026. Slaat een chunk AL-GEVALIDEERDE
 * (niet-afgewezen, high/lower confidence) connectoren op onder
 * nwbConnectors/{nwbDatasetVersionId}_{datasetVersionId}/connectors/*.
 *
 * Body: { nwbDatasetVersionId, datasetVersionId, connectors: ValidatedConnectorInput[] }
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { nwbDatasetVersionId?: string; datasetVersionId?: string; connectors?: ValidatedConnectorInput[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { nwbDatasetVersionId, datasetVersionId, connectors } = body;
  if (!nwbDatasetVersionId || !datasetVersionId || !connectors) {
    return NextResponse.json({ error: "nwbDatasetVersionId, datasetVersionId en connectors zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    const key = `${nwbDatasetVersionId}_${datasetVersionId}`;

    for (let i = 0; i < connectors.length; i += FIRESTORE_BATCH_LIMIT) {
      const chunk = connectors.slice(i, i + FIRESTORE_BATCH_LIMIT);
      const batch = db.batch();
      for (let j = 0; j < chunk.length; j++) {
        const c = chunk[j];
        const connectorId = `${c.goknoopNodeId}_${c.nwbSegmentId}_${c.nwbEndpoint}`;
        const ref = db.collection("nwbConnectors").doc(key).collection("connectors").doc(connectorId);
        batch.set(ref, c);
      }
      await batch.commit();
    }

    return NextResponse.json({ ok: true, key, connectorsGeschreven: connectors.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Connectoren opslaan mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
