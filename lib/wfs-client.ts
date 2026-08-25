/**
 * Gedeelde WFS-client voor gepagineerde GetFeature-aanvragen tijdens de import.
 * Los van de publieke debug-route (die hard gecapt is op 10 records) — dit is
 * de eigen database-import, geen publiek toegankelijk endpoint.
 */

export type WfsPageResult = {
  xml: string;
  numberMatched: number;
  numberReturned: number;
};

export async function fetchWfsPage(
  typeName: string,
  startIndex: number,
  count: number
): Promise<WfsPageResult> {
  const baseUrl = process.env.ROUTEDATABANK_URL;
  const user = process.env.ROUTEDATABANK_USER;
  const pass = process.env.ROUTEDATABANK_PASS;

  if (!baseUrl || !user || !pass) {
    throw new Error(
      "Ontbrekende environment variables: ROUTEDATABANK_URL, ROUTEDATABANK_USER en/of ROUTEDATABANK_PASS."
    );
  }

  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName,
    startIndex: String(startIndex),
    count: String(count),
  });

  const authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

  const res = await fetch(`${baseUrl}?${params.toString()}`, {
    headers: {
      Authorization: authHeader,
      "User-Agent": "GoKnoop/1.0 (+https://go-knoop.vercel.app; QGIS-compatible WFS client)",
      Referer: "https://go-knoop.vercel.app/",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`WFS-aanvraag voor ${typeName} gaf status ${res.status}`);
  }

  const xml = await res.text();

  const numberMatchedMatch = /numberMatched="(\d+)"/.exec(xml);
  const numberReturnedMatch = /numberReturned="(\d+)"/.exec(xml);

  return {
    xml,
    numberMatched: numberMatchedMatch ? parseInt(numberMatchedMatch[1], 10) : 0,
    numberReturned: numberReturnedMatch ? parseInt(numberReturnedMatch[1], 10) : 0,
  };
}
