/**
 * Gedeelde-routes-registratie (GOKNOOP-MASTER.md sectie 9.35, 30-8-2026).
 *
 * Puur browserlokaal (localStorage) -- zelfde architectuur als
 * `saved-routes-store.ts`/`ridden-routes-store.ts`. Houdt bij WELKE route
 * je deelde en WANNEER -- "met wie" kan NIET automatisch vastgelegd worden
 * (iOS geeft na het delen niet terug welk contact/app gekozen is, een
 * bewuste privacybeperking van Apple, geen omzeilbare technische
 * beperking) -- dat veld is daarom altijd een optioneel, door de gebruiker
 * zelf achteraf in te vullen tekstveld.
 */

const STORAGE_KEY = "goknoop.sharedRoutes.v1";

export type SharedRouteRecord = {
  id: string;
  routeName: string; // naam op het moment van delen (kan later afwijken van de huidige naam)
  edgeIds: string[];
  nodeIds: string[];
  datasetVersionId: string;
  distanceM: number;
  sharedAt: string; // ISO-datum
  sharedWith: string | null; // optioneel, door de gebruiker zelf in te vullen/aan te passen
};

function isSharedRouteRecord(value: unknown): value is SharedRouteRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.routeName === "string" &&
    Array.isArray(v.edgeIds) &&
    Array.isArray(v.nodeIds) &&
    typeof v.datasetVersionId === "string" &&
    typeof v.distanceM === "number" &&
    typeof v.sharedAt === "string" &&
    (v.sharedWith === null || typeof v.sharedWith === "string")
  );
}

export function getSharedRoutes(): SharedRouteRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSharedRouteRecord);
  } catch {
    return [];
  }
}

/** Vastgelegd zodra de gebruiker "Delen" indrukt -- best-effort, geen kritiek pad. */
export function recordSharedRoute(record: Omit<SharedRouteRecord, "id" | "sharedAt" | "sharedWith">): void {
  if (typeof window === "undefined") return;
  try {
    const existing = getSharedRoutes();
    const entry: SharedRouteRecord = {
      ...record,
      id: `shared-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sharedAt: new Date().toISOString(),
      sharedWith: null,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([entry, ...existing]));
  } catch {
    // Best-effort.
  }
}

/** Achteraf "met wie" invullen/aanpassen -- kan niet automatisch, zie klasse-commentaar. */
export function updateSharedWith(id: string, sharedWith: string): void {
  if (typeof window === "undefined") return;
  try {
    const existing = getSharedRoutes();
    const updated = existing.map((r) => (r.id === id ? { ...r, sharedWith: sharedWith.trim() || null } : r));
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Best-effort.
  }
}
