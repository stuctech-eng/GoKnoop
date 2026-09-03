/**
 * Gepauzeerde-rit-snapshot (Pauzeknop, GOKNOOP-MASTER.md sectie 9.19,
 * 30-8-2026). Puur browserlokaal (localStorage) -- zelfde reden/patroon als
 * `ridden-routes-store.ts`/`saved-routes-store.ts`. EEN actieve gepauzeerde
 * rit tegelijk (geen lijst) -- pauzeren overschrijft een eventuele vorige
 * snapshot.
 *
 * Bewust GEEN volledige geometrie opgeslagen (zelfde reden als
 * `SavedRoute`, sectie 6F): alleen `routeNodes`/`routeEdges` (ID's), vers op
 * te halen bij hervatten via het bestaande `POST /api/route/resolve` --
 * geen dubbele opslaglaag, geen kans op een verouderde/afwijkende geometrie.
 */

import type { PhysicalAnchor } from "./physical-anchor";

const STORAGE_KEY = "goknoop.pausedRide.v1";

export type PausedRideSnapshot = {
  routeNodes: string[];
  routeEdges: string[];
  datasetVersionId: string;
  physicalStart: PhysicalAnchor | null;
  lastKnownPosition: { lat: number; lon: number } | null;
  distanceTraveledM: number;
  rideTimeS: number;
  /** BUGFIX (sectie 9.41, 30-8-2026): of de matching al echt gestart was (fase C bereikt) op
   *  het moment van pauzeren -- bepaalt bij hervatten of fase A/B overgeslagen mag worden.
   *  Optioneel voor achterwaartse compatibiliteit met eerder opgeslagen pauzes (vóór deze
   *  bugfix) -- ontbreekt het veld, dan wordt veilig aangenomen dat de sessie nog niet
   *  gestart was (dus gewoon fase A/B opnieuw doorlopen bij hervatten). */
  hasSessionStarted?: boolean;
  pausedAt: string; // ISO-datum
};

function isPausedRideSnapshot(value: unknown): value is PausedRideSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.routeNodes) &&
    Array.isArray(v.routeEdges) &&
    typeof v.datasetVersionId === "string" &&
    (v.physicalStart === null || typeof v.physicalStart === "object") &&
    (v.lastKnownPosition === null || typeof v.lastKnownPosition === "object") &&
    typeof v.distanceTraveledM === "number" &&
    typeof v.rideTimeS === "number" &&
    (v.hasSessionStarted === undefined || typeof v.hasSessionStarted === "boolean") &&
    typeof v.pausedAt === "string"
  );
}

/** Geeft de actieve gepauzeerde rit terug, of null als er geen is / de opslag corrupt is. */
export function getPausedRide(): PausedRideSnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isPausedRideSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Slaat de huidige rit op als gepauzeerd (overschrijft een eventuele vorige snapshot). Best-effort. */
export function savePausedRide(snapshot: Omit<PausedRideSnapshot, "pausedAt"> & { pausedAt?: string }): void {
  if (typeof window === "undefined") return;
  try {
    const entry: PausedRideSnapshot = { ...snapshot, pausedAt: snapshot.pausedAt ?? new Date().toISOString() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // Best-effort: opslagfout mag de app niet breken.
  }
}

/** Wist de gepauzeerde rit -- bij hervatten (rit gaat weer actief) of bij "Rit beëindigen". */
export function clearPausedRide(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}
