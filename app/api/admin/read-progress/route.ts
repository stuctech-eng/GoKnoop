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
 *
 * TOEGEVOEGD 18-9-2026: optioneel `&contains=<tekst>` filtert de checkpoints
 * (case-insensitive, op checkpoint-label EN op requestId) -- puur leesgemak,
 * de log zelf wordt niet gewijzigd. Aanleiding: de volledige log werd te
 * lang om in één keer te plakken/kopiëren op een telefoon.
 * Optioneel `&limit=<n>` beperkt het aantal teruggegeven checkpoints (meest
 * recente eerst) -- standaard alles, net als voorheen.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const contains = req.nextUrl.searchParams.get("contains");
  const limitParam = req.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.max(1, parseInt(limitParam, 10) || Infinity) : undefined;

  try {
    const db = getDb();
    const snap = await db
      .collection("_diagnostics")
      .doc("progress")
      .collection("runs")
      .doc("latest")
      .collection("checkpoints")
      .get();

    let checkpoints = snap.docs.map((d) => d.data());

    if (contains) {
      const needle = contains.toLowerCase();
      checkpoints = checkpoints.filter((c) => {
        const label = typeof c.checkpoint === "string" ? c.checkpoint.toLowerCase() : "";
        const requestId = typeof c.requestId === "string" ? c.requestId.toLowerCase() : "";
        return label.includes(needle) || requestId.includes(needle);
      });
    }

    if (limit !== undefined) {
      checkpoints = checkpoints.slice(-limit); // meest recente `limit` stuks
    }

    return NextResponse.json({ aantalCheckpoints: checkpoints.length, checkpoints });
  } catch (err) {
    return NextResponse.json(
      { error: "Voortgang lezen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
