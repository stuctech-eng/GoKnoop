import { NextRequest, NextResponse } from "next/server";
import { Agent, fetch as undiciFetch } from "undici";

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
 *
 * UITGEBREID 8-9-2026, ná een 25s-timeout op de gewone aanroep (geen
 * ORS-storing -- api.heigit.org zelf reageerde apart getest wel meteen):
 * EMPIRISCHE test van de IPv6-hangende-verbinding-hypothese (bekend patroon
 * in serverless-omgevingen: als een host zowel A- als AAAA-DNS-records heeft
 * en de IPv6-route niet goed werkt, kan een verbindingspoging stil blijven
 * hangen i.p.v. netjes terug te vallen op IPv4). `undici`'s Agent met
 * `connect: { family: 4 }` dwingt IPv4 af, los van de standaard
 * `fetch()`-DNS-keuze. Beide pogingen worden hieronder ná elkaar uitgevoerd
 * en vergeleken -- geen aanname, een directe A/B-meting.
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

  async function attempt(label: string, fetchFn: typeof fetch, extraInit: Record<string, unknown> = {}) {
    const t0 = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // korter dan de eerdere 25s -- we willen het verschil zien, niet nogmaals lang wachten
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: apiKey },
        body,
        signal: controller.signal,
        ...extraInit,
      } as RequestInit);
      clearTimeout(timeoutId);
      const text = await res.text();
      return { label, ok: true, httpStatus: res.status, elapsedMs: Date.now() - t0, bodyPreview: text.slice(0, 300) };
    } catch (err) {
      clearTimeout(timeoutId);
      const isAbort = err instanceof Error && err.name === "AbortError";
      return {
        label,
        ok: false,
        isTimeout: isAbort,
        elapsedMs: Date.now() - t0,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Poging 1: standaard fetch() -- zelfde als de bestaande productiecode gebruikt.
  const standardResult = await attempt("standaard fetch() (standaard DNS-keuze, mogelijk IPv6)", fetch);

  // Poging 2: undici met family:4 geforceerd -- IPv6 expliciet uitgesloten.
  const ipv4Agent = new Agent({ connect: { family: 4 } } as unknown as ConstructorParameters<typeof Agent>[0]);
  const ipv4Result = await attempt(
    "IPv4 geforceerd (undici Agent, family:4)",
    undiciFetch as unknown as typeof fetch,
    { dispatcher: ipv4Agent }
  );

  // Poging 3: simpele GET naar de hoofddomein-pagina, VANAF VERCEL zelf (niet mijn
  // eigen netwerk) -- test of ELKE verbinding vanaf Vercel naar deze host traag is,
  // of specifiek deze POST-aanvraag/dit endpoint.
  const t3 = Date.now();
  let rootGetResult: Record<string, unknown>;
  try {
    const controller3 = new AbortController();
    const timeoutId3 = setTimeout(() => controller3.abort(), 8000);
    const res3 = await fetch("https://api.heigit.org/", { signal: controller3.signal });
    clearTimeout(timeoutId3);
    rootGetResult = { ok: true, httpStatus: res3.status, elapsedMs: Date.now() - t3 };
  } catch (err) {
    rootGetResult = {
      ok: false,
      isTimeout: err instanceof Error && err.name === "AbortError",
      elapsedMs: Date.now() - t3,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }

  // Poging 4: dezelfde POST, maar met een overduidelijk ONGELDIGE sleutel -- test of
  // het specifiek aan ONZE sleutel ligt (zou dan met een foutieve sleutel juist WEL
  // snel een 401/403 moeten geven), of dat elke aanvraag naar dit endpoint hangt.
  const invalidKeyResult = await attempt("POST met overduidelijk ongeldige sleutel", fetch, {
    headers: { "Content-Type": "application/json", Authorization: "dit-is-een-overduidelijk-ongeldige-testsleutel" },
  });

  return NextResponse.json({
    conclusion:
      standardResult.ok && !ipv4Result.ok
        ? "Onverwacht: standaard werkte, IPv4-geforceerd niet."
        : !standardResult.ok && ipv4Result.ok
        ? "BEVESTIGD: standaard hangt/faalt, IPv4-geforceerd werkt -- dit is het IPv6-verbindingsprobleem."
        : standardResult.ok && ipv4Result.ok
        ? "Beide werkten dit keer -- mogelijk intermitterend, geen structureel IPv6-probleem aangetoond."
        : "Beide faalden -- wijst niet specifiek op IPv6, iets anders aan de hand.",
    standard: standardResult,
    ipv4Forced: ipv4Result,
    rootGetFromVercel: rootGetResult,
    invalidKeyAttempt: invalidKeyResult,
  });
}
