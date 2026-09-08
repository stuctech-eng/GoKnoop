import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/bridge-attempt-errors?datasetVersionId=...&scope=strong&limit=10
 *
 * TOEGEVOEGD 7-9-2026, n.a.v. 44/44 opeenvolgende rejected_provider_error --
 * te consistent om zonder de daadwerkelijke, opgeslagen foutmelding
 * (rejectionReason) te blijven gissen naar de oorzaak. Puur lezend.
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
  const scope = req.nextUrl.searchParams.get("scope") ?? "strong";
  const limit = Number(req.nextUrl.searchParams.get("limit") ?? "10");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId-parameter verplicht." }, { status: 400 });
  }

  try {
    const db = getDb();
    const snap = await db
      .collection("generateBridgesAttempts")
      .where("datasetVersionId", "==", datasetVersionId)
      .where("scope", "==", scope)
      .where("validationStatus", "==", "rejected_provider_error")
      .orderBy("validatedAt", "desc")
      .limit(limit)
      .get();

    const attempts = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        sourceNodeId: d.sourceNodeId,
        targetNodeId: d.targetNodeId,
        rejectionReason: d.rejectionReason,
        validatedAt: d.validatedAt,
      };
    });

    return NextResponse.json({ count: attempts.length, attempts });
  } catch (err) {
    return NextResponse.json(
      { error: "Ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
