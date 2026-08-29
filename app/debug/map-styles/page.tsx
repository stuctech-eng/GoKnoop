"use client";

/**
 * Kaartstijl-vergelijking (GOKNOOP-MASTER.md sectie 7, stap 12.3A).
 *
 * Toont OpenFreeMap Positron en Liberty naast elkaar, op straatniveau-zoom
 * bij een echte Nederlandse locatie -- puur om een stijlkeuze te maken vóór
 * er route-code komt (12.3B+). Geen route, geen GPS, geen navigatielogica.
 *
 * Hergebruikt de worker-URL-fix uit 12.2 (app/debug/map/page.tsx): MapLibre
 * v6 + Turbopack vereist zelf-gehoste workerbestanden in public/.
 */

import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}

// Utrecht centrum, straatniveau -- dezelfde regio als eerdere stap 11-tests.
const CENTER: [number, number] = [5.1214, 52.0907];
const ZOOM = 14;

function useStyleMap(styleUrl: string) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureWorkerUrlConfigured();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: CENTER,
      zoom: ZOOM,
      bearing: 0,
      pitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return containerRef;
}

export default function MapStyleComparisonPage() {
  const positronRef = useStyleMap("https://tiles.openfreemap.org/styles/positron");
  const libertyRef = useStyleMap("https://tiles.openfreemap.org/styles/liberty");

  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100dvh" }}>
      <div style={{ position: "relative", flex: 1, borderBottom: "2px solid #085041" }}>
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            zIndex: 10,
            background: "rgba(255,255,255,0.92)",
            borderRadius: 6,
            padding: "4px 10px",
            fontFamily: "monospace",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Positron
        </div>
        <div ref={positronRef} style={{ position: "absolute", inset: 0 }} />
      </div>

      <div style={{ position: "relative", flex: 1 }}>
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            zIndex: 10,
            background: "rgba(255,255,255,0.92)",
            borderRadius: 6,
            padding: "4px 10px",
            fontFamily: "monospace",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Liberty
        </div>
        <div ref={libertyRef} style={{ position: "absolute", inset: 0 }} />
      </div>
    </div>
  );
}
