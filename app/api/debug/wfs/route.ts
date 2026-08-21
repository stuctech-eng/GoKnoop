import { NextRequest, NextResponse } from "next/server";

/**
 * Server-side proxy voor Routedatabank WFS discovery (Phase 1A).
 *
 * Credentials (ROUTEDATABANK_URL / _USER / _PASS) leven uitsluitend
 * server-side als Vercel environment variables. Deze route stuurt ze
 * nooit terug naar de client en logt ze nooit.
 *
 * Toegang tot deze route zelf is optioneel afgeschermd met DEBUG_SECRET
 * (?key=...), zodat de responsestructuur niet publiek voor iedereen
 * bereikbaar is zolang de route bestaat.
 *
 * GEEN BULK EXPORT: GetFeature-requests worden altijd hard gelimiteerd
 * tot maximaal MAX_FEATURES resultaten, ongeacht wat is opgegeven.
 * Dit is een audit/discovery-tool, geen dataset-downloadendpoint
 * (zie Master Plan sectie 4, 66, 67 -- doorlevering is niet toegestaan).
 *
 * User-Agent: expliciet meegegeven, omdat Routedatabank's server
 * verzoeken zonder duidelijke User-Agent blokkeert bij GetFeature
 * (bevestigd door GIS-beheerder Jon Rietman -- werkt wel via QGIS,
 * dat altijd een eigen User-Agent meestuurt).
 */

const ALLOWED_REQUESTS = ["GetCapabilities", "DescribeFeatureType", "GetFeature"];
const MAX_FEATURES = 10;

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const baseUrl = process.env.ROUTEDATABANK_URL;
  const user = process.env.ROUTEDATABANK_USER;
  const pass = process.env.ROUTEDATABANK_PASS;

  if (!baseUrl || !user || !pass) {
    return NextResponse.json(
      {
        error:
          "Ontbrekende environment variables: ROUTEDATABANK_URL, ROUTEDATABANK_USER en/of ROUTEDATABANK_PASS zijn niet ingesteld in Vercel.",
      },
      { status: 500 }
    );
  }

  const requestType = req.nextUrl.searchParams.get("request") || "GetCapabilities";
  if (!ALLOWED_REQUESTS.includes(requestType)) {
    return NextResponse.json(
      {
        error: `Request type niet toegestaan: ${requestType}`,
        allowed: ALLOWED_REQUESTS,
      },
      { status: 400 }
    );
  }

  const forwardParams = new URLSearchParams(req.nextUrl.searchParams);
  forwardParams.delete("key");
  forwardParams.set("service", "WFS");
  if (!forwardParams.get("version")) {
    forwardParams.set("version", "2.0.0");
  }
  forwardParams.set("request", requestType);

  if (requestType === "GetFeature") {
    const requestedCount = parseInt(
      forwardParams.get("count") || forwardParams.get("maxFeatures") || String(MAX_FEATURES),
      10
    );
    const cappedCount = Math.min(
      isNaN(requestedCount) ? MAX_FEATURES : requestedCount,
      MAX_FEATURES
    );
    forwardParams.set("count", String(cappedCount));
    forwardParams.set("maxFeatures", String(cappedCount));
  }

  const targetUrl = `${baseUrl}?${forwardParams.toString()}`;
  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        Authorization: authHeader,
        "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app; QGIS-compatible WFS client)",
        Accept: "application/xml, application/json, */*",
      },
      cache: "no-store",
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/xml";

    return new NextResponse(body, {
      status: upstream.status,
      headers: { "Content-Type": contentType },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Ophalen bij Routedatabank mislukt.",
        details: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
