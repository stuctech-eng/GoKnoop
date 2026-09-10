import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/migrate-goknoop-batched
 * Body: { datasetVersionId, kind: "nodes"|"edges", batchIndex, items }
 *
 * Fase M6/M7 (GoKnoop-opslagformaat-fix), 10-9-2026. Schrijft ÉÉN chunk weg
 * als ÉÉN document (`goknoopBatched/{datasetVersionId}/{kind}/{batchIndex}`,
 * bevat een array van alle items in die chunk) -- zelfde patroon als de
 * eerder gerepareerde NWB-segment-opslag. Raakt de originele
 * `logicalNodes`/`edges`-collecties op geen enkele manier aan.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { datasetVersionId?: string; kind?: "nodes" | "edges"; batchIndex?: number; items?: unknown[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }

  const { datasetVersionId, kind, batchIndex, items } = body;
  if (!datasetVersionId || (kind !== "nodes" && kind !== "edges") || batchIndex === undefined || !items) {
    return NextResponse.json({ error: "datasetVersionId, kind, batchIndex en items zijn verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    await db
      .collection("goknoopBatched")
      .doc(datasetVersionId)
      .collection(kind)
      .doc(String(batchIndex))
      .set({ items });

    return NextResponse.json({ ok: true, kind, batchIndex, itemsGeschreven: items.length });
  } catch (err) {
    return NextResponse.json(
      { error: "Batch wegschrijven mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
