/**
 * "Mijn routes"-opslag (Fase 3, GOKNOOP-MASTER.md sectie 6F, 29-8-2026).
 *
 * BEWUST GESCHEIDEN van `ridden-routes-store.ts` (Fase 2) -- dit zijn
 * routes die de gebruiker EXPLICIET de moeite waard vindt om te bewaren
 * (♡ Opslaan in Mijn routes), niet de automatische gereden-geschiedenis.
 * Twee verschillende datamodellen, geen vermenging, zoals afgesproken.
 *
 * Puur browserlokaal (localStorage) -- zelfde reden als Fase 2, geen
 * gebruikersaccount-systeem. Bewaart UITSLUITEND lichte referenties
 * (edgeIds/nodeIds/datasetVersionId), GEEN volledige geometrie -- die wordt
 * bij het opnieuw starten opgehaald via `POST /api/route/resolve`. Dat
 * houdt de opslag klein en voorkomt dat een bewaarde route veroudert als de
 * onderliggende dataset ooit verandert (dan geeft de resolve-aanroep een
 * duidelijke fout, geen stille corruptie).
 */

const STORAGE_KEY = "goknoop.savedRoutes.v1";

export type SavedRoute = {
  id: string;
  /** null = de gebruiker heeft geen naam gegeven -- UI toont dan "Route van [datum]". */
  name: string | null;
  edgeIds: string[];
  nodeIds: string[];
  startNodeId: string;
  distanceM: number;
  datasetVersionId: string;
  savedAt: string; // ISO-datum
};

function isSavedRoute(value: unknown): value is SavedRoute {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    (v.name === null || typeof v.name === "string") &&
    Array.isArray(v.edgeIds) &&
    Array.isArray(v.nodeIds) &&
    typeof v.startNodeId === "string" &&
    typeof v.distanceM === "number" &&
    typeof v.datasetVersionId === "string" &&
    typeof v.savedAt === "string"
  );
}

/** Meest recent opgeslagen eerst. Lege array bij ontbrekende/corrupte opslag -- geen crash. */
export function getSavedRoutes(): SavedRoute[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedRoute);
  } catch {
    return [];
  }
}

/** Slaat een nieuwe route op (voorgevoegd, meest recent eerst). Best-effort. */
export function saveRoute(route: Omit<SavedRoute, "id" | "savedAt"> & { savedAt?: string }): SavedRoute {
  const entry: SavedRoute = {
    ...route,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    savedAt: route.savedAt ?? new Date().toISOString(),
  };
  if (typeof window === "undefined") return entry;
  try {
    const existing = getSavedRoutes();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...existing]));
  } catch {
    // Best-effort: opslagfout mag de gebruikerservaring niet breken.
  }
  return entry;
}

/** Verwijdert een opgeslagen route op ID. Best-effort, geen fout als het ID niet (meer) bestaat. */
export function deleteSavedRoute(id: string): void {
  if (typeof window === "undefined") return;
  try {
    const existing = getSavedRoutes();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(existing.filter((r) => r.id !== id)));
  } catch {
    // Best-effort.
  }
}

/** Beknopt, automatisch label als de gebruiker geen naam heeft gegeven. */
export function defaultSavedRouteName(savedAt: string): string {
  const date = new Date(savedAt);
  return `Route van ${date.toLocaleDateString("nl-NL", { day: "numeric", month: "long" })}`;
}
