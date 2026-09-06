import type * as maplibregl from "maplibre-gl";

const RECENT_LOG_THROTTLE_MS = 3000;
let lastLoggedMessage: string | null = null;
let lastLoggedAt = 0;

/**
 * Logt een MapLibre-fout met rijke context (centrum, zoom, stijl) naar
 * /api/debug/log-client-error. Toegevoegd 6-9-2026 n.a.v. een
 * "i.codePointAt is not a function"-crash in Lochem die met alleen
 * `e?.error?.message` niet te herleiden was -- fire-and-forget, mag de UI
 * nooit blokkeren of zelf een fout gooien. Throttled: dezelfde foutmelding
 * wordt maximaal 1x per 3s gelogd, om te voorkomen dat een herhalende fout
 * (zoals hierboven) tientallen documenten per seconde wegschrijft.
 */
export function logMapError(
  map: maplibregl.Map,
  errorEvent: unknown,
  screenName: string,
  styleUrl: string,
  patchStatus?: { patched: boolean; patchedLayerCount: number; fallbackReason: string | null }
) {
  try {
    const message =
      errorEvent && typeof errorEvent === "object" && "error" in errorEvent
        ? ((errorEvent as { error?: { message?: string } }).error?.message ?? "Onbekende kaartfout.")
        : "Onbekende kaartfout.";

    const now = Date.now();
    if (message === lastLoggedMessage && now - lastLoggedAt < RECENT_LOG_THROTTLE_MS) {
      return; // zelfde fout te snel achter elkaar -- niet opnieuw loggen
    }
    lastLoggedMessage = message;
    lastLoggedAt = now;

    const center = map.getCenter();
    const context = {
      screen: screenName,
      styleUrl,
      centerLat: center.lat,
      centerLon: center.lng,
      zoom: map.getZoom(),
      bearing: map.getBearing(),
      pitch: map.getPitch(),
      timestamp: new Date().toISOString(),
      // Toegevoegd 6-9-2026 n.a.v. productielogs die de crash NA het live gaan
      // van de to-string()-patch nog steeds toonden -- dit maakt zichtbaar of
      // de patch daadwerkelijk actief was op het moment van deze fout, i.p.v.
      // stil te zijn teruggevallen op de ongepatchte stijl.
      toStringPatchActive: patchStatus?.patched ?? null,
      toStringPatchedLayerCount: patchStatus?.patchedLayerCount ?? null,
      toStringPatchFallbackReason: patchStatus?.fallbackReason ?? null,
    };
    const stack =
      errorEvent && typeof errorEvent === "object" && "error" in errorEvent
        ? ((errorEvent as { error?: { stack?: string } }).error?.stack ?? null)
        : null;

    fetch("/api/debug/log-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, stack, context }),
    }).catch(() => {
      // Bewust genegeerd -- logging mag de app nooit breken.
    });
  } catch {
    // Idem: defensief, nooit de eigenlijke error-handler laten crashen op de logger zelf.
  }
}
