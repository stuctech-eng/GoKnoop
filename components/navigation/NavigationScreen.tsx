"use client";

/**
 * NavigationScreen — herbruikbaar navigatiescherm (GOKNOOP-MASTER.md sectie 7,
 * Start-knop-koppeling). Gedeeld door zowel de echte Phase 3-flow
 * (`app/page.tsx`, ná routekeuze) als de debugharness
 * (`app/debug/map-live/page.tsx`, met een vaste testroute) -- exact dezelfde
 * code, geen tweede/afwijkende navigatie-implementatie.
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
 * Drieledige voorfasering (sectie 5.4, stap 12.7): 🚲 Naar startpunt →
 * 🧭 Start Guidance → ➤ Navigatie, via `determinePreNavigationPhase`
 * (lib/navigation/session/), geen losse if/else-logica hier.
 *
 * NavigationSessionController blijft eigenaar van de navigatiestatus; dit
 * component leest er alleen van, muteert niets buiten wat de controller
 * zelf al doet. `lib/navigation/` en `lib/route-engine/` kennen MapLibre
 * niet -- dat blijft uitsluitend hier en in `lib/map/`.
 *
 * Route blijft immutable: de meegegeven `edges`/`nodeSequence` representeren de
 * door de gebruiker gekozen route. Een eventuele reroute (nog niet in dit
 * component aangesloten op een live Route Engine-aanroep) zou een NIEUW
 * `Route`-object opleveren, nooit een mutatie van de oorspronkelijke keuze.
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
import { distanceBetween, bearingDegrees } from "@/lib/navigation/matching/geometry";
import { determinePreNavigationPhase } from "@/lib/navigation/session/pre-navigation-phase";
import { selectHeadingDeg, smoothHeadingDeg, relativeAngleDeg } from "@/lib/navigation/direction/relative-direction";
import type { PreNavigationPhase } from "@/lib/navigation/session/pre-navigation-phase";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import { buildRouteGeoJson } from "@/lib/map/route-geometry-adapter";
import { buildPositionMarkerGeoJson } from "@/lib/map/position-marker-adapter";
import { recordRiddenRoute } from "@/lib/history/ridden-routes-store";
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

const CONFIRM_MS = 5000;
const COOLDOWN_MS = 10000;
// Drieledige voorfasering (sectie 5.4, stap 12.7) -- uitgangspunten, net als de
// overige kalibratiewaarden nog niet definitief vastgezet (sectie 3.7).
const ARRIVAL_AT_START_THRESHOLD_M = 25;
const MOVEMENT_SPEED_THRESHOLD_MPS = 0.5;
// Fase 2 (gereden-routes-tracking, 29-8-2026): aankomstdrempel voor het EINDE van de route --
// zelfde uitgangspunt/orde-grootte als de startdrempel, ook nog niet definitief vastgezet.
const ARRIVAL_AT_END_THRESHOLD_M = 25;
// Heading-up navigatie (sectie 6C/6G, 29-8-2026): kaart draait mee met de rijrichting en
// zoomt dichterbij, UITSLUITEND tijdens fase NAVIGATING -- fase A/B blijven bewust
// noordgericht (sectie 5.3/10), heading-up is specifiek voor het actief navigeren.
const NAVIGATION_ZOOM = 17.5;
const HEADING_SMOOTHING_ALPHA = 0.35; // uitgangspunt, nog niet definitief (zelfde discipline als sectie 3.7)

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

export type NavigationScreenProps = {
  /** De gekozen route, als volledige GraphEdge[] (Route Engine → GraphEdge[], zie de dataketen-fix). */
  edges: GraphEdge[];
  /**
   * Route.nodes[] -- de ECHTE, interne logicalNodeId's, lengte edges.length + 1.
   * Nodig voor `buildRouteProgressModel`'s richtingscorrectie (bugfix 29-8-2026:
   * een edge kan bidirectioneel doorlopen worden, de brongeometrie ligt vast in
   * één richting) -- NIET voor weergave, dat is `nodeDisplayNumbers`.
   */
  nodeSequence: string[];
  /**
   * Echte knooppuntnummers (GraphNode.displayNumber), zelfde lengte/volgorde als
   * `nodeSequence` -- uitsluitend voor UI-tekst/kaartlabels. Bewust een apart
   * veld: `nodeSequence` en `nodeDisplayNumbers` zijn NIET dezelfde waarden
   * (interne Firestore-ID versus mensleesbaar nummer) -- ze door elkaar
   * gebruiken was precies de eerdere "9CHmIH3BmYvDp7wmARBq i.p.v. 96"-bug.
   */
  nodeDisplayNumbers: string[];
  /** Route.datasetVersionId -- gepind voor deze sessie (ontwerp sectie 19), nog niet actief gebruikt voor een live reroute-aanroep in dit component. */
  datasetVersionId: string;
  /** Aangeroepen wanneer de gebruiker de navigatie expliciet verlaat/stopt. */
  onExit?: () => void;
};

export default function NavigationScreen({ edges, nodeSequence, nodeDisplayNumbers, datasetVersionId, onExit }: NavigationScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sourceRef = useRef<BrowserGeolocationSource | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const hasRecordedArrivalRef = useRef(false);
  const smoothedHeadingRef = useRef<number | null>(null);

  const [mapStatus, setMapStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [nextNode, setNextNode] = useState<{ nodeId: string; distanceM: number; bearingDeg: number } | null>(null);
  const [progressInfo, setProgressInfo] = useState<{ ratio: number; distanceAlongM: number; totalM: number } | null>(null);
  const [phase, setPhase] = useState<PreNavigationPhase>("TO_START");
  const [startInfo, setStartInfo] = useState<{ nodeId: string; distanceM: number; bearingDeg: number } | null>(null);
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
      const model = buildRouteProgressModel(edges, nodeSequence);
      geoJson = buildRouteGeoJson(model, nodeDisplayNumbers);
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
        paint: { "circle-radius": 10, "circle-color": "#FFFFFF", "circle-stroke-color": ROUTE_COLOR, "circle-stroke-width": 3 },
      });
      map.addLayer({
        id: "goknoop-route-nodes-label",
        type: "symbol",
        source: "goknoop-route-nodes",
        layout: { "text-field": ["get", "nodeId"], "text-size": 12, "text-font": ["Noto Sans Bold"] },
        paint: { "text-color": ROUTE_COLOR },
      });

      // Live-positiemarker (stap 12.4, gepolijst 29-8-2026): subtiel blauw stipje --
      // bewust anders dan de teal route/knooppunten, zodat "waar ben ik" nooit met de
      // route zelf verward wordt. De ROUTE blijft teal (geen Google-blauwe navigatielijn),
      // alleen de positie-indicator gebruikt het gangbare "hier ben je"-blauw.
      map.addSource("goknoop-position", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      map.addLayer({
        id: "goknoop-position-circle",
        type: "circle",
        source: "goknoop-position",
        paint: {
          "circle-radius": 7,
          "circle-color": "#3B82F6",
          "circle-stroke-color": "#FFFFFF",
          "circle-stroke-width": 3,
        },
      });

      // Asymmetrische marge: bovenin is de richtingkaart veel hoger dan 60px, onderin staan de
      // voortgangsbalk + het logpaneel -- een uniforme marge liet de route daaronder wegvallen.
      map.fitBounds(geoJson.bounds, { padding: { top: 180, bottom: 140, left: 40, right: 40 }, animate: false });
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
    const model = buildRouteProgressModel(edges, nodeSequence);
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
      // Fase A/B/C bepalen (stap 12.7) -- vóór sessiestart: alleen de afstand tot het
      // startknooppunt is relevant, geen matching (er is nog geen actieve navigatie).
      const rdPosition = wgs84ToRd(sample.lat, sample.lon);
      const distanceToStartM = distanceBetween(rdPosition, model.geometry[0]);
      const currentPhase = determinePreNavigationPhase({
        sessionStarted,
        distanceToStartM,
        arrivalAtStartThresholdM: ARRIVAL_AT_START_THRESHOLD_M,
        navigationState: stateMachine.getState(),
        speedMps: sample.speedMps,
        movementSpeedThresholdMps: MOVEMENT_SPEED_THRESHOLD_MPS,
      });
      setPhase(currentPhase);

      if (currentPhase === "TO_START") {
        const bearingToStartDeg = bearingDegrees(rdPosition, model.geometry[0]);
        setStartInfo({ nodeId: nodeDisplayNumbers[0], distanceM: distanceToStartM, bearingDeg: bearingToStartDeg });

        // Positiemarker + kaart ook al tijdens fase A bijwerken -- de ruwe GPS-positie zelf
        // (geen matching, die begint pas bij sessiestart), zodat het aanrijden ook echt als
        // navigeren aanvoelt i.p.v. een statische afstandsteller op een overzichtskaart.
        const map = mapRef.current;
        if (map) {
          const src = map.getSource("goknoop-position") as maplibregl.GeoJSONSource | undefined;
          src?.setData({
            type: "FeatureCollection",
            features: [{ type: "Feature", geometry: { type: "Point", coordinates: [sample.lon, sample.lat] }, properties: {} }],
          });
        }

        appendLog(`onderweg naar startpunt, nog ${Math.round(distanceToStartM)}m`);
        return; // nog geen matching/navigatie -- sessie is bewust nog niet gestart
      }

      if (!sessionStarted) {
        try {
          stateMachine.start();
          sessionStarted = true;
          appendLog("startpunt bereikt, sessie gestart");
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
        const info = calculateNextNodeInfo(model, progress, outcome.matchedPosition, nodeDisplayNumbers);

        // Heading-up navigatie (sectie 6C/6G): UITSLUITEND tijdens NAVIGATING draait de kaart
        // mee met de rijrichting en zoomt dichterbij -- fase A/B blijven noordgericht.
        // Hergebruikt de al bestaande, apart geteste pure functies (stap 1 van 6C), hier voor
        // het eerst daadwerkelijk aan de kaart gekoppeld.
        if (currentPhase === "NAVIGATING") {
          const selectedHeading = selectHeadingDeg(
            { gpsHeadingDeg: sample.headingDeg, speedMps: sample.speedMps, previousStableHeadingDeg: smoothedHeadingRef.current },
            { speedThresholdMps: MOVEMENT_SPEED_THRESHOLD_MPS }
          );
          if (selectedHeading !== null) {
            smoothedHeadingRef.current = smoothHeadingDeg(smoothedHeadingRef.current, selectedHeading, HEADING_SMOOTHING_ALPHA);
          }
          const map = mapRef.current;
          if (map && smoothedHeadingRef.current !== null) {
            map.easeTo({
              center: [sample.lon, sample.lat],
              bearing: smoothedHeadingRef.current,
              zoom: NAVIGATION_ZOOM,
              duration: 500,
            });
          }
          // Richtingpijl RELATIEF t.o.v. de rijrichting (0° = rechtdoor/boven) -- de kaart zelf
          // is nu al heading-up gedraaid, dus een absolute bearing zou dubbel roteren.
          const arrowDeg =
            smoothedHeadingRef.current !== null ? relativeAngleDeg(info.bearingToNextNodeDeg, smoothedHeadingRef.current) : 0;
          setNextNode({ nodeId: info.nextNodeId, distanceM: info.distanceToNextNodeM, bearingDeg: arrowDeg });
        } else {
          // Fase B (Start Guidance): kaart blijft noordgericht, absolute bearing blijft correct.
          // Val terug naar noordgericht als de kaart nog gedraaid stond (bijv. gestopt met bewegen
          // ná eerder daadwerkelijk genavigeerd te hebben) -- geen "vastzittende" rotatie.
          if (smoothedHeadingRef.current !== null) {
            mapRef.current?.easeTo({ bearing: 0, duration: 500 });
            smoothedHeadingRef.current = null;
          }
          setNextNode({ nodeId: info.nextNodeId, distanceM: info.distanceToNextNodeM, bearingDeg: info.bearingToNextNodeDeg });
        }

        setProgressInfo({ ratio: progress.progressRatio, distanceAlongM: progress.distanceAlongRouteM, totalM: model.totalDistanceM });

        // Fase 2 (gereden-routes-tracking, 29-8-2026): checkArrival() bestond al in de
        // controller maar werd nooit aangeroepen -- ARRIVED werd zo nooit bereikt. Nu
        // gekoppeld: bij bevestigde aankomst wordt de rit precies ÉÉN keer vastgelegd
        // (hasRecordedArrivalRef voorkomt dubbele registratie bij volgende samples).
        const justArrived = controller.checkArrival(progress.remainingDistanceM, ARRIVAL_AT_END_THRESHOLD_M);
        if (justArrived) {
          setNavState(stateMachine.getState());
          if (!hasRecordedArrivalRef.current) {
            hasRecordedArrivalRef.current = true;
            recordRiddenRoute({
              edgeIds: edges.map((e) => e.id),
              nodeIds: nodeSequence,
              startNodeId: nodeSequence[0],
              distanceM: model.totalDistanceM,
            });
            appendLog("aangekomen -- rit onthouden voor toekomstige routevoorstellen");
          }
        }

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
    hasRecordedArrivalRef.current = false;
    smoothedHeadingRef.current = null;
    mapRef.current?.easeTo({ bearing: 0, duration: 500 });
    setRunning(false);
    setPhase("TO_START");
    setStartInfo(null);
    setNextNode(null);
    setProgressInfo(null);
    appendLog("Sessie gestopt.");
  }

  useEffect(() => {
    return () => {
      sourceRef.current?.stop();
      unsubscribeRef.current?.();
    };
  }, []);

  return (
    <div style={{ position: "fixed", inset: 0, width: "100%", height: "100dvh", zIndex: 50, background: "#000" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      {/* Top bar: exit-knop links, Start/Stop rechts -- vaste hoogte, geen overlap met wat eronder komt. */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px",
          zIndex: 12,
        }}
      >
        {onExit ? (
          <button
            onClick={() => {
              stop();
              onExit();
            }}
            aria-label="Navigatie verlaten"
            style={{
              width: 36,
              height: 36,
              borderRadius: 18,
              border: "none",
              background: "rgba(0,0,0,0.55)",
              color: "white",
              fontSize: 18,
              lineHeight: "36px",
              textAlign: "center",
              padding: 0,
            }}
          >
            ✕
          </button>
        ) : (
          <span />
        )}

        <button
          onClick={running ? stop : start}
          disabled={mapStatus !== "loaded"}
          style={{
            padding: "9px 18px",
            borderRadius: 20,
            border: "none",
            background: running ? "#b00020" : "#085041",
            color: "white",
            fontSize: 13,
            fontWeight: 600,
            boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
          }}
        >
          {running ? "Stop" : "Start"}
        </button>
      </div>

      {/* Inhoudskolom onder de top bar: richtingkaart, en (alleen in debugmodus) het statuspaneel --
          gestapeld in normale flow, nooit overlappend, ongeacht schermbreedte of tekstlengte. */}
      <div
        style={{
          position: "absolute",
          top: 64,
          left: 12,
          right: 12,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          zIndex: 10,
        }}
      >
        {(phase === "TO_START" ? startInfo : nextNode) && (
          <div
            style={{
              background: "#085041",
              borderRadius: 20,
              padding: "18px 20px",
              width: "100%",
              maxWidth: 340,
              boxShadow: "0 4px 20px rgba(0,0,0,0.28)",
              transition: "opacity 0.25s ease",
              boxSizing: "border-box",
            }}
          >
            {phase === "TO_START" && startInfo && (
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    background: "rgba(255,255,255,0.14)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    fontSize: 22,
                  }}
                >
                  🚲
                </div>
                <div style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#9FE1CB" }}>Rijd naar het startpunt</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: "#FFFFFF", letterSpacing: -0.5 }}>
                    {Math.round(startInfo.distanceM)} m
                  </div>
                  <div style={{ fontSize: 13, color: "#9FE1CB" }}>Knooppunt {startInfo.nodeId}</div>
                </div>
                <div
                  style={{
                    flexShrink: 0,
                    transform: `rotate(${startInfo.bearingDeg}deg)`,
                    transition: "transform 0.3s ease",
                  }}
                >
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 2L12 22M12 2L5 9M12 2L19 9" stroke="#FFFFFF" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            )}

            {phase === "START_GUIDANCE" && (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 12, color: "#9FE1CB", marginBottom: 4 }}>Je staat bij het startpunt</div>
                <div style={{ fontSize: 30, lineHeight: 1, marginBottom: 6 }}>🧭</div>
                <div style={{ fontSize: 19, fontWeight: 800, color: "#FFFFFF" }}>Rijd deze richting op</div>
                {nextNode && (
                  <div style={{ fontSize: 14, color: "#9FE1CB", marginTop: 4 }}>
                    Knooppunt {nextNode.nodeId} · {Math.round(nextNode.distanceM)} m
                  </div>
                )}
              </div>
            )}

            {phase === "NAVIGATING" && nextNode && (
              <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                <div
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    background: "#FFFFFF",
                    color: "#085041",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    fontSize: 17,
                    fontWeight: 800,
                  }}
                >
                  {nextNode.nodeId}
                </div>
                <div style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: "#9FE1CB" }}>Volgend knooppunt</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: "#FFFFFF", letterSpacing: -0.5 }}>
                    {Math.round(nextNode.distanceM)} m
                  </div>
                </div>
                <div
                  style={{
                    flexShrink: 0,
                    transform: `rotate(${nextNode.bearingDeg}deg)`,
                    transition: "transform 0.3s ease",
                  }}
                >
                  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M12 2L12 22M12 2L5 9M12 2L19 9" stroke="#FFFFFF" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Statuspaneel: alleen in debugmodus (geen onExit meegegeven), niet in de echte app --
            een monospace technisch paneel hoort niet in de productie-UX. */}
        {!onExit && (
          <div
            style={{
              background: "rgba(255,255,255,0.92)",
              borderRadius: 8,
              padding: "8px 12px",
              fontFamily: "monospace",
              fontSize: 12,
              width: "100%",
              maxWidth: 320,
              boxSizing: "border-box",
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
            <div><strong>fase:</strong> {phase}</div>
            <div><strong>nav state:</strong> {navState}</div>
            {error && <div style={{ color: "#b00020" }}>{error}</div>}
          </div>
        )}
      </div>

      {progressInfo && (
        <div
          style={{
            position: "absolute",
            bottom: 164,
            left: 12,
            right: 12,
            background: "rgba(255,255,255,0.95)",
            borderRadius: 16,
            padding: "14px 18px",
            zIndex: 10,
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <div>
              <div style={{ fontSize: 11, color: "#7A7A7A" }}>Tot. afstand</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{(progressInfo.totalM / 1000).toFixed(1)} km</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#7A7A7A" }}>Resterend</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>
                {((progressInfo.totalM - progressInfo.distanceAlongM) / 1000).toFixed(1)} km
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 11, color: "#7A7A7A" }}>Voltooid</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "#085041" }}>{Math.round(progressInfo.ratio * 100)}%</div>
            </div>
          </div>
          <div style={{ height: 6, background: "#E8E8E4", borderRadius: 4, overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.min(100, Math.max(0, progressInfo.ratio * 100))}%`,
                background: "#085041",
                transition: "width 0.4s ease",
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
