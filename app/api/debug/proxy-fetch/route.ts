import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const ALLOWED_HOSTS = ["service.pdok.nl"];

/**
 * GET /api/debug/proxy-fetch?url=<url>
 *
 * Fase M (geometrie-debug), 9-9-2026. TIJDELIJKE debug-tool -- haalt een URL
 * server-side op en geeft de ruwe status/headers/body terug, zodat de
 * geometrie-resolver-debugpagina externe WFS-aanvragen kan inspecteren
 * zonder CORS-beperkingen. Bewust beperkt tot een expliciete allowlist
 * (alleen service.pdok.nl) om misbruik als open proxy te voorkomen.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const targetUrl = req.nextUrl.searchParams.get("url");
  if (!targetUrl) {
    return NextResponse.json({ error: "url-parameter verplicht." }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return NextResponse.json({ error: "Ongeldige URL." }, { status: 400 });
  }
  if (!ALLOWED_HOSTS.includes(parsed.hostname)) {
    return NextResponse.json({ error: `Host niet toegestaan: ${parsed.hostname}. Alleen ${ALLOWED_HOSTS.join(", ")}.` }, { status: 403 });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "GoKnoop-geometry-debug/1.0" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    const rawText = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let parsedBody: unknown = null;
    let bodyIsValidJson = false;
    try {
      parsedBody = JSON.parse(rawText);
      bodyIsValidJson = true;
    } catch {
      /* geen geldige JSON, rawText blijft leidend */
    }

    return NextResponse.json({
      httpStatus: res.status,
      responseHeaders: headers,
      bodyIsValidJson,
      bodyPreview: rawText.slice(0, 2000),
      bodyFeatureCount: bodyIsValidJson && parsedBody && typeof parsedBody === "object" && "features" in parsedBody ? (parsedBody as { features: unknown[] }).features?.length : null,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err instanceof Error && err.name === "AbortError";
    return NextResponse.json(
      { error: isTimeout ? "Aanvraag duurde langer dan 15s." : "Proxy-aanvraag mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
