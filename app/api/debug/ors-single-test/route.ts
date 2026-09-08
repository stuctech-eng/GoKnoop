import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30; // ruimer dan normaal -- dit is bewust een eenmalige, geïsoleerde diagnostische test, geen batch
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/ors-single-test
 *
 * TOEGEVOEGD 8-9-2026: geïsoleerde, eenmalige ORS-aanroep met gedetailleerde
 * timing -- puur om te bepalen of ORS zelf traag/onbereikbaar is vanuit
 * Vercel's netwerk, los van alle batch-/retry-/deadline-complexiteit van
 * generate-bridges/route.ts. Gebruikt twee vaste, bekende Nederlandse
 * coördinaten (geen afhankelijkheid van Firestore-data).
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const apiKey = process.env.OPENROUTESERVICE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "OPENROUTESERVICE_API_KEY ontbreekt als environment variable." }, { status: 500 });
  }

  const url = "https://api.heigit.org/openrouteservice/v2/directions/cycling-regular/geojson";
  // Amsterdam Centraal -> Amstel-gebied, een paar km, ruim binnen NL, zou een
  // triviale, snelle berekening moeten zijn.
  const body = JSON.stringify({
    coordinates: [
      [4.8996, 52.3791], // Amsterdam Centraal
      [4.9163, 52.3688], // Amstelstation-gebied
    ],
  });

  const timings: Record<string, number> = {};
  const t0 = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body,
      signal: controller.signal,
    });
    timings.responseReceivedAfterMs = Date.now() - t0;
    clearTimeout(timeoutId);

    const text = await res.text();
    timings.bodyReadAfterMs = Date.now() - t0;

    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }

    return NextResponse.json({
      httpStatus: res.status,
      httpOk: res.ok,
      timings,
      responseBodyPreview: text.slice(0, 500),
      parseError,
      parsedSummary:
        parsed && typeof parsed === "object" && "features" in (parsed as Record<string, unknown>)
          ? "Bevat features -- lijkt een geldig GeoJSON-routeresultaat."
          : "Geen 'features'-veld gevonden in de respons.",
    });
  } catch (err) {
    clearTimeout(timeoutId);
    timings.failedAfterMs = Date.now() - t0;
    const isAbort = err instanceof Error && err.name === "AbortError";
    return NextResponse.json({
      failed: true,
      isTimeout: isAbort,
      timings,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorName: err instanceof Error ? err.name : null,
    });
  }
}
