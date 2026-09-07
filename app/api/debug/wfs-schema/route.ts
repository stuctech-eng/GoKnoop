import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 20;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/wfs-schema?typeName=routedatabank:fietsnetwerken_nlfietsland
 *
 * TOEGEVOEGD 7-9-2026, vervolg op /api/debug/wfs-layers: die liet ALLE 33
 * beschikbare lagen zien, deze haalt het VELDSCHEMA op van één specifieke laag
 * (DescribeFeatureType) -- om te checken of een tot nu toe ongebruikte
 * variant (bv. fietsnetwerken_nlfietsland, fietsknooppunten_vrij) misschien
 * wél directe knooppunt-verwijzingen (from_node/to_node-achtige velden)
 * bevat, in tegenstelling tot de laag die GoKnoop nu gebruikt
 * (fietsnetwerken_vrij, al bevestigd GEEN node-referenties te hebben).
 * Puur lezend, zelfde al-bestaande WFS-credentials.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const typeName = req.nextUrl.searchParams.get("typeName");
  if (!typeName) {
    return NextResponse.json({ error: "typeName-parameter verplicht." }, { status: 400 });
  }

  const baseUrl = process.env.ROUTEDATABANK_URL;
  const user = process.env.ROUTEDATABANK_USER;
  const pass = process.env.ROUTEDATABANK_PASS;
  if (!baseUrl || !user || !pass) {
    return NextResponse.json(
      { error: "Ontbrekende environment variables: ROUTEDATABANK_URL, ROUTEDATABANK_USER en/of ROUTEDATABANK_PASS." },
      { status: 500 }
    );
  }

  try {
    const params = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "DescribeFeatureType", typeName });
    const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { Authorization: authHeader, "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app; QGIS-compatible WFS client)" },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `DescribeFeatureType gaf status ${res.status}` }, { status: 502 });
    }
    const xml = await res.text();

    // Elk <xsd:element name="..." type="..."/> is een veld.
    const fieldMatches = [...xml.matchAll(/<xsd:element[^>]*name="([^"]+)"[^>]*type="([^"]+)"[^>]*\/?>/g)].map((m) => ({
      name: m[1],
      type: m[2],
    }));

    return NextResponse.json({ typeName, fieldCount: fieldMatches.length, fields: fieldMatches });
  } catch (err) {
    return NextResponse.json(
      { error: "DescribeFeatureType-aanvraag mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
