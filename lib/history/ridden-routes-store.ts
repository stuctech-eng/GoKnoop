/**
 * Gereden-routes-opslag (Fase 2, GOKNOOP-MASTER.md sectie 6F, 29-8-2026).
 *
 * Puur browserlokaal (localStorage) -- GoKnoop heeft geen gebruikers-
 * account-systeem, dus dit is bewust de juiste plek, niet een backend-
 * database. Volledig automatisch: de gebruiker hoeft niets te doen of te
 * benoemen (dat is het verschil met "Mijn routes", Fase 3 -- bewust
 * gescheiden datamodel, geen vermenging).
 *
 * Wordt gevuld door `components/navigation/NavigationScreen.tsx` zodra de
 * `NavigationStateMachine` `ARRIVED` bereikt (ondubbelzinnige "voltooid"-
 * trigger, geen aanname over een niet-afgemaakte poging -- op verzoek,
 * 30-8-2026 herbevestigd: "gereden routes zijn gereden, niet op de helft
 * gestopt". `endPausedRide()` in `app/page.tsx` roept dit daarom NIET meer
 * aan).
 *
 * UITGEBREID (30-8-2026, op verzoek: "gereden routes nooit weggooien" +
 * "moeten weer gereden kunnen worden" + zichtbaar in "Mijn routes"):
 * - GEEN opslaglimiet meer (`MAX_STORED_ROUTES` verwijderd) -- alles
 *   blijft permanent bewaard.
 * - `datasetVersionId` toegevoegd -- ontbrak eerder, nodig om een gereden
 *   route later opnieuw te kunnen rijden (zelfde `/api/route/resolve`-
 *   patroon als `SavedRoute`).
 * - `id` toegevoegd -- stabiele React-key/referentie voor de UI-lijst.
 *
 * Voor de PRAKTISCHE dedup-aanroep (server-side "vermijd eerder gereden
 * routes") wordt uitsluitend `getRecentRiddenRoutesForDedup()` gebruikt
 * (begrensd tot de meest recente 20) -- niet de volledige, onbegrensde
 * geschiedenis, om de request-payload en server-side vergelijkingskosten
 * begrensd te houden. Dit is puur een praktische begrenzing van wat naar de
 * server gestuurd wordt, GEEN verwijdering uit de opslag zelf.
 */

const STORAGE_KEY = "goknoop.riddenRoutes.v1";
const DEDUP_SEND_LIMIT = 20;

export type RiddenRoute = {
  id: string;
  edgeIds: string[];
  nodeIds: string[];
  startNodeId: string;
  datasetVersionId: string;
  distanceM: number;
  riddenAt: string; // ISO-datum
};

function isRiddenRoute(value: unknown): value is RiddenRoute {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    Array.isArray(v.edgeIds) &&
    Array.isArray(v.nodeIds) &&
    typeof v.startNodeId === "string" &&
    typeof v.datasetVersionId === "string" &&
    typeof v.distanceM === "number" &&
    typeof v.riddenAt === "string"
  );
}

/**
 * Haalt ALLE opgeslagen gereden routes op, meest recente eerst. Geeft een
 * lege array terug bij ontbrekende/corrupte opslag -- nooit een crash (dit
 * is best-effort geschiedenis, geen kritiek pad).
 */
export function getRiddenRoutes(): RiddenRoute[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRiddenRoute);
  } catch {
    return [];
  }
}

/** Alleen voor de dedup-aanroep richting de server -- begrensd, zie klasse-commentaar hierboven. */
export function getRecentRiddenRoutesForDedup(limit: number = DEDUP_SEND_LIMIT): RiddenRoute[] {
  return getRiddenRoutes().slice(0, limit);
}

/**
 * Slaat een nieuw gereden route op, meest recente eerst. GEEN limiet meer
 * (op verzoek: "nooit weggooien") -- best-effort, een opslagfout (bijv.
 * vol/geblokkeerd localStorage) mag de navigatie zelf nooit breken.
 */
export function recordRiddenRoute(route: Omit<RiddenRoute, "id" | "riddenAt"> & { riddenAt?: string }): void {
  if (typeof window === "undefined") return;
  try {
    const existing = getRiddenRoutes();
    const entry: RiddenRoute = {
      ...route,
      id: `ridden-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      riddenAt: route.riddenAt ?? new Date().toISOString(),
    };
    const updated = [entry, ...existing];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Best-effort: opslagfout mag de navigatie-ervaring niet verstoren.
  }
}
