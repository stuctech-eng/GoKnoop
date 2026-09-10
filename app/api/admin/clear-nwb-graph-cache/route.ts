import { NextRequest, NextResponse } from "next/server";
import { clearGraphCache } from "@/lib/route-engine/cached-nwb-provider";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/clear-nwb-graph-cache
 *
 * Fase L (failure/rollback), 9-9-2026. Sinds Fase K wordt de volledig
 * gebouwde gecombineerde graaf gecached (module-niveau, per warme
 * serverless-instance). Als er ooit foute data wordt gemigreerd en later
 * gecorrigeerd, zou de oude, foute graaf anders pas bij de eerstvolgende
 * herdeploy uit het geheugen verdwijnen.
 *
 * EERLIJKE BEPERKING, niet verzwegen: dit endpoint leegt de cache van de
 * SPECIFIEKE serverless-instance die deze aanvraag toevallig afhandelt.
 * Vercel kan meerdere warme instances tegelijk draaien -- dit is dus
 * best-effort, geen gegarandeerde, atomaire, landelijke cache-invalidatie.
 * Bij twijfel is een herdeploy nog steeds de zekere manier om alle
 * instances te verversen.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const clearedCount = clearGraphCache();
  return NextResponse.json({
    ok: true,
    clearedEntries: clearedCount,
    LET_OP: "Best-effort -- raakt alleen deze serverless-instance. Bij meerdere warme instances kan een volledige herdeploy nodig zijn voor gegarandeerde landelijke invalidatie.",
  });
}
