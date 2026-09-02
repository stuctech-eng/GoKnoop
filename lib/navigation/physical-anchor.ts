/**
 * PhysicalAnchor + NavigationSessionInfo -- Fase 2 van GOKNOOP-MASTER.md
 * sectie 9 (Parkeerplaats → Startknooppunt → Route → Back to Start).
 *
 * Puur datamodel (types + een lichte runtime-guard), GEEN opslag, GEEN
 * LocalBikeRouter-aanroep -- dat is Fase 3+ (nog niet hier gebouwd, sectie
 * 9.9). Fase 1 (audit) is al gedaan (sectie 9.2), niet herhaald.
 *
 * KERNONDERSCHEID (sectie 9.1/9.7), de reden dat dit bestand bestaat: het
 * FYSIEKE vertrekpunt van een fietstocht (bijv. een parkeerplaats) is NIET
 * hetzelfde als het ROUTE-startpunt (het eerste knooppunt, `Route.nodes[0]`).
 * Tot nu toe was dat impliciet hetzelfde veld -- dit bestand maakt het
 * onderscheid expliciet, zonder `Route`/`GraphEdge` (Phase 2) aan te raken.
 *
 * BEWUST NOG NIET INGEVULD in `NavigationSessionInfo`: een `phase`- en
 * `currentPosition`-veld (wel genoemd in het conceptuele model, sectie 9.7).
 * Die vereisen een beslissing over hoe dit zich verhoudt tot de BESTAANDE
 * `NavigationState` (stap 2) en `PreNavigationPhase` (sectie 6C) -- een
 * derde, ongerelateerde "fase"-enum zou verwarring riskeren. Die beslissing
 * hoort bij Fase 3/4 (LocalBikeRouter-wiring), waar pas duidelijk wordt hoe
 * "op weg naar de parkeerplaats/het knooppunt" zich verhoudt tot de
 * bestaande matching-state-machine. Hier niet vooruitgelopen.
 */

/**
 * Eén type voor nu ("parking") -- makkelijk uit te breiden zonder herontwerp
 * als er ooit een ander soort fysiek vertrekpunt nodig is (sectie 9.7).
 */
export type PhysicalAnchor = {
  type: "parking";
  lat: number;
  lon: number;
  /** Optioneel, mensleesbaar label (bijv. "Parkeerplaats Edam"). */
  name?: string;
};

/** Runtime-guard, zelfde stijl/patroon als `isSavedRoute`/`isRiddenRoute` (sectie 6F/8) -- nodig zodra Fase 3+ dit uit opslag/een API-respons parst. */
export function isPhysicalAnchor(value: unknown): value is PhysicalAnchor {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "parking" &&
    typeof v.lat === "number" &&
    typeof v.lon === "number" &&
    (v.name === undefined || typeof v.name === "string")
  );
}

/**
 * Minimale `NavigationSession` (sectie 9.7) -- alleen de twee velden die nu
 * al ondubbelzinnig vaststaan. `physicalStart` mag tijdens een sessie NOOIT
 * overschreven worden (sectie 9.7, cruciale regel voor Back to Start) --
 * die bewaking hoort bij de aanroepende code (Fase 4/5), dit type dwingt
 * het zelf niet af (puur data, geen gedrag).
 */
export type NavigationSessionInfo = {
  routeId: string;
  /** null zolang er geen fysiek vertrekpunt aan deze route gekoppeld is. */
  physicalStart: PhysicalAnchor | null;
  /** Route.nodes[0] -- BLIJFT apart van physicalStart, nooit door elkaar halen. */
  routeStartNodeId: string;
};
