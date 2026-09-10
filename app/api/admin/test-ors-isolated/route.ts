import { NextRequest, NextResponse } from "next/server";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/test-ors-isolated
 *
 * Fase M6/M7-diagnose, 10-9-2026. Test UITSLUITEND de ORS-last-mile-
 * aanroep, los van graafopbouw of enige andere stap -- isoleert of de
 * ~10s-timeout in /api/route/to-destination hier zit.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const t0 = Date.now();
  let adapterConstructedMs: number | null = null;
  try {
    const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
    adapterConstructedMs = Date.now() - t0;

    // Amsterdam Centraal-omgeving -> een punt 300m verderop (kort, representatief last-mile-stukje).
    const origin = { lat: 52.3791, lon: 4.9003 };
    const destination = { lat: 52.3805, lon: 4.9035 };

    const result = await router.route(origin, destination, "cycling");
    const totalMs = Date.now() - t0;

    if ("reason" in result) {
      return NextResponse.json({ ok: false, adapterConstructedMs, totalMs, reason: result.reason, message: result.message });
    }

    return NextResponse.json({ ok: true, adapterConstructedMs, totalMs, distanceM: result.distanceM, geometryPunten: result.geometry?.length ?? null });
  } catch (err) {
    const totalMs = Date.now() - t0;
    return NextResponse.json({ ok: false, adapterConstructedMs, totalMs, error: err instanceof Error ? err.message : String(err) });
  }
}
