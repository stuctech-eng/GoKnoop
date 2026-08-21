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
 * (zie Master Plan sectie 4, 66, 67 — doorlevering is niet toegestaan).
 *
 * DIAGNOSE-PARAMETERS (allemaal optioneel, alleen relevant voor GetFeature):
 *   httpMethod    = GET (default) | POST      -> GET/KVP vs POST/XML naar Routedatabank
 *   wfsVersion    = 2.0.0 (default) | 1.1.0    -> alleen gebruikt bij httpMethod=POST
 *   endpoint      = wfs (default) | ows        -> welk GeoServer-pad
 *   featureId     = <id>                       -> beperk tot een specifiek object (POST only)
 *   propertyName  = veld1,veld2                -> alleen deze attributen opvragen, geen geometrie
 *   noCount       = 1                           -> sla de MAX_FEATURES-cap over (alleen GET)
 */

const ALLOWED_REQUESTS = ["GetCapabilities", "DescribeFeatureType", "GetFeature"];
const MAX_FEATURES = 10;

function buildPostXml(opts: {
  version: string;
  typeName: string;
  maxOrCount: number;
  featureId: string | null;
  propertyNames: string[] | null;
}): string {
  const { version, typeName, maxOrCount, featureId, propertyNames } = opts;

  const propertyLines = propertyNames
    ? propertyNames.map((p) => `<wfs:PropertyName>${p}</wfs:PropertyName>`).join("")
    : "";

  const filterBlock = featureId
    ? `<ogc:Filter xmlns:ogc="http://www.opengis.net/ogc"><ogc:FeatureId fid="${featureId}"/></ogc:Filter>`
    : "";

  if (version === "1.1.0") {
    return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:GetFeature xmlns:wfs="http://www.opengis.net/wfs" service="WFS" version="1.1.0" maxFeatures="${maxOrCount}">
  <wfs:Query typeName="${typeName}">
    ${propertyLines}
    ${filterBlock}
  </wfs:Query>
</wfs:GetFeature>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<wfs:GetFeature xmlns:wfs="http://www.opengis.net/wfs/2.0" service="WFS" version="2.0.0" count="${maxOrCount}">
  <wfs:Query typeNames="${typeName}">
    ${propertyLines}
    ${filterBlock}
  </wfs:Query>
</wfs:GetFeature>`;
}

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

  const params = req.nextUrl.searchParams;
  const requestType = params.get("request") || "GetCapabilities";
  if (!ALLOWED_REQUESTS.includes(requestType)) {
    return NextResponse.json(
      { error: `Request type niet toegestaan: ${requestType}`, allowed: ALLOWED_REQUESTS },
      { status: 400 }
    );
  }

  const endpointOverride = params.get("endpoint");
  const resolvedBaseUrl =
    endpointOverride === "ows" ? baseUrl.replace(/\/wfs\/?$/, "/ows") : baseUrl;

  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
  const commonHeaders = {
    Authorization: authHeader,
    "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app; QGIS-compatible WFS client)",
    Referer: "https://go-knoop.vercel.app/",
  };

  const httpMethod = (params.get("httpMethod") || "GET").toUpperCase();

  if (httpMethod === "POST" && requestType === "GetFeature") {
    const typeName = params.get("typeName") || "routedatabank:fietsknooppunten";
    const wfsVersion = params.get("wfsVersion") === "1.1.0" ? "1.1.0" : "2.0.0";
    const featureId = params.get("featureId");
    const propertyNameParam = params.get("propertyName");
    const propertyNames = propertyNameParam
      ? propertyNameParam.split(",").map((p) => p.trim())
      : null;

    const requestedCount = parseInt(params.get("count") || String(MAX_FEATURES), 10);
    const cappedCount = Math.min(isNaN(requestedCount) ? MAX_FEATURES : requestedCount, MAX_FEATURES);

    const xmlBody = buildPostXml({
      version: wfsVersion,
      typeName,
      maxOrCount: cappedCount,
      featureId,
      propertyNames,
    });

    try {
      const upstream = await fetch(resolvedBaseUrl, {
        method: "POST",
        headers: {
          ...commonHeaders,
          "Content-Type": "application/xml",
        },
        body: xmlBody,
        cache: "no-store",
      });

      const body = await upstream.text();
      const contentType = upstream.headers.get("content-type") || "application/xml";

      return new NextResponse(body, {
        status: upstream.status,
        headers: {
          "Content-Type": contentType,
          "X-GoKnoop-Diagnostic": `POST ${resolvedBaseUrl} wfsVersion=${wfsVersion}`,
        },
      });
    } catch (err) {
      return NextResponse.json(
        { error: "POST naar Routedatabank mislukt.", details: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
  }

  const forwardParams = new URLSearchParams(params);
  forwardParams.delete("key");
  forwardParams.delete("endpoint");
  forwardParams.delete("httpMethod");
  forwardParams.delete("wfsVersion");
  forwardParams.delete("featureId");

  forwardParams.set("service", "WFS");
  if (!forwardParams.get("version")) {
    forwardParams.set("version", "2.0.0");
  }
  forwardParams.set("request", requestType);

  if (requestType === "GetFeature") {
    const skipCountEnforcement = forwardParams.get("noCount") === "1";
    forwardParams.delete("noCount");
    if (!skipCountEnforcement) {
      const requestedCount = parseInt(
        forwardParams.get("count") || forwardParams.get("maxFeatures") || String(MAX_FEATURES),
        10
      );
      const cappedCount = Math.min(isNaN(requestedCount) ? MAX_FEATURES : requestedCount, MAX_FEATURES);
      forwardParams.set("count", String(cappedCount));
      forwardParams.set("maxFeatures", String(cappedCount));
    }
  }

  const targetUrl = `${resolvedBaseUrl}?${forwardParams.toString()}`;

  try {
    const upstream = await fetch(targetUrl, {
      headers: {
        ...commonHeaders,
        Accept: "application/xml, application/json, */*",
      },
      cache: "no-store",
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get("content-type") || "application/xml";

    return new NextResponse(body, {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "X-GoKnoop-Diagnostic": `GET ${targetUrl}`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Ophalen bij Routedatabank mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
