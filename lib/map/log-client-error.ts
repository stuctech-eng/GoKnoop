import type * as maplibregl from "maplibre-gl";

/**
 * Logt een MapLibre-fout met rijke context (centrum, zoom, stijl) naar
 * /api/debug/log-client-error. Toegevoegd 6-9-2026 n.a.v. een
 * "i.codePointAt is not a function"-crash in Lochem die met alleen
 * `e?.error?.message` niet te herleiden was -- fire-and-forget, mag de UI
 * nooit blokkeren of zelf een fout gooien.
 */
export function logMapError(map: maplibregl.Map, errorEvent: unknown, screenName: string, styleUrl: string) {
  try {
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
    };
    const message =
      errorEvent && typeof errorEvent === "object" && "error" in errorEvent
        ? ((errorEvent as { error?: { message?: string } }).error?.message ?? "Onbekende kaartfout.")
        : "Onbekende kaartfout.";
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
