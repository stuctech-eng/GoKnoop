import type { GraphProvider } from "./types";
import { computeRoute } from "./route-engine";
import { rdToWgs84 } from "./coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import { getCachedKnotSegment, setCachedKnotSegment } from "./knot-segment-cache";
import type { LatLon, LocalBikeRouteStep } from "@/lib/local-bike-router/types";

/**
 * "Functie 2" (19-9-2026, GO van Te, overlegd): de kortste weg via knooppunten
 * vinden, maar het daadwerkelijke rijpad tussen elk paar opeenvolgende knooppunten
 * met de bewezen-werkende echte-fietspad-motor (functie 1, ORS) berekenen --
 * i.p.v. het oude NWB/connector-systeem. Gebruikt UITSLUITEND `computeRoute()`
 * (de pure, nooit-door-de-NWB-bugs-geraakte knooppunten-Dijkstra, zie
 * lib/route-engine/route-engine.ts/dijkstra.ts) voor de knooppuntvolgorde zelf --
 * geen NWB, geen connectors, geen bridges.
 *
 * ONTWERPBESLISSINGEN, zoals overlegd (niet aangenomen, expliciet besproken):
 * - sequentiële ORS-aanroepen met een vaste pauze ertussen (zelfde 1,6s die eerder
 *   al empirisch veilig bleek tegen ORS' per-minuut-limiet, zie generate-bridges/route.ts) --
 *   bewust GEEN parallellisatie, dat zou de per-minuut-limiet juist sneller raken;
 * - een harde bovengrens op het aantal knooppunten, boven welke een duidelijke fout
 *   teruggegeven wordt i.p.v. een trage of afgekapte berekening;
 * - een PERMANENTE cache (Firestore, `knot-segment-cache.ts`) per knooppuntpaar --
 *   een pauze is alleen nodig vóór een ECHTE ORS-aanroep, nooit bij een cache-hit.
 *
 * OMWEG-DETECTIE + TERUGVAL (19-9-2026, vervolg op het Volendam-Hoorn-onderzoek en de
 * landelijke connected-components/detour-detector-analyse): de pure knooppuntengraaf
 * bleek landelijk 1.111 losse componenten te hebben (76,1% in één "vasteland", de rest
 * verspreid, o.a. door echte gaten in de `fietsnetwerken_vrij`-brondata). In plaats van
 * elk gat afzonderlijk handmatig te vinden en te patchen (niet haalbaar op deze schaal,
 * en risicovol om blind op te schalen), controleert deze functie ZELF of de gevonden
 * Dijkstra-route een onredelijke omweg is (padafstand t.o.v. de hemelsbrede afstand
 * tussen begin- en eindknooppunt). Bij een onredelijke omweg: NIET de slechte route
 * presenteren, maar automatisch terugvallen op functie 1 (directe ORS-route tussen
 * dezelfde twee knooppunten) -- dezelfde, al bewezen werkende motor, nu ingezet als
 * vangnet voor precies de zwakte die we in de pure graaf hebben blootgelegd. Dit lost
 * het probleem "overal waar nodig" op zonder de landelijke brondata te hoeven repareren.
 */

/** Boven dit aantal knooppunten in de kortste route: expliciete afwijzing, geen poging. */
export const MAX_KNOOPPUNTEN_PER_ROUTE = 20;
/** Zelfde, empirisch bevestigd veilige pauze als het eerdere bridge-generatie-werk. */
const ORS_CALL_DELAY_MS = 1600;
/**
 * Boven deze verhouding (padafstand / hemelsbrede afstand) wordt de Dijkstra-route als
 * onredelijke omweg beschouwd -- terugval naar functie 1. Een normale fietsroute (bochten,
 * geen rechte lijn) zit doorgaans ruim onder 1,4x; de Volendam-Hoorn-omweg zat rond de
 * 2,5-3x. 1,8 is een bewust ruime marge (nooit een normale, licht kronkelende route
 * onterecht afwijzen), niet een precies gekalibreerde grens -- instelbaar mocht praktijk
 * anders uitwijzen.
 */
const DETOUR_RATIO_THRESHOLD = 1.8;

export type KnotSegmentSource = "cache" | "ors";

export type ViaKnooppuntenResult = {
  nodeIds: string[];
  displayNumbers: string[];
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  steps: LocalBikeRouteStep[];
  /** Per tussenstap: kwam dit uit de permanente cache, of is het net bij ORS opgehaald? Puur ter observatie/diagnose. */
  segmentSources: KnotSegmentSource[];
  /**
   * true als de pure knooppuntengraaf een onredelijke omweg opleverde en er daarom
   * automatisch is teruggevallen op functie 1 (directe ORS-route) i.p.v. de omweg te
   * presenteren. `detourRatio` is de verhouding die de terugval veroorzaakte (of, als
   * geen terugval nodig was, de verhouding die WEL gemeten werd -- altijd aanwezig,
   * puur ter transparantie/diagnose).
   */
  usedDirectFallback: boolean;
  detourRatio: number;
};

export type ViaKnooppuntenError =
  | { reason: "dijkstra_failed"; message: string }
  | {
      reason: "too_many_knooppunten";
      knooppuntenCount: number;
      limit: number;
      /**
       * TOEGEVOEGD (n.a.v. Volendam->Hoorn: 29 knooppunten, "kan niet kloppen" t.o.v. de
       * officiële kaart) -- de volledige reeks WEL teruggeven, puur ter inspectie. Geen
       * enkele ORS-aanroep gedaan voor deze reeks (de grens bestaat juist om dat te
       * voorkomen) -- dit kost dus niets, en maakt het mogelijk de reeks naast de
       * officiële kaart te leggen om vast te stellen of dit een zinnig-maar-lang pad is
       * (bijv. een bekend gat in de pure knooppuntengraaf, zie de toelichting bovenaan
       * dit bestand) of een echte fout.
       */
      nodeIds: string[];
      displayNumbers: string[];
      /** Coördinaten per stap, in dezelfde volgorde -- zodat het pad daadwerkelijk op een kaart getekend kan worden i.p.v. alleen als losse nummers. */
      positions: LatLon[];
    }
  | { reason: "segment_failed"; fromNodeId: string; toNodeId: string; message: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pure omweg-beslissing (19-9-2026) -- losgetrokken uit `routeViaKnooppunten` zodat dit,
 * de kern van de hele oplossing, apart en zonder Firestore/ORS getest kan worden. Geeft
 * ook `ratio` terug (niet alleen een boolean) zodat de aanroeper 'm kan tonen/loggen.
 * `straightLineM === 0` (zelfde punt tweemaal, of coördinaten ontbraken) wordt bewust NOOIT
 * als omweg aangemerkt -- delen door nul zou een oneindige/zinloze verhouding geven.
 */
export function evaluateDetour(
  pathDistanceM: number,
  straightLineM: number,
  threshold: number = DETOUR_RATIO_THRESHOLD
): { isDetour: boolean; ratio: number } {
  if (straightLineM <= 0) return { isDetour: false, ratio: 1 };
  const ratio = pathDistanceM / straightLineM;
  return { isDetour: ratio > threshold, ratio };
}

export async function routeViaKnooppunten(
  provider: GraphProvider,
  datasetVersionId: string,
  fromNodeId: string,
  toNodeId: string
): Promise<ViaKnooppuntenResult | ViaKnooppuntenError> {
  // Stap 1: kortste knooppuntvolgorde -- de pure, NWB-vrije Dijkstra (al bestaand, ongewijzigd).
  const dijkstraResult = computeRoute(provider, datasetVersionId, fromNodeId, toNodeId);
  if ("reason" in dijkstraResult) {
    return { reason: "dijkstra_failed", message: dijkstraResult.message };
  }
  const nodeIds = dijkstraResult.nodes;
  const displayNumbers = nodeIds.map((id) => provider.getNode(id)?.displayNumber ?? "?");

  // OMWEG-CHECK (zie de bestandsdocumentatie hierboven) -- EERST, vóór de knooppunten-
  // limiet en vóór enige ORS-aanroep: kost niets (Dijkstra's eigen totale afstand is er
  // al, de hemelsbrede afstand is een simpele berekening), en voorkomt dat we tijd/ORS-
  // budget besteden aan een pad dat we toch gaan verwerpen.
  const fromNodeForRatio = provider.getNode(fromNodeId);
  const toNodeForRatio = provider.getNode(toNodeId);
  const straightLineM =
    fromNodeForRatio && toNodeForRatio ? Math.hypot(fromNodeForRatio.x - toNodeForRatio.x, fromNodeForRatio.y - toNodeForRatio.y) : 0;
  const { isDetour, ratio: detourRatio } = evaluateDetour(dijkstraResult.distanceM, straightLineM);

  if (isDetour) {
    // Terugval naar functie 1: dezelfde, al bewezen werkende motor, nu rechtstreeks tussen
    // de twee knooppunten zelf (niet de adressen -- dat blijft de verantwoordelijkheid van
    // de aanroeper/API-laag, deze functie kent alleen knooppunt-ID's).
    const fromWgs84 = rdToWgs84(fromNodeForRatio!.x, fromNodeForRatio!.y);
    const toWgs84 = rdToWgs84(toNodeForRatio!.x, toNodeForRatio!.y);
    const router = new LocalBikeRouter(new OpenRouteServiceAdapter());
    const direct = await router.route({ lat: fromWgs84.lat, lon: fromWgs84.lon }, { lat: toWgs84.lat, lon: toWgs84.lon }, "cycling", {
      includeSteps: true,
    });
    if ("reason" in direct) {
      // Zelfs de terugval lukte niet -- dan is er echt iets mis (geen fietsverbinding
      // tussen deze twee punten volgens ORS zelf), geen reden om alsnog de omweg te tonen.
      return { reason: "segment_failed", fromNodeId, toNodeId, message: `Omweg gedetecteerd (${detourRatio.toFixed(1)}x) en terugval naar functie 1 mislukte ook: ${direct.message}` };
    }
    return {
      nodeIds: [fromNodeId, toNodeId],
      displayNumbers: [displayNumbers[0], displayNumbers[displayNumbers.length - 1]],
      geometry: direct.geometry,
      distanceM: direct.distanceM,
      durationS: direct.durationS,
      steps: direct.steps ?? [],
      segmentSources: ["ors"],
      usedDirectFallback: true,
      detourRatio: Number(detourRatio.toFixed(2)),
    };
  }

  if (nodeIds.length > MAX_KNOOPPUNTEN_PER_ROUTE) {
    const positions = nodeIds.map((id) => {
      const node = provider.getNode(id);
      return node ? rdToWgs84(node.x, node.y) : { lat: 0, lon: 0 }; // node zou hier altijd moeten bestaan (kwam net uit dezelfde provider); 0,0 puur als laatste redmiddel, geen crash
    });
    return { reason: "too_many_knooppunten", knooppuntenCount: nodeIds.length, limit: MAX_KNOOPPUNTEN_PER_ROUTE, nodeIds, displayNumbers, positions };
  }

  // Stap 2: per opeenvolgend paar het echte fietspad ophalen -- cache eerst, anders ORS (functie 1).
  const router = new LocalBikeRouter(new OpenRouteServiceAdapter());

  let combinedGeometry: LatLon[] = [];
  let combinedDistanceM = 0;
  let combinedDurationS = 0;
  const combinedSteps: LocalBikeRouteStep[] = [];
  const segmentSources: KnotSegmentSource[] = [];

  for (let i = 0; i < nodeIds.length - 1; i++) {
    const fromId = nodeIds[i];
    const toId = nodeIds[i + 1];

    const cached = await getCachedKnotSegment(fromId, toId);
    let segment;
    if (cached) {
      segment = cached;
      segmentSources.push("cache");
    } else {
      const fromNode = provider.getNode(fromId);
      const toNode = provider.getNode(toId);
      if (!fromNode || !toNode) {
        return { reason: "segment_failed", fromNodeId: fromId, toNodeId: toId, message: "Knooppunt niet gevonden in de graaf." };
      }
      const fromWgs84 = rdToWgs84(fromNode.x, fromNode.y);
      const toWgs84 = rdToWgs84(toNode.x, toNode.y);

      const result = await router.route(
        { lat: fromWgs84.lat, lon: fromWgs84.lon },
        { lat: toWgs84.lat, lon: toWgs84.lon },
        "cycling",
        { includeSteps: true }
      );
      if ("reason" in result) {
        return { reason: "segment_failed", fromNodeId: fromId, toNodeId: toId, message: result.message };
      }
      segment = result;
      segmentSources.push("ors");
      await setCachedKnotSegment(fromId, toId, result);

      // Pauze UITSLUITEND ná een echte ORS-aanroep, en niet ná de allerlaatste --
      // een cache-hit heeft geen enkele reden om te wachten.
      if (i < nodeIds.length - 2) {
        await sleep(ORS_CALL_DELAY_MS);
      }
    }

    // Stap 3: samenvoegen -- gedeelde naad (eindpunt van stuk A = beginpunt van stuk B) niet dupliceren.
    combinedGeometry = combinedGeometry.length === 0 ? segment.geometry : [...combinedGeometry, ...segment.geometry.slice(1)];
    combinedDistanceM += segment.distanceM;
    combinedDurationS += segment.durationS;
    if (segment.steps) combinedSteps.push(...segment.steps);
  }

  return {
    nodeIds,
    displayNumbers,
    geometry: combinedGeometry,
    distanceM: combinedDistanceM,
    durationS: combinedDurationS,
    steps: combinedSteps,
    segmentSources,
    usedDirectFallback: false,
    detourRatio: Number(detourRatio.toFixed(2)),
  };
}
