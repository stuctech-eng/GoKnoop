/**
 * Deelbare route-link (GOKNOOP-MASTER.md sectie 9.33, 30-8-2026).
 *
 * BEWUSTE ARCHITECTUURKEUZE: de route wordt RECHTSTREEKS in de link
 * gecodeerd, niet opgeslagen achter een technische Route-ID op een server.
 * GoKnoop heeft bewust geen backend-opslag voor gebruikersdata (geen
 * account-systeem, alles lokaal in localStorage) -- een link die naar een
 * server-ID verwijst zou die architectuur doorbreken en nieuwe vragen over
 * misbruik/opslagbeheer/privacy introduceren die er nu niet zijn. Een link
 * die de route zelf BEVAT levert exact hetzelfde resultaat op (de ontvanger
 * ziet precies dezelfde route, geen nieuwe berekening) zonder die kosten.
 *
 * Puur, client-veilig (geen window-afhankelijkheid nodig -- `atob`/`btoa`
 * zijn zowel in de browser als in Node 16+ globaal beschikbaar, dus dit
 * werkt ongewijzigd in tests).
 */

export type RouteShareCodePayload = {
  n: string[]; // nodeIds
  e: string[]; // edgeIds
  d: string; // datasetVersionId
  nm: string | null; // naam, indien aanwezig
};

/** UTF-8-veilige base64 (Nederlandse namen kunnen niet-ASCII-tekens bevatten). */
function utf8ToBase64(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64ToUtf8(str: string): string {
  return decodeURIComponent(escape(atob(str)));
}

/** URL-veilige variant (geen +, /, of = die in een URL geëscaped zouden moeten worden). */
export function encodeRouteShareCode(payload: RouteShareCodePayload): string {
  const base64 = utf8ToBase64(JSON.stringify(payload));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Geeft null terug bij een ongeldige/corrupte code -- nooit een crash (een gedeelde link kan
 *  onderweg beschadigd raken, bijv. door een berichten-app die 'm afkapt). */
export function decodeRouteShareCode(code: string): RouteShareCodePayload | null {
  try {
    const base64 = code.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const parsed = JSON.parse(base64ToUtf8(padded));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray(parsed.n) ||
      !parsed.n.every((x: unknown) => typeof x === "string") ||
      !Array.isArray(parsed.e) ||
      !parsed.e.every((x: unknown) => typeof x === "string") ||
      typeof parsed.d !== "string"
    ) {
      return null;
    }
    return { n: parsed.n, e: parsed.e, d: parsed.d, nm: typeof parsed.nm === "string" ? parsed.nm : null };
  } catch {
    return null;
  }
}

/** Bouwt de volledige deelbare URL, gegeven de huidige locatie (window.location.origin). */
export function buildShareUrl(payload: RouteShareCodePayload, origin: string): string {
  return `${origin}/?share=${encodeRouteShareCode(payload)}`;
}
