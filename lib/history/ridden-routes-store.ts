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
 * trigger, geen aanname over een niet-afgemaakte poging).
 *
 * Wordt gelezen door `app/page.tsx` vóór een nieuwe `/api/route/loop`-
 * aanvraag, om als `avoidRouteEdgeSets` mee te sturen naar de Route Engine
 * (server-side dedup tegen geschiedenis, `generateLoopRoutes`).
 */

const STORAGE_KEY = "goknoop.riddenRoutes.v1";
const MAX_STORED_ROUTES = 20; // begrenzing -- voorkomt onbeperkte groei van de request-payload

export type RiddenRoute = {
  edgeIds: string[];
  nodeIds: string[];
  startNodeId: string;
  distanceM: number;
  riddenAt: string; // ISO-datum
};

function isRiddenRoute(value: unknown): value is RiddenRoute {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.edgeIds) &&
    Array.isArray(v.nodeIds) &&
    typeof v.startNodeId === "string" &&
    typeof v.distanceM === "number" &&
    typeof v.riddenAt === "string"
  );
}

/**
 * Haalt de opgeslagen gereden routes op, meest recente eerst. Geeft een
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

/**
 * Slaat een nieuw gereden route op, meest recente eerst, begrensd tot
 * `MAX_STORED_ROUTES`. Best-effort -- een opslagfout (bijv. vol/geblokkeerd
 * localStorage) mag de navigatie zelf nooit breken, dus faalt stil.
 */
export function recordRiddenRoute(route: Omit<RiddenRoute, "riddenAt"> & { riddenAt?: string }): void {
  if (typeof window === "undefined") return;
  try {
    const existing = getRiddenRoutes();
    const entry: RiddenRoute = { ...route, riddenAt: route.riddenAt ?? new Date().toISOString() };
    const updated = [entry, ...existing].slice(0, MAX_STORED_ROUTES);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Best-effort: opslagfout mag de navigatie-ervaring niet verstoren.
  }
}
