import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

/**
 * Snel rapport over de matchConfidence-verdeling van edges, via Firestore's
 * count()-aggregatiequery's (geen documenten hoeven opgehaald te worden).
 * Onderscheidt vooral: unmatched_both (edge volledig los van de graph) vs.
 * unmatched_start/unmatched_end (edge deels bruikbaar, één kant ontbreekt).
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
    const base = db.collection("edges").where("datasetVersionId", "==", datasetVersionId);

    const categories = ["matched", "unmatched_start", "unmatched_end", "unmatched_both"] as const;
    const counts = await Promise.all(
      categories.map((c) => base.where("matchConfidence", "==", c).count().get())
    );
    const totalSnap = await base.count().get();

    const result: Record<string, number> = {};
    categories.forEach((c, i) => {
      result[c] = counts[i].data().count;
    });

    const fullyIsolated = result.unmatched_both;
    const partiallyUsable = result.unmatched_start + result.unmatched_end;

    return NextResponse.json({
      datasetVersionId,
      totalEdges: totalSnap.data().count,
      byConfidence: result,
      interpretation: {
        matched: `${result.matched} edges volledig bruikbaar in de graph`,
        partiallyUsable: `${partiallyUsable} edges hebben één werkend eindpunt (dead-end richting het onbekende knooppunt, maar niet volledig geïsoleerd)`,
        fullyIsolated: `${fullyIsolated} edges hebben GEEN enkel gematcht eindpunt — deze dragen niets bij aan de graph-connectiviteit`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Rapport mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
