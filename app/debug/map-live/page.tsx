"use client";

/**
 * Live-positie-debugpagina (GOKNOOP-MASTER.md sectie 7, stap 12.4).
 *
 * KERNARCHITECTUUR, bewaakt in dit bestand: de kaartmarker wordt UITSLUITEND
 * bijgewerkt vanuit een geaccepteerde `DeviationOutcome`
 * (`reported_on_route`/`reported_deviation`) van `DeviationDetector`, die op
 * zijn beurt alleen zo'n uitkomst teruggeeft ná een succesvolle
 * `NavigationStateMachine`-transitie. Er is geen enkel pad waarin een ruwe
 * `GpsSample` rechtstreeks de marker beweegt:
 *
 *   GPS → GpsFixEvaluator → candidate matcher → MatchedPosition
 *       → NavigationStateMachine (reportOnRoute/reportDeviation)
 *       → DeviationOutcome (alleen bij geaccepteerde transitie)
 *       → buildPositionMarkerGeoJson (lib/map/) → MapLibre-marker
 *
 * Bewust GEEN grote richtingpijl, GEEN Start Guidance, GEEN progress-UI --
 * die horen bij latere stappen (12.5/12.6/12.7). Dit bestand toont alleen
 * dát de positie correct via de bestaande keten op de kaart verschijnt.
 *
 * NavigationSessionController blijft eigenaar van de navigatiestatus; deze
 * pagina leest er alleen van, muteert niets buiten wat de controller zelf
 * al doet.
 */

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { SystemNavigationClock } from "@/lib/navigation/clock/navigation-clock";
import { NavigationStateMachine } from "@/lib/navigation/session/navigation-state-machine";
import { DeviationDetector } from "@/lib/navigation/deviation/deviation-detector";
import { NavigationSessionController } from "@/lib/navigation/lifecycle/navigation-session-controller";
import { BrowserGeolocationSource } from "@/lib/navigation/gps-sources/browser-geolocation-source";
import { buildRouteProgressModel, calculateProgress, calculateNextNodeInfo } from "@/lib/navigation/progress/route-progress-model";
import { buildRouteGeoJson } from "@/lib/map/route-geometry-adapter";
import { buildPositionMarkerGeoJson } from "@/lib/map/position-marker-adapter";
import type { GraphEdge } from "@/lib/route-engine/types";
import type { NavigationState } from "@/lib/navigation/types";

let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}

const LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const ROUTE_COLOR = "#085041";

// Zelfde testroute als stap 12.3 (app/debug/map-route/page.tsx) -- bewust identiek,
// zodat deze pagina puur de LIVE-POSITIE-laag toevoegt, geen nieuwe route introduceert.
const TEST_EDGES: GraphEdge[] = [
  { id: "test-e1", fromLogicalNodeId: "12", toLogicalNodeId: "34", distanceM: 620, directionality: "bidirectional", geometry: [{ x: 136000, y: 456000 }, { x: 136050, y: 456300 }, { x: 136000, y: 456600 }] },
  { id: "test-e2", fromLogicalNodeId: "34", toLogicalNodeId: "56", distanceM: 450, directionality: "bidirectional", geometry: [{ x: 136000, y: 456600 }, { x: 136400, y: 456750 }] },
  { id: "test-e3", fromLogicalNodeId: "56", toLogicalNodeId: "78", distanceM: 380, directionality: "bidirectional", geometry: [{ x: 136400, y: 456750 }, { x: 136400, y: 457130 }] },
];
const TEST_NODE_IDS = ["12", "34", "56", "78"];

const CONFIRM_MS = 5000;
const COOLDOWN_MS = 10000;

// Statusweergave per NavigationState (stap 12.6) -- puur weergave, geen nieuwe
// navigatielogica. Beknopte, niet-alarmistische labels (ontwerpregel: afwijking
// duidelijk maar niet alarmistisch tonen).
const STATE_STYLE: Record<NavigationState, { label: string; color: string; background: string }> = {
  NOT_STARTED: { label: "Niet gestart", color: "#555", background: "#eee" },
  ON_ROUTE: { label: "Op route", color: "#FFFFFF", background: "#1a7a3c" },
  POSSIBLE_DEVIATION: { label: "Mogelijk afgeweken", color: "#5a4200", background: "#ffe08a" },
  OFF_ROUTE: { label: "Van route af", color: "#FFFFFF", background: "#b00020" },
  REROUTING: { label: "Nieuwe route zoeken...", color: "#FFFFFF", background: "#3a5fcd" },
  REROUTED: { label: "Nieuwe route gevonden", color: "#FFFFFF", background: "#3a5fcd" },
  GPS_LOST: { label: "GPS-signaal kwijt", color: "#FFFFFF", background: "#666" },
  PAUSED: { label: "Gepauzeerd", color: "#555", background: "#eee" },
  ARRIVED: { label: "Aangekomen", color: "#FFFFFF", background: "#085041" },
  CANCELLED: { label: "Gestopt", color: "#555", background: "#eee" },
  PERMISSION_DENIED: { label: "Locatietoestemming geweigerd", color: "#FFFFFF", background: "#8a5a00" },
};

export default function MapLiveDebugPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sourceRef = useRef<BrowserGeolocationSource | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const [mapStatus, setMapStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [nextNode, setNextNode] = useState<{ nodeId: string; distanceM: number; bearingDeg: number } | null>(null);
  const [progressInfo, setProgressInfo] = useState<{ ratio: number; distanceAlongM: number; totalM: number } | null>(null);
  const [navState, setNavState] = useState<NavigationState>("NOT_STARTED");
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  function appendLog(text: string) {
    setLog((prev) => [`${new Date().toISOString().slice(11, 23)} — ${text}`, ...prev].slice(0, 20));
  }

  // Kaart + route eenmalig opzetten (stap 12.3, ongewijzigd hergebruikt).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureWorkerUrlConfigured();

    let geoJson: ReturnType<typeof buildRouteGeoJson>;
    try {
      const model = buildRouteProgressModel(TEST_EDGES);
      geoJson = buildRouteGeoJson(model, TEST_NODE_IDS);
    } catch (err) {
      setMapStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: LIBERTY_STYLE_URL,
      bearing: 0,
      pitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
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
        paint: { "circle-radius": 9, "circle-color": "#FFFFFF", "circle-stroke-color": ROUTE_COLOR, "circle-stroke-width": 3 },
      });
      map.addLayer({
        id: "goknoop-route-nodes-label",
        type: "symbol",
        source: "goknoop-route-nodes",
        layout: { "text-field": ["get", "nodeId"], "text-size": 11, "text-font": ["Noto Sans Bold"] },
        paint: { "text-color": ROUTE_COLOR },
      });

      // Live-positiemarker (stap 12.4, NIEUW): duidelijk onderscheiden van route/knooppunten --
      // solide teal vulling + witte rand (omgekeerd van de knooppuntstijl: witte vulling +
      // teal rand). Bewust nog GEEN richtingpijl -- die hoort bij de volgende navigatielaag.
      map.addSource("goknoop-position", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "goknoop-position-circle",
        type: "circle",
        source: "goknoop-position",
        paint: {
          "circle-radius": 8,
          "circle-color": ROUTE_COLOR,
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 3,
        },
      });

      map.fitBounds(geoJson.bounds, { padding: 60, animate: false });
      setMapStatus("loaded");
    });

    map.on("error", (e) => {
      setMapStatus("error");
      setError(e?.error?.message ?? "Onbekende MapLibre-fout.");
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

  function start() {
    setError(null);
    const map = mapRef.current;
    if (!map) return;

    const clock = new SystemNavigationClock();
    const stateMachine = new NavigationStateMachine({ deviationConfirmDurationMs: CONFIRM_MS, rerouteCooldownMs: COOLDOWN_MS });
    const model = buildRouteProgressModel(TEST_EDGES);
    const detector = new DeviationDetector(model.geometry, stateMachine, clock, {
      deviationThresholdM: 20,
      accuracyThresholdM: 25,
      gpsTimeoutMs: 10000,
      matchOptions: { baseWindowM: 100, windowMarginPerMps: 10, weights: { distance: 1, heading: 0.1, continuity: 0.5 } },
    });
    const controller = new NavigationSessionController(detector, stateMachine);

    let sessionStarted = false;

    let source: BrowserGeolocationSource;
    try {
      source = new BrowserGeolocationSource({
        enableHighAccuracy: true,
        onError: (err) => {
          appendLog(`GPS-fout: [${err.code}] ${err.message}`);
          if (err.code === 1) {
            try {
              controller.denyPermission();
              setNavState(stateMachine.getState());
            } catch {
              /* al in een niet-relevante state */
            }
            setRunning(false);
          }
          setError(err.message);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const unsubscribe = source.subscribe((sample) => {
      if (!sessionStarted) {
        try {
          stateMachine.start();
          sessionStarted = true;
        } catch {
          return;
        }
      }

      const outcome = controller.processGpsSample(sample);
      setNavState(stateMachine.getState());

      // KERNPUNT: de marker wordt UITSLUITEND bijgewerkt op basis van een geaccepteerde
      // DeviationOutcome (dus ná matching + een geldige state-machine-transitie) -- nooit
      // rechtstreeks vanuit `sample`.
      if (outcome.action === "reported_on_route" || outcome.action === "reported_deviation") {
        const markerFeature = buildPositionMarkerGeoJson(outcome.matchedPosition);
        const src = mapRef.current?.getSource("goknoop-position") as maplibregl.GeoJSONSource | undefined;
        src?.setData({ type: "FeatureCollection", features: [markerFeature] });

        // Niveau 1 (richting, stap 12.5): dezelfde matchedPosition hergebruikt, geen
        // nieuwe matching/positiebepaling -- alleen afgeleide weergave-informatie.
        const progress = calculateProgress(model, outcome.matchedPosition);
        const info = calculateNextNodeInfo(model, progress, outcome.matchedPosition, TEST_NODE_IDS);
        setNextNode({ nodeId: info.nextNodeId, distanceM: info.distanceToNextNodeM, bearingDeg: info.bearingToNextNodeDeg });
        setProgressInfo({ ratio: progress.progressRatio, distanceAlongM: progress.distanceAlongRouteM, totalM: model.totalDistanceM });

        appendLog(`positie bijgewerkt (${outcome.action}), perpendicularDistanceM=${markerFeature.properties.perpendicularDistanceM.toFixed(1)}`);
      } else {
        appendLog(`sample afgewezen: ${outcome.action}${"reason" in outcome ? ` (${outcome.reason})` : ""}`);
      }
    });

    source.start();
    sourceRef.current = source;
    unsubscribeRef.current = unsubscribe;
    setRunning(true);
    appendLog("Sessie gestart, wacht op eerste GPS-fix...");
  }

  function stop() {
    sourceRef.current?.stop();
    unsubscribeRef.current?.();
    sourceRef.current = null;
    unsubscribeRef.current = null;
    setRunning(false);
    appendLog("Sessie gestopt.");
  }

  useEffect(() => {
    return () => {
      sourceRef.current?.stop();
      unsubscribeRef.current?.();
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100%", height: "100dvh" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {nextNode && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 10,
            background: "#085041",
            borderRadius: 16,
            padding: "12px 24px",
            textAlign: "center",
            boxShadow: "0 2px 12px rgba(0,0,0,0.25)",
          }}
        >
          <div
            style={{
              fontSize: 32,
              lineHeight: 1,
              color: "#FFFFFF",
              transform: `rotate(${nextNode.bearingDeg}deg)`,
              transition: "transform 0.3s ease",
            }}
          >
            ↑
          </div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "#FFFFFF", marginTop: 2 }}>Knooppunt {nextNode.nodeId}</div>
          <div style={{ fontSize: 14, color: "#9FE1CB" }}>{Math.round(nextNode.distanceM)} m</div>
        </div>
      )}

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
          maxWidth: 200,
          zIndex: 10,
        }}
      >
        <div style={{ marginBottom: 6 }}>
          <span
            style={{
              display: "inline-block",
              background: STATE_STYLE[navState].background,
              color: STATE_STYLE[navState].color,
              borderRadius: 6,
              padding: "3px 8px",
              fontSize: 11,
              fontWeight: 600,
            }}
          >
            {STATE_STYLE[navState].label}
          </span>
        </div>
        <div><strong>map:</strong> {mapStatus}</div>
        <div><strong>nav state:</strong> {navState}</div>
        {error && <div style={{ color: "#b00020" }}>{error}</div>}
      </div>

      <button
        onClick={running ? stop : start}
        disabled={mapStatus !== "loaded"}
        style={{
          position: "absolute",
          top: 12,
          right: 60,
          zIndex: 10,
          padding: "8px 14px",
          borderRadius: 8,
          border: "none",
          background: running ? "#b00020" : "#1a7a3c",
          color: "white",
          fontSize: 13,
        }}
      >
        {running ? "Stop" : "Start"}
      </button>

      {progressInfo && (
        <div
          style={{
            position: "absolute",
            bottom: 164,
            left: 12,
            right: 12,
            background: "rgba(255,255,255,0.92)",
            borderRadius: 12,
            padding: "10px 14px",
            zIndex: 10,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6 }}>
            <span>
              {(progressInfo.distanceAlongM / 1000).toFixed(1)} km / {(progressInfo.totalM / 1000).toFixed(1)} km
            </span>
            <strong>{Math.round(progressInfo.ratio * 100)}%</strong>
          </div>
          <div style={{ height: 6, background: "#e0e0e0", borderRadius: 4, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, progressInfo.ratio * 100))}%`,
                background: "#085041",
              }}
            />
          </div>
        </div>
      )}

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
