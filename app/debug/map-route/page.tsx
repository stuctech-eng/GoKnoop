"use client";

/**
 * Routevisualisatie-debugpagina (GOKNOOP-MASTER.md sectie 7, stap 12.3F).
 *
 * Toont een vaste test-Route op OpenFreeMap Liberty: de route zelf
 * (donker-teal), de knooppunten (echte nummers, geen fictieve), en
 * auto-fit op de routebounds. Bewust GEEN live GPS, GEEN positie-marker,
 * GEEN navigatiepijl, GEEN deviation/rerouting-logica (sectie 3 van de
 * 12.3-briefing) -- uitsluitend "Route → kaartvisualisatie".
 *
 * De testroute hieronder is een handmatige fixture (drie edges, inclusief
 * een lichte knik) -- puur om de visualisatie te bewijzen, geen vervanging
 * van de Route Engine. `buildRouteProgressModel`/`buildRouteGeoJson` zijn
 * dezelfde functies die ook in productie gebruikt zouden worden met een
 * echte, door de Route Engine berekende Route.
 */

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { buildRouteProgressModel } from "@/lib/navigation/progress/route-progress-model";
import { buildRouteGeoJson } from "@/lib/map/route-geometry-adapter";
import type { GraphEdge } from "@/lib/route-engine/types";

let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}

const LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";

// Vaste testroute (RD New), Utrecht-omgeving -- drie edges met een knik, om
// meerdere segmenten en een niet-triviale vorm te tonen (test 2 uit de
// 12.3-briefing: meerdere edges, juiste volgorde, geen ontbrekende stukken).
const TEST_EDGES: GraphEdge[] = [
  {
    id: "test-e1",
    fromLogicalNodeId: "12",
    toLogicalNodeId: "34",
    distanceM: 620,
    directionality: "bidirectional",
    geometry: [
      { x: 136000, y: 456000 },
      { x: 136050, y: 456300 },
      { x: 136000, y: 456600 },
    ],
  },
  {
    id: "test-e2",
    fromLogicalNodeId: "34",
    toLogicalNodeId: "56",
    distanceM: 450,
    directionality: "bidirectional",
    geometry: [
      { x: 136000, y: 456600 },
      { x: 136400, y: 456750 },
    ],
  },
  {
    id: "test-e3",
    fromLogicalNodeId: "56",
    toLogicalNodeId: "78",
    distanceM: 380,
    directionality: "bidirectional",
    geometry: [
      { x: 136400, y: 456750 },
      { x: 136400, y: 457130 },
    ],
  },
];
const TEST_NODE_IDS = ["12", "34", "56", "78"]; // echte knooppuntnummer-stijl, geen fictieve labels

const ROUTE_COLOR = "#085041"; // GoKnoop-donkerteal, zelfde als de UX-wireframe (12.1)

export default function MapRouteDebugPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  function appendLog(text: string) {
    setLog((prev) => [`${new Date().toISOString().slice(11, 23)} — ${text}`, ...prev].slice(0, 20));
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureWorkerUrlConfigured();

    let geoJson: ReturnType<typeof buildRouteGeoJson>;
    try {
      const model = buildRouteProgressModel(TEST_EDGES, TEST_NODE_IDS);
      geoJson = buildRouteGeoJson(model, TEST_NODE_IDS);
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      appendLog(`Route-adapter-fout: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: LIBERTY_STYLE_URL,
        bearing: 0,
        pitch: 0,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: { compact: true },
      });
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      appendLog(`Kaart-initialisatie mislukt: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");

    map.on("load", () => {
      map.addSource("goknoop-route-line", { type: "geojson", data: geoJson.line as GeoJSON.Feature });
      map.addLayer({
        id: "goknoop-route-line",
        type: "line",
        source: "goknoop-route-line",
        layout: { "line-join": "round", "line-cap": "round" },
        paint: { "line-color": ROUTE_COLOR, "line-width": 5 },
      });

      map.addSource("goknoop-route-nodes", { type: "geojson", data: geoJson.nodes as GeoJSON.FeatureCollection });
      map.addLayer({
        id: "goknoop-route-nodes-circle",
        type: "circle",
        source: "goknoop-route-nodes",
        paint: {
          "circle-radius": 9,
          "circle-color": "#FFFFFF",
          "circle-stroke-color": ROUTE_COLOR,
          "circle-stroke-width": 3,
        },
      });
      map.addLayer({
        id: "goknoop-route-nodes-label",
        type: "symbol",
        source: "goknoop-route-nodes",
        layout: {
          "text-field": ["get", "nodeId"],
          "text-size": 11,
          "text-font": ["Noto Sans Bold"],
        },
        paint: { "text-color": ROUTE_COLOR },
      });

      // Auto-fit (12.3E): de volledige route in beeld, met marge voor toekomstige UI-elementen.
      map.fitBounds(geoJson.bounds, { padding: 60, animate: false });

      setStatus("loaded");
      appendLog(`Route getekend: ${TEST_EDGES.length} edges, ${TEST_NODE_IDS.length} knooppunten, auto-fit toegepast.`);
    });

    map.on("error", (e) => {
      setStatus("error");
      const message = e?.error?.message ?? "Onbekende MapLibre-fout.";
      setErrorMessage(message);
      appendLog(`MapLibre-fout: ${message}`);
    });

    const handleResize = () => map.resize();
    window.addEventListener("resize", handleResize);
    window.addEventListener("orientationchange", handleResize);

    mapRef.current = map;

    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("orientationchange", handleResize);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100dvh" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      <div
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          background: "rgba(255,255,255,0.92)",
          borderRadius: 8,
          padding: "8px 12px",
          fontFamily: "monospace",
          fontSize: 12,
          maxWidth: 260,
          zIndex: 10,
        }}
      >
        <div>
          <strong>status:</strong> {status}
        </div>
        {errorMessage && <div style={{ color: "#b00020" }}>{errorMessage}</div>}
      </div>

      <div
        style={{
          position: "absolute",
          bottom: 12,
          left: 12,
          right: 12,
          background: "rgba(255,255,255,0.92)",
          borderRadius: 8,
          padding: "8px 12px",
          fontFamily: "monospace",
          fontSize: 11,
          maxHeight: 140,
          overflowY: "auto",
          zIndex: 10,
        }}
      >
        {log.map((entry, i) => (
          <div key={i}>{entry}</div>
        ))}
      </div>
    </div>
  );
}
