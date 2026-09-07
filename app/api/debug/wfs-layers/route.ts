import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 20;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/wfs-layers
 *
 * TOEGEVOEGD 7-9-2026, n.a.v. de vraag "gebruiken we wel de juiste laag, of
 * bestaat er een rijkere laag met directe knooppunt-koppelingen die we niet
 * gebruiken?" (docs/phase1a-wfs-audit.md bevestigde al dat de HUIDIGE laag,
 * fietsnetwerken_vrij, geen from_node/to_node heeft -- maar nooit gecheckt of
 * er ANDERE lagen bestaan). Puur lezend: GetCapabilities, met de al-bestaande
 * ROUTEDATABANK_*-omgevingsvariabelen (zelfde credentials als de bestaande
 * import gebruikt) -- geen nieuwe toegang nodig, geen wijziging aan de
 * import-pijplijn.
 */
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
      { error: "Ontbrekende environment variables: ROUTEDATABANK_URL, ROUTEDATABANK_USER en/of ROUTEDATABANK_PASS." },
      { status: 500 }
    );
  }

  try {
    const params = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetCapabilities" });
    const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { Authorization: authHeader, "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app; QGIS-compatible WFS client)" },
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `WFS GetCapabilities gaf status ${res.status}` }, { status: 502 });
    }
    const xml = await res.text();

    // Simpele regex-extractie (geen volwaardige XML-parser nodig voor deze
    // eenmalige diagnose) -- elk <FeatureType><Name>...</Name> is een laag.
    const nameMatches = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((m) => m[1]);
    // Titel meegeven waar beschikbaar, voor context bij de laagnaam.
    const titleMatches = [...xml.matchAll(/<Title>([^<]+)<\/Title>/g)].map((m) => m[1]);

    return NextResponse.json({
      layerCount: nameMatches.length,
      layers: nameMatches,
      titles: titleMatches,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "GetCapabilities-aanvraag mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
