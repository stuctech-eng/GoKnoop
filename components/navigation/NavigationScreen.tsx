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
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { PhysicalAnchor } from "@/lib/navigation/physical-anchor";
import { resolvePhysicalStart } from "@/lib/navigation/physical-anchor";
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
// Backlog-item 8B (29-8-2026): stabiliteitsvenster tegen te vroeg "aangekomen"-melden --
// zelfde soort waarde als CONFIRM_MS (afwijkingsdetectie), nog niet definitief.
const ARRIVAL_CONFIRM_DURATION_MS = 3000;
// Heading-up navigatie (sectie 6C/6G, 29-8-2026): kaart draait mee met de rijrichting en
// zoomt dichterbij, UITSLUITEND tijdens fase NAVIGATING -- fase A/B blijven bewust
// noordgericht (sectie 5.3/10), heading-up is specifiek voor het actief navigeren.
const NAVIGATION_ZOOM = 17.5;
const HEADING_SMOOTHING_ALPHA = 0.35; // uitgangspunt, nog niet definitief (zelfde discipline als sectie 3.7)
// Verlengd van 500 naar 900ms (30-8-2026, "draaien gaat stukje voor stukje" -- zelfde
// aanpassing als de Kaart-hometab, LiveLocationScreen.tsx). Uitgangspunt, nog niet definitief.
const EASE_DURATION_MS = 900;

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
  /**
   * Aangeroepen als de gebruiker vanuit Start Guidance (fase B, bij het
   * startpunt) de rijrichting wil omkeren -- de aanroeper (app/page.tsx)
   * keert de route om (`reverseLoopCandidate`) en de nieuwe `edges`/
   * `nodeSequence`-props zorgen (via de `key`-gebaseerde remount in
   * app/page.tsx) voor een schone herstart van deze sessie. Alleen getoond
   * als deze prop is meegegeven (niet op de debugpagina).
   */
  onReverseDirection?: () => void;
  /**
   * FASE 5 (sectie 9.18): aangeroepen als de gebruiker "↩️ Back to Start" indrukt tijdens
   * NAVIGATING. De aanroeper (app/page.tsx) berekent beide benen (knooppunten-terugweg +
   * laatste-stukje-naar-parkeerplaats) en remount dit component met het eerste been als
   * nieuwe actieve route (zelfde `key`-gebaseerde mechanisme als `onReverseDirection`).
   * Alleen getoond als zowel deze prop als een vastgelegd `physicalStart` beschikbaar zijn.
   */
  /**
   * FASE 5 (sectie 9.18): "Back to Start" verhuisde volledig naar het pauzemenu
   * (`PauseScreen.tsx`, via `backToStartFromPause` in app/page.tsx) -- op verzoek: "alles in
   * het pauzemenu, is tevens controlekamer". Deze prop bestaat daarom niet meer; de
   * app/page.tsx-logica die de daadwerkelijke berekening doet (`startBackToStart`) bestaat
   * nog gewoon, alleen niet meer via een directe knop in dit component aangeroepen.
   */
  /**
   * Aanwezig wanneer DIT is de "terug naar het startknooppunt"-been van een Back to Start-rit
   * (sectie 9.18) -- bij ARRIVED wordt dan een aangepaste kaart getoond met het laatste,
   * al vooraf berekende stukje naar de parkeerplaats (link naar Kaarten i.p.v. nieuwe
   * in-app-navigatie, zelfde bewuste keuze als "auto naar parkeerplaats", sectie 9.6).
   */
  lastMileInfo?: {
    distanceM: number;
    destinationLat: number;
    destinationLon: number;
    destinationLabel?: string;
    /** "parking" (Back to Start, sectie 9.18) of "destination" (route naar een adres, sectie 9.21) -- bepaalt titel/icoon van de aankomstkaart. Standaard "parking". */
    kind?: "parking" | "destination";
  };
  /**
   * Pauzeknop (sectie 9.19, 30-8-2026): aangeroepen met alles wat nodig is voor een
   * snapshot -- de aanroeper (app/page.tsx) bewaart 'm en toont het aparte PauseScreen.
   * Dit component bevat zelf GEEN pauzelogica, puur een knop + doorgeven van de huidige
   * ritgegevens ("blijft het overzichtelijk, staat niet alles in het navigatiescherm").
   */
  onPause?: (snapshot: {
    lastKnownPosition: { lat: number; lon: number } | null;
    distanceTraveledM: number;
    rideTimeS: number;
    physicalStart: PhysicalAnchor | null;
    /** BUGFIX (sectie 9.41): of de matching al echt gestart was (fase C bereikt) op het
     *  moment van pauzeren -- bepaalt of "hervatten" fase A/B mag overslaan. */
    hasSessionStarted: boolean;
  }) => void;
  /**
   * "Rit hervatten" (sectie 9.31, 30-8-2026): als deze drie samen meegegeven worden, slaat
   * de sessie fase A/B volledig over en start de matching DIRECT vanaf de eerste sample --
   * geen "rijd terug naar het beginknooppunt" meer nodig. Werkt omdat de bestaande matching
   * toch al overal langs de route werkt, niet alleen vanaf het begin.
   */
  startInProgress?: boolean;
  /** Het OORSPRONKELIJKE fysieke vertrekpunt (parkeerplaats) -- moet behouden blijven na
   *  hervatten, NIET opnieuw op de huidige (hervat-)positie gezet worden. */
  initialPhysicalStart?: PhysicalAnchor;
  /** Al verstreken fietstijd vóór de pauze -- zodat een volgende pauze de CUMULATIEVE tijd toont. */
  initialElapsedRideTimeS?: number;
};

export default function NavigationScreen({
  edges,
  nodeSequence,
  nodeDisplayNumbers,
  datasetVersionId,
  onExit,
  onReverseDirection,
  lastMileInfo,
  onPause,
  startInProgress,
  initialPhysicalStart,
  initialElapsedRideTimeS,
}: NavigationScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sourceRef = useRef<BrowserGeolocationSource | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const hasRecordedArrivalRef = useRef(false);
  const smoothedHeadingRef = useRef<number | null>(null);
  const hasRequestedRouteToStartRef = useRef(false);
  const routeToStartDistanceRef = useRef<number | null>(null);
  /**
   * Fase 4 (sectie 9.12, punt 5/6): het fysieke vertrekpunt, EENMALIG vastgelegd bij de
   * eerste sample in fase TO_START, en daarna NOOIT overschreven tijdens de sessie
   * (cruciale regel, sectie 9.7 -- essentieel voor een latere Back to Start, Fase 5, hier
   * nog niet gebouwd). Blijft volledig onafhankelijk van `nodeSequence[0]`
   * (routeStartNodeId) -- twee aparte concepten, nooit door elkaar gehaald.
   */
  const physicalStartRef = useRef<PhysicalAnchor | null>(initialPhysicalStart ?? null);
  /** Fase A (sectie 9.15): markeert of de eenmalige fitBounds op de LocalBikeRouter-route
   *  al gebeurd is -- voorkomt dat een toekomstige wijziging aan fetchRouteToStart per
   *  ongeluk de camera herhaaldelijk laat springen. */
  const hasFitBoundsToStartRef = useRef(false);
  /** Meest recente live positie -- gebruikt door de Back to Start-knop (sectie 9.18). */
  const lastSampleRef = useRef<{ lat: number; lon: number } | null>(null);
  /**
   * BUGFIX (30-8-2026, "hervat rit werkt alleen als de navigatie begonnen is"): houdt bij of
   * de matching daadwerkelijk gestart is (fase C bereikt) op het moment van pauzeren. Nodig
   * omdat pauzeren al vanaf fase A mogelijk is (sectie 9.25) -- maar "hervatten" mag alleen
   * fase A/B overslaan (`startInProgress`, sectie 9.31) als er ECHT al gematcht werd; anders
   * moet een hervatte rit gewoon opnieuw fase A doorlopen (je was nog onderweg naar de route,
   * niet erop).
   */
  const hasSessionStartedRef = useRef(false);
  /** Startknooppunt-coördinaten (WGS84) -- voor de "Open in Kaarten"-link tijdens fase A
   *  (sectie 9.29). `model` zelf zit in een andere scope (de effect-closure), niet
   *  bereikbaar vanuit de render -- daarom hier apart bewaard. */
  const startNodeWgs84Ref = useRef<{ lat: number; lon: number } | null>(null);
  /** Wanneer de sessie daadwerkelijk startte (device-tijd) -- voor rijtijd bij pauzeren (sectie 9.19). */
  const sessionStartedAtMsRef = useRef<number | null>(null);

  const [mapStatus, setMapStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [running, setRunning] = useState(false);
  const [nextNode, setNextNode] = useState<{ nodeId: string; distanceM: number; bearingDeg: number } | null>(null);
  const [progressInfo, setProgressInfo] = useState<{ ratio: number; distanceAlongM: number; totalM: number } | null>(null);
  const [phase, setPhase] = useState<PreNavigationPhase>("TO_START");
  /**
   * "Dubbeltikken vergroot het blok" (sectie 9.38, 30-8-2026) -- BIJGESTELD van de eerdere
   * "2 seconden ingedrukt houden"-aanpak (sectie 9.36): die bleek in de praktijk niet
   * betrouwbaar te werken (perfect stilhouden gedurende 2 volle seconden is lastig, zeker
   * onderweg op de fiets). Dubbeltikken is eenvoudiger te detecteren (twee korte tikken kort
   * na elkaar) en minder gevoelig voor een kleine trilling van de hand. Onafhankelijke toggle
   * per blok (richtingkaart / voortgangsbalk); nogmaals dubbeltikken zet 'm terug naar normaal.
   */
  const [directionCardEnlarged, setDirectionCardEnlarged] = useState(false);
  const [progressPanelEnlarged, setProgressPanelEnlarged] = useState(false);
  const lastTapAtRef = useRef<number>(0);

  function doubleTapHandlers(toggle: () => void) {
    return {
      onClick: () => {
        const now = Date.now();
        if (now - lastTapAtRef.current < 400) {
          toggle();
          lastTapAtRef.current = 0; // voorkomt dat een snelle DERDE tik meteen weer toggelt
        } else {
          lastTapAtRef.current = now;
        }
      },
    };
  }
  const [startInfo, setStartInfo] = useState<{ nodeId: string; distanceM: number; bearingDeg: number } | null>(null);
  // Sectie 6N/9.17-BUGFIX: de EENMALIG opgehaalde totale lengte van de LocalBikeRouter-route
  // naar het startpunt. Bewust NIET meer gebruikt voor de live afstandsweergave/aankomstcheck
  // (dat gaf een echte bug: dit getal update nooit terwijl je dichterbij komt, dus het bleef
  // een oud, te hoog getal tonen terwijl de aankomstdrempel al op de LEVENDE hemelsbrede
  // afstand reageerde -- twee inconsistente maten door elkaar). Nu puur informatief (bijv. voor
  // logging), de live `distanceToStartM` is de enige bron voor wat de gebruiker ziet.
  const [routeToStartDistanceM, setRouteToStartDistanceM] = useState<number | null>(null);
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
      startNodeWgs84Ref.current = rdToWgs84(model.geometry[0].x, model.geometry[0].y);
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
      // Compacte attributie i.p.v. een permanente balk -- de attributie zelf blijft staan
      // (waarschijnlijk vereist door OpenStreetMap/OpenFreeMap se licentie, geen decoratie),
      // maar wordt nu een klein, onopvallend "i"-icoontje i.p.v. een balk die ruimte inneemt.
      attributionControl: { compact: true },
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");

    // Attributie onderaan GECENTREERD i.p.v. rechtsonder in de hoek (op verzoek, 30-8-2026).
    // MapLibre kent geen ingebouwde "bottom-center"-positie voor besturingselementen (alleen
    // de vier hoeken) -- dit herpositioneert het element zelf via CSS, met behoud van
    // exact dezelfde, vereiste attributie-inhoud (alleen WAAR die getoond wordt verandert).
    map.once("load", () => {
      const attribContainer = map.getContainer().querySelector<HTMLElement>(".maplibregl-ctrl-bottom-right");
      if (attribContainer) {
        attribContainer.style.left = "50%";
        attribContainer.style.right = "auto";
        attribContainer.style.transform = "translateX(-50%)";
      }
    });

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
    const controller = new NavigationSessionController(detector, stateMachine, clock, ARRIVAL_CONFIRM_DURATION_MS);

    let sessionStarted = false;

    /**
     * FASE 4 (sectie 9.11/9.12, 30-8-2026) -- HERSCHREVEN: routeerde eerder via
     * `computeRouteWithFallback()` (het knooppuntennetwerk zelf, Layer A, een noodgreep).
     * Nu via `LocalBikeRouter` (Layer B, straten) -- de server-kant heeft geen
     * knooppunt-kandidaten meer nodig voor de HERKOMST (een fysiek vertrekpunt is geen
     * knooppunt-kandidaat), alleen de coördinaten van origin/destination.
     *
     * `physicalStart` wordt hier EENMALIG vastgelegd (sectie 9.7, cruciale regel: nooit
     * overschrijven tijdens de sessie) -- de eerste stap waarbij het Fase 2-datamodel
     * daadwerkelijk gebruikt wordt.
     *
     * Eenmalig aangeroepen (hasRequestedRouteToStartRef), geen doorlopende herberekening
     * bij elke sample -- bewust een scoped-eerste-versie, geen live re-routing als de
     * gebruiker een andere weg neemt.
     */
    async function fetchRouteToStart(lat: number, lon: number) {
      physicalStartRef.current = resolvePhysicalStart(physicalStartRef.current, { lat, lon });

      try {
        const destinationWgs84 = rdToWgs84(model.geometry[0].x, model.geometry[0].y);

        const toStartRes = await fetch("/api/route/to-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origin: { lat: physicalStartRef.current.lat, lon: physicalStartRef.current.lon },
            destination: destinationWgs84,
          }),
        });
        const toStartData = await toStartRes.json();
        if (!toStartRes.ok) {
          appendLog(`route naar startpunt niet gevonden: ${toStartData.error ?? "onbekende fout"}`);
          return;
        }

        // Simpele polylijn, GEEN buildRouteProgressModel/buildRouteGeoJson -- die zijn
        // specifiek voor het edge-gebaseerde knooppuntenmodel (lib/route-engine/), en dit is
        // gewoon een rechte, ongestructureerde straten-polylijn (Layer B levert geen
        // edges/nodes, alleen een puntenreeks + totaalafstand).
        const lineGeoJson: GeoJSON.Feature = {
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates: toStartData.geometry.map((p: { lat: number; lon: number }) => [p.lon, p.lat]),
          },
          properties: {},
        };

        const map = mapRef.current;
        if (map) {
          if (!map.getSource("goknoop-route-to-start")) {
            map.addSource("goknoop-route-to-start", { type: "geojson", data: lineGeoJson });
            // Onder de hoofdroute-laag getekend (dun, gestippeld, ander blauw) -- duidelijk
            // onderscheiden van de daadwerkelijke gekozen fietsroute (dikke, effen teal lijn).
            map.addLayer(
              {
                id: "goknoop-route-to-start-line",
                type: "line",
                source: "goknoop-route-to-start",
                layout: { "line-join": "round", "line-cap": "round" },
                paint: { "line-color": "#3B82F6", "line-width": 4, "line-dasharray": [2, 2] },
              },
              "goknoop-route-line"
            );
          } else {
            (map.getSource("goknoop-route-to-start") as maplibregl.GeoJSONSource).setData(lineGeoJson);
          }

          // Fase A (sectie 9.15): EENMALIG inzoomen op uitsluitend deze parkeerplaats→
          // startknooppunt-verbinding, niet de volledige (mogelijk 20-30km) gekozen route die
          // bij sessiestart al gefit was. Daarna laat GoKnoop de camera met rust -- GEEN
          // doorlopend camera-volgen hier (dat is bewust exclusief voor fase C, sectie 6H,
          // twee verantwoordelijkheden die niet door elkaar mogen lopen).
          if (!hasFitBoundsToStartRef.current) {
            const lons = toStartData.geometry.map((p: { lon: number }) => p.lon);
            const lats = toStartData.geometry.map((p: { lat: number }) => p.lat);
            map.fitBounds(
              [
                [Math.min(...lons), Math.min(...lats)],
                [Math.max(...lons), Math.max(...lats)],
              ],
              // Asymmetrische marge, zelfde les als sectie 6H: de richtingkaart bovenin is
              // veel hoger dan een uniforme marge -- zonder dat duwt de kaart een stuk van
              // de net getekende route uit beeld, achter de kaart.
              { padding: { top: 200, bottom: 80, left: 60, right: 60 }, animate: true }
            );
            hasFitBoundsToStartRef.current = true;
          }
        }

        routeToStartDistanceRef.current = toStartData.distanceM;
        setRouteToStartDistanceM(toStartData.distanceM);
        appendLog(`route naar startpunt getekend (${Math.round(toStartData.distanceM)}m, via LocalBikeRouter)`);
      } catch (err) {
        appendLog(`route-naar-startpunt-fout: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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
      lastSampleRef.current = { lat: sample.lat, lon: sample.lon };
      // Fase A/B/C bepalen (stap 12.7) -- vóór sessiestart: alleen de afstand tot het
      // startknooppunt is relevant, geen matching (er is nog geen actieve navigatie).
      const rdPosition = wgs84ToRd(sample.lat, sample.lon);
      const distanceToStartM = distanceBetween(rdPosition, model.geometry[0]);
      const currentPhase = startInProgress ? "NAVIGATING" : determinePreNavigationPhase({
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

        if (!hasRequestedRouteToStartRef.current) {
          hasRequestedRouteToStartRef.current = true;
          fetchRouteToStart(sample.lat, sample.lon);
        }

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

          // BIJGESTELD (30-8-2026, op verzoek): fase A draait en volgt nu ook mee, exact
          // hetzelfde patroon als de Kaart-hometab (LiveLocationScreen.tsx) en fase C
          // hieronder -- eerder stond hier expliciet "fase A/B blijven noordgericht" als
          // bewuste keuze, nu herzien. Bewust GEEN zoom-wijziging (zoom blijft zoals de
          // eenmalige fitBounds op de LocalBikeRouter-route 'm zette, sectie 9.15) -- alleen
          // meedraaien/meebewegen, niet automatisch inzoomen.
          const selectedHeading = selectHeadingDeg(
            { gpsHeadingDeg: sample.headingDeg, speedMps: sample.speedMps, previousStableHeadingDeg: smoothedHeadingRef.current },
            { speedThresholdMps: MOVEMENT_SPEED_THRESHOLD_MPS }
          );
          if (selectedHeading !== null) {
            smoothedHeadingRef.current = smoothHeadingDeg(smoothedHeadingRef.current, selectedHeading, HEADING_SMOOTHING_ALPHA);
          }
          if (smoothedHeadingRef.current !== null) {
            map.easeTo({ center: [sample.lon, sample.lat], bearing: smoothedHeadingRef.current, duration: EASE_DURATION_MS });
          } else {
            map.easeTo({ center: [sample.lon, sample.lat], duration: EASE_DURATION_MS });
          }
        }

        appendLog(`onderweg naar startpunt, nog ${Math.round(distanceToStartM)}m`);
        return; // nog geen matching/navigatie -- sessie is bewust nog niet gestart
      }

      if (!sessionStarted) {
        try {
          stateMachine.start();
          sessionStarted = true;
          hasSessionStartedRef.current = true;
          // Bij hervatten: terugrekenen zodat sessionStartedAtMsRef de VOLLEDIGE (cumulatieve)
          // rijtijd weergeeft bij een volgende pauze, niet alleen de tijd sinds hervatten.
          sessionStartedAtMsRef.current = Date.now() - (initialElapsedRideTimeS ?? 0) * 1000;
          appendLog(startInProgress ? "rit hervat -- matching direct gestart, geen fase A/B nodig" : "startpunt bereikt, sessie gestart");
        } catch {
          return;
        }
      }

      const outcome = controller.processGpsSample(sample);
      setNavState(stateMachine.getState());

      // BUGFIX (30-8-2026, "blijft locatie staan bij verlaten route"): OFF_ROUTE accepteert
      // uitsluitend startReroute() als geldige overgang (state machine, stap 2/7) -- zonder
      // die aanroep werd ELKE volgende sample afgewezen ("abstained: state_not_accepting_
      // signal"), waardoor de marker voor altijd bevroor, ook als je weer terug naar de route
      // reed. Dit is BEWUST NOG GEEN volledige reroute-feature (die zou een echte nieuwe
      // Route Engine-aanroep + RerouteContextTracker/RECENT_ROUTE_MEMORY-dedup vereisen --
      // apart, groter werk, sectie 7/8-machinerie bestaat al maar is nog niet aangesloten).
      // Dit is een minimale, eerlijke stopgap: cyclet direct door REROUTING->REROUTED heen
      // ZONDER een nieuwe route te berekenen (dezelfde `model`/geometrie blijft gelden), puur
      // om matching te laten hervatten. De bestaande `rerouteCooldownMs`-bescherming in de
      // state machine zelf voorkomt dat dit meteen weer naar OFF_ROUTE terugflipt.
      if (outcome.action === "abstained" && outcome.reason === "state_not_accepting_signal" && stateMachine.getState() === "OFF_ROUTE") {
        stateMachine.startReroute();
        stateMachine.completeReroute(clock.now());
        setNavState(stateMachine.getState());
        appendLog("matching hervat (geen nieuwe route berekend -- zelfde route, stopgap-fix)");
      }

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
              duration: EASE_DURATION_MS,
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
              datasetVersionId,
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
    hasRequestedRouteToStartRef.current = false;
    sessionStartedAtMsRef.current = null;
    routeToStartDistanceRef.current = null;
    physicalStartRef.current = null; // alleen bij een volledige sessie-stop, nooit tussentijds
    hasFitBoundsToStartRef.current = false;
    setDirectionCardEnlarged(false);
    hasSessionStartedRef.current = false;
    setProgressPanelEnlarged(false);
    setRouteToStartDistanceM(null);
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
      {/* MapLibre's eigen zoomcontrol (top-right) weet niets van onze eigen topbalk (X/Start-Stop,
          ook top-right) en overlapte die. Duw 'm expliciet naar beneden, onder de topbalk. */}
      <style>{`.maplibregl-ctrl-top-right { top: 68px !important; }`}</style>

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
              width: 44,
              height: 44,
              borderRadius: 22,
              border: "none",
              background: "rgba(0,0,0,0.55)",
              color: "white",
              fontSize: 19,
              lineHeight: "44px",
              textAlign: "center",
              padding: 0,
            }}
          >
            ✕
          </button>
        ) : (
          <span />
        )}

        {running && onPause ? (
          // GPT-ontwerp-idee, 30-8-2026: één duidelijke, herkenbare knop (icoon + tekst) i.p.v.
          // een losse "Stop" ernaast. Nu Pauze een eigen menu heeft met "Rit beëindigen" (mét
          // bevestiging), is een aparte, direct-stoppende "Stop"-knop overbodig geworden -- dat
          // deed hetzelfde, maar zonder bevestiging en zonder de mogelijkheid om later te
          // hervatten. Simpeler: ✕ (dit scherm verlaten) + ⏸ Pauze (alles-in-één-plek).
          <button
            onClick={() => {
              const rideTimeS = sessionStartedAtMsRef.current ? (Date.now() - sessionStartedAtMsRef.current) / 1000 : 0;
              onPause({
                lastKnownPosition: lastSampleRef.current,
                distanceTraveledM: progressInfo?.distanceAlongM ?? 0,
                rideTimeS,
                physicalStart: physicalStartRef.current,
                hasSessionStarted: hasSessionStartedRef.current,
              });
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              minHeight: 44,
              padding: "10px 18px",
              borderRadius: 22,
              border: "none",
              background: "#085041",
              color: "white",
              fontSize: 14,
              fontWeight: 700,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            <span style={{ fontSize: 16 }}>⏸</span> Pauze
          </button>
        ) : (
          <button
            onClick={running ? stop : start}
            disabled={mapStatus !== "loaded"}
            style={{
              minHeight: 44,
              padding: "10px 20px",
              borderRadius: 22,
              border: "none",
              background: running ? "#b00020" : "#085041",
              color: "white",
              fontSize: 14,
              fontWeight: 700,
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            {running ? "Stop" : "Start"}
          </button>
        )}
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
        {navState === "ARRIVED" ? (
          lastMileInfo ? (
            <div
              style={{
                background: "#085041",
                borderRadius: 20,
                padding: "22px 20px",
                width: "100%",
                maxWidth: 340,
                textAlign: "center",
                boxShadow: "0 4px 20px rgba(0,0,0,0.28)",
                boxSizing: "border-box",
              }}
            >
              <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 8 }}>{lastMileInfo.kind === "destination" ? "🎯" : "🅿️"}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#FFFFFF" }}>
                {lastMileInfo.kind === "destination" ? "Bijna bij je bestemming" : "Bijna bij je auto"}
              </div>
              <div style={{ fontSize: 15, color: "#FFFFFF", marginTop: 4 }}>
                Nog {Math.round(lastMileInfo.distanceM)} m naar {lastMileInfo.destinationLabel ?? "je parkeerplaats"}
              </div>
              <a
                href={`https://maps.apple.com/?daddr=${lastMileInfo.destinationLat},${lastMileInfo.destinationLon}&dirflg=b`}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-block",
                  marginTop: 14,
                  background: "rgba(255,255,255,0.14)",
                  color: "#FFFFFF",
                  borderRadius: 10,
                  padding: "10px 18px",
                  fontSize: 14,
                  fontWeight: 700,
                  textDecoration: "none",
                }}
              >
                Open in Kaarten
              </a>
            </div>
          ) : (
          <div
            style={{
              background: "#085041",
              borderRadius: 20,
              padding: "22px 20px",
              width: "100%",
              maxWidth: 340,
              textAlign: "center",
              boxShadow: "0 4px 20px rgba(0,0,0,0.28)",
              boxSizing: "border-box",
            }}
          >
            <div style={{ fontSize: 34, lineHeight: 1, marginBottom: 8 }}>🏁</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#FFFFFF" }}>Aangekomen!</div>
            <div style={{ fontSize: 13, color: "#9FE1CB", marginTop: 4 }}>Deze rit is onthouden voor toekomstige routevoorstellen.</div>
          </div>
          )
        ) : (
          (phase === "TO_START" ? startInfo : nextNode) && (
          <div
            {...doubleTapHandlers(() => setDirectionCardEnlarged((v) => !v))}
            style={{
              position: "relative",
              background: "#085041",
              borderRadius: 20,
              padding: "18px 20px",
              width: "100%",
              maxWidth: 340,
              boxShadow: "0 4px 20px rgba(0,0,0,0.28)",
              transition: "opacity 0.25s ease, transform 0.25s ease",
              transform: directionCardEnlarged ? "scale(1.35)" : "scale(1)",
              transformOrigin: "top center",
              boxSizing: "border-box",
              touchAction: "manipulation",
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

            {phase === "TO_START" && startInfo && startNodeWgs84Ref.current && (
              <div style={{ display: "flex", justifyContent: "center", gap: 16, marginTop: 12 }}>
                <a
                  href={`https://maps.apple.com/?daddr=${startNodeWgs84Ref.current.lat},${startNodeWgs84Ref.current.lon}&dirflg=b`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: "#9FE1CB", textDecoration: "underline" }}
                >
                  🚲 Fiets ernaartoe
                </a>
                {/* "Auto naar startpunt" (30-8-2026, op verzoek): zoekt parkeren IN DE BUURT van
                    het startknooppunt, i.p.v. met de fiets-routebeschrijving naar het EXACTE punt
                    te navigeren (dat klopte sowieso niet voor autogebruik). Apple's officiële
                    q=+near=-parameters (gedocumenteerd, geverifieerd) laten Apple Kaarten zelf de
                    beschikbare parkeerplekken tonen -- GoKnoop hoeft daar geen eigen zoekdienst
                    voor te bouwen/onderhouden (zie sectie 9.42-9.48's ervaring met Overpass). */}
                <a
                  href={`https://maps.apple.com/?q=Parkeren&near=${startNodeWgs84Ref.current.lat},${startNodeWgs84Ref.current.lon}&dirflg=d`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ fontSize: 13, color: "#9FE1CB", textDecoration: "underline" }}
                >
                  🚗 Zoek parkeren in de buurt
                </a>
              </div>
            )}

            {phase === "START_GUIDANCE" && (
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 12, color: "#9FE1CB", marginBottom: 4 }}>Je staat bij het startpunt</div>
                {nextNode && (
                  <div
                    style={{
                      display: "inline-block",
                      marginBottom: 6,
                      transform: `rotate(${nextNode.bearingDeg}deg)`,
                      transition: "transform 0.3s ease",
                    }}
                  >
                    <svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 2L12 22M12 2L5 9M12 2L19 9" stroke="#FFFFFF" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                )}
                <div style={{ fontSize: 19, fontWeight: 800, color: "#FFFFFF" }}>Rijd deze richting op</div>
                {nextNode && (
                  <div style={{ fontSize: 14, color: "#9FE1CB", marginTop: 4 }}>
                    Knooppunt {nextNode.nodeId} · {Math.round(nextNode.distanceM)} m
                  </div>
                )}
                {onReverseDirection && (
                  <button
                    onClick={onReverseDirection}
                    style={{
                      marginTop: 12,
                      background: "rgba(255,255,255,0.14)",
                      color: "#FFFFFF",
                      border: "none",
                      borderRadius: 10,
                      padding: "8px 14px",
                      fontSize: 13,
                      fontWeight: 600,
                    }}
                  >
                    ↻ Andere kant op rijden
                  </button>
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
          )
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


      {progressInfo && phase === "NAVIGATING" && (
        <div
          {...doubleTapHandlers(() => setProgressPanelEnlarged((v) => !v))}
          style={{
            position: "absolute",
            bottom: 20,
            left: 12,
            right: 12,
            background: "rgba(255,255,255,0.95)",
            borderRadius: 16,
            padding: "14px 18px",
            zIndex: 10,
            boxShadow: "0 2px 10px rgba(0,0,0,0.12)",
            transition: "transform 0.25s ease",
            transform: progressPanelEnlarged ? "scale(1.35)" : "scale(1)",
            transformOrigin: "bottom center",
            touchAction: "manipulation",
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

      {!onExit && (
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
      )}
    </div>
  );
}
