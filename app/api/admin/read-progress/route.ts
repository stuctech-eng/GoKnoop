import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/read-progress
 *
 * Fase M6/M7-diagnose, 10-9-2026. Leest de door `reportProgress` weggeschreven
 * checkpoints van de MEEST RECENTE run uit -- werkt ONAFHANKELIJK van of de
 * oorspronkelijke aanvraag (bijv. test-knot-leg-isolated) zelf op tijd
 * terugkwam. Draai dit NA een (eventueel getimeoutte) test-aanroep.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "200");
    const snap = await db
      .collection("_diagnostics")
      .doc("progress")
      .collection("runs")
      .doc("latest")
      .collection("checkpoints")
      .orderBy("__name__", "desc")
      .limit(limit)
      .get();

    // Weer chronologisch (oudste eerst) teruggeven voor leesbaarheid, ook al was de QUERY zelf op nieuwste-eerst.
    const checkpoints = snap.docs.map((d) => d.data()).reverse();

    return NextResponse.json({ aantalCheckpoints: checkpoints.length, checkpoints });
  } catch (err) {
    return NextResponse.json(
      { error: "Voortgang lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
