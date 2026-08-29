"use client";

/**
 * Navigatie-debugharness (ontwerp sectie 23, implementatiestap 11).
 *
 * GEEN nieuwe navigatielogica -- dit bestand wikkelt uitsluitend
 * BrowserGeolocationSource (echte iPhone-GPS) om exact dezelfde keten die
 * de simulator al doorloopt (GpsFixEvaluator → candidate matcher →
 * progress → DeviationDetector → NavigationSessionController). Doel: meten
 * hoe die keten zich gedraagt tegen echte, rommelige GPS-data, VÓÓR er
 * kalibratiewaarden worden vastgezet.
 *
 * Volgt de iPhone-first debugstrategie (Master System sectie 15): alle
 * diagnose gebeurt in-app, zichtbaar op het scherm zelf -- geen Web
 * Inspector, geen desktop devtools nodig. Open deze pagina in Safari op de
 * iPhone, druk op Start, ga fietsen, lees het paneel.
 *
 * Bewust GEEN netwerkverkeer: er wordt nergens naar een server gestuurd.
 * "Reroute" wordt hier alleen MECHANISCH getoond (welke temporaryAvoidEdgeIds
 * de RerouteContextTracker zou meegeven) -- een echte POST /api/route-aanroep
 * vereist resolveNearestNodes()/een live GraphProvider en is bewust NIET
 * hier aangesloten (dat zou deze harness onnodig zwaar en netwerkafhankelijk
 * maken voor wat een meetinstrument moet zijn, geen productiefeature).
 *
 * Startwaarden voor de kalibratie-invoervelden komen uit de integratietests
 * (stap 10) -- expliciet als UITGANGSPUNT, niet als vastgezette waarde. Pas
 * ze aan tijdens het testen en kijk wat een bruikbaar, stabiel gedrag geeft.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { BrowserGeolocationSource } from "@/lib/navigation/gps-sources/browser-geolocation-source";
import { SystemNavigationClock } from "@/lib/navigation/clock/navigation-clock";
import { NavigationStateMachine } from "@/lib/navigation/session/navigation-state-machine";
import { DeviationDetector } from "@/lib/navigation/deviation/deviation-detector";
import { NavigationSessionController } from "@/lib/navigation/lifecycle/navigation-session-controller";
import { buildRouteProgressModel, calculateProgress } from "@/lib/navigation/progress/route-progress-model";
import { ProgressTracker } from "@/lib/navigation/progress/progress-tracker";
import { RerouteContextTracker } from "@/lib/navigation/reroute/reroute-context-tracker";
import { wgs84ToRd } from "@/lib/route-engine/coordinate-transform";
import type { GraphEdge, Point } from "@/lib/route-engine/types";
import type { GpsSample, NavigationState } from "@/lib/navigation/types";

type LogEntry = { t: string; text: string };

export default function NavigationDebugHarness() {
  // Testroute: twee handmatig ingevoerde WGS84-punten, omgezet naar één rechte RD-edge.
  // Vul dit in met een echt, dichtbij gelegen fietspad om zinvol te kunnen testen.
  const [fromLat, setFromLat] = useState("");
  const [fromLon, setFromLon] = useState("");
  const [toLat, setToLat] = useState("");
  const [toLon, setToLon] = useState("");

  // Kalibratie-invoervelden -- UITGANGSPUNTEN uit stap 10, niet vastgezet.
  const [deviationThresholdM, setDeviationThresholdM] = useState(20);
  const [deviationConfirmDurationMs, setDeviationConfirmDurationMs] = useState(5000);
  const [rerouteCooldownMs, setRerouteCooldownMs] = useState(10000);
  const [recentRouteMemoryM, setRecentRouteMemoryM] = useState(200);
  const [accuracyThresholdM, setAccuracyThresholdM] = useState(20);
  const [gpsTimeoutMs, setGpsTimeoutMs] = useState(10000);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<NavigationState>("NOT_STARTED");
  const [rawSample, setRawSample] = useState<GpsSample | null>(null);
  const [matched, setMatched] = useState<{ segmentIndex: number; perpendicularDistanceM: number; cumulativeDistanceM: number } | null>(null);
  const [progress, setProgress] = useState<{ distanceAlongRouteM: number; remainingDistanceM: number; progressRatio: number; currentEdgeId: string } | null>(null);
  const [gpsHealth, setGpsHealth] = useState<{ isSignalLost: boolean } | null>(null);
  const [temporaryAvoidEdgeIds, setTemporaryAvoidEdgeIds] = useState<string[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  const sourceRef = useRef<BrowserGeolocationSource | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const healthIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function appendLog(text: string) {
    setLog((prev) => [{ t: new Date().toISOString().slice(11, 23), text }, ...prev].slice(0, 50));
  }

  function buildTestEdges(): GraphEdge[] | null {
    const fLat = parseFloat(fromLat);
    const fLon = parseFloat(fromLon);
    const tLat = parseFloat(toLat);
    const tLon = parseFloat(toLon);
    if ([fLat, fLon, tLat, tLon].some((v) => Number.isNaN(v))) return null;
    const from: Point = wgs84ToRd(fLat, fLon);
    const to: Point = wgs84ToRd(tLat, tLon);
    const distanceM = Math.sqrt((to.x - from.x) ** 2 + (to.y - from.y) ** 2);
    if (distanceM === 0) return null;
    return [
      {
        id: "debug-edge-1",
        fromLogicalNodeId: "debug-from",
        toLogicalNodeId: "debug-to",
        distanceM,
        directionality: "bidirectional",
        geometry: [from, to],
      },
    ];
  }

  function start() {
    setError(null);
    const edges = buildTestEdges();
    if (!edges) {
      setError("Vul geldige from/to-coördinaten in (testroute) vóór het starten.");
      return;
    }

    const clock = new SystemNavigationClock();
    const stateMachine = new NavigationStateMachine({
      deviationConfirmDurationMs,
      rerouteCooldownMs,
    });
    const progressModel = buildRouteProgressModel(edges);
    const detector = new DeviationDetector(progressModel.geometry, stateMachine, clock, {
      deviationThresholdM,
      accuracyThresholdM,
      gpsTimeoutMs,
      matchOptions: {
        baseWindowM: 100,
        windowMarginPerMps: 10,
        weights: { distance: 1, heading: 0.1, continuity: 0.5 },
      },
    });
    const controller = new NavigationSessionController(detector, stateMachine);
    const progressTracker = new ProgressTracker(3);
    const rerouteTracker = new RerouteContextTracker();

    let source: BrowserGeolocationSource;
    try {
      source = new BrowserGeolocationSource({
        enableHighAccuracy: true,
        onError: (err) => {
          appendLog(`GPS-fout: [${err.code}] ${err.message}`);
          // Geolocation-standaard: code 1 = PERMISSION_DENIED. Dit is een APARTE state
          // (ontwerp sectie 14), NOOIT hetzelfde pad als GPS_LOST -- code 2 (POSITION_UNAVAILABLE)
          // en code 3 (TIMEOUT) zijn wél tijdelijke signaalproblemen en veranderen de state hier
          // NIET; die lopen via de bestaande GPS_LOST-timeoutlogica (checkGpsHealth), niet hier.
          if (err.code === 1) {
            try {
              controller.denyPermission();
              setState(stateMachine.getState());
              appendLog("state: -> PERMISSION_DENIED (toestemming geweigerd)");
            } catch {
              // al in PERMISSION_DENIED of een eindstadium -- geen actie nodig
            }
            setError("Locatietoestemming geweigerd.");
          } else {
            setError(`GPS-fout: ${err.message}`);
          }
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    let sessionStarted = false; // NavigationStateMachine.start() hoort bij de EERSTE fix, niet bij de knop (ontwerp sectie 14)

    const unsubscribe = source.subscribe((sample) => {
      if (!sessionStarted) {
        // Als denyPermission() ondertussen al is aangeroepen (state = PERMISSION_DENIED),
        // start() zou daar een InvalidNavigationTransitionError geven -- dat kan hier
        // legitiem gebeuren als een late, gebufferde sample nog binnenkomt na een weigering.
        try {
          stateMachine.start();
          sessionStarted = true;
          appendLog("state: NOT_STARTED -> ON_ROUTE (eerste GPS-fix ontvangen)");
        } catch {
          return; // sessie is inmiddels PERMISSION_DENIED/CANCELLED -- deze late sample negeren
        }
      }

      setRawSample(sample);
      const outcome = controller.processGpsSample(sample);
      setGpsHealth({ isSignalLost: detector.isGpsSignalLost() });

      if (outcome.action === "reported_on_route" || outcome.action === "reported_deviation") {
        setMatched({
          segmentIndex: outcome.matchedPosition.segmentIndex,
          perpendicularDistanceM: outcome.matchedPosition.perpendicularDistanceM,
          cumulativeDistanceM: outcome.matchedPosition.cumulativeDistanceM,
        });
        const p = calculateProgress(progressModel, outcome.matchedPosition);
        progressTracker.update(p.distanceAlongRouteM, progressModel.totalDistanceM);
        setProgress(p);
        rerouteTracker.recordPosition(p.currentEdgeId, p.distanceAlongRouteM);
        if (stateMachine.getState() === "ON_ROUTE") rerouteTracker.clear();
        setTemporaryAvoidEdgeIds(rerouteTracker.getTemporaryAvoidEdgeIds(p.distanceAlongRouteM, recentRouteMemoryM));
      }

      const newState = stateMachine.getState();
      setState((prevReactState) => {
        if (prevReactState !== newState) appendLog(`state: ${prevReactState} -> ${newState}`);
        return newState;
      });
    });

    source.start();

    // Onafhankelijke GPS_LOST-check (ontwerp sectie 12/23-stap 9) -- ook zonder nieuwe sample.
    const healthInterval = setInterval(() => controller.checkGpsHealth(), 2000);

    sourceRef.current = source;
    unsubscribeRef.current = unsubscribe;
    healthIntervalRef.current = healthInterval;
    setRunning(true);
    appendLog("Wacht op eerste GPS-fix of toestemmingsdialoog...");
    setState(stateMachine.getState()); // NOT_STARTED, totdat de eerste fix of een weigering binnenkomt
  }

  function stop() {
    sourceRef.current?.stop();
    unsubscribeRef.current?.();
    if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
    sourceRef.current = null;
    unsubscribeRef.current = null;
    healthIntervalRef.current = null;
    setRunning(false);
    appendLog("Sessie gestopt.");
  }

  useEffect(() => {
    return () => {
      // Opruimen bij het verlaten van de pagina -- geen watch die blijft doorlopen.
      sourceRef.current?.stop();
      unsubscribeRef.current?.();
      if (healthIntervalRef.current) clearInterval(healthIntervalRef.current);
    };
  }, []);

  const inputStyle = { width: "100%", padding: "8px", fontSize: 16, marginBottom: 8, boxSizing: "border-box" as const };
  const labelStyle = { fontSize: 12, color: "#555", display: "block", marginTop: 8 };
  const panelStyle = { background: "#f4f4f4", borderRadius: 8, padding: 12, marginTop: 12, fontFamily: "monospace", fontSize: 13 };

  return (
    <div style={{ padding: 16, maxWidth: 480, margin: "0 auto", fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 18 }}>Navigatie-debugharness (stap 11)</h1>
      <p style={{ fontSize: 13, color: "#555" }}>
        Geen locatiegegevens verlaten dit apparaat. Alles hieronder draait volledig lokaal.
      </p>

      {!running && (
        <>
          <label style={labelStyle}>Testroute start (lat)</label>
          <input style={inputStyle} value={fromLat} onChange={(e) => setFromLat(e.target.value)} placeholder="52.0907" inputMode="decimal" />
          <label style={labelStyle}>Testroute start (lon)</label>
          <input style={inputStyle} value={fromLon} onChange={(e) => setFromLon(e.target.value)} placeholder="5.1214" inputMode="decimal" />
          <label style={labelStyle}>Testroute eind (lat)</label>
          <input style={inputStyle} value={toLat} onChange={(e) => setToLat(e.target.value)} placeholder="52.0950" inputMode="decimal" />
          <label style={labelStyle}>Testroute eind (lon)</label>
          <input style={inputStyle} value={toLon} onChange={(e) => setToLon(e.target.value)} placeholder="5.1260" inputMode="decimal" />

          <details>
            <summary style={{ fontSize: 13, marginTop: 8 }}>Kalibratie-uitgangspunten (aanpasbaar)</summary>
            <label style={labelStyle}>deviationThresholdM</label>
            <input style={inputStyle} type="number" value={deviationThresholdM} onChange={(e) => setDeviationThresholdM(Number(e.target.value))} />
            <label style={labelStyle}>deviationConfirmDurationMs</label>
            <input style={inputStyle} type="number" value={deviationConfirmDurationMs} onChange={(e) => setDeviationConfirmDurationMs(Number(e.target.value))} />
            <label style={labelStyle}>rerouteCooldownMs</label>
            <input style={inputStyle} type="number" value={rerouteCooldownMs} onChange={(e) => setRerouteCooldownMs(Number(e.target.value))} />
            <label style={labelStyle}>RECENT_ROUTE_MEMORY (m)</label>
            <input style={inputStyle} type="number" value={recentRouteMemoryM} onChange={(e) => setRecentRouteMemoryM(Number(e.target.value))} />
            <label style={labelStyle}>accuracyThresholdM</label>
            <input style={inputStyle} type="number" value={accuracyThresholdM} onChange={(e) => setAccuracyThresholdM(Number(e.target.value))} />
            <label style={labelStyle}>gpsTimeoutMs</label>
            <input style={inputStyle} type="number" value={gpsTimeoutMs} onChange={(e) => setGpsTimeoutMs(Number(e.target.value))} />
          </details>
        </>
      )}

      {error && <p style={{ color: "#b00020", fontSize: 13 }}>{error}</p>}

      {state === "PERMISSION_DENIED" && (
        <div style={{ background: "#fff3cd", padding: 12, borderRadius: 8, marginTop: 8 }}>
          <p style={{ fontSize: 13, margin: 0 }}>
            Locatietoestemming geweigerd. Sta locatietoegang toe voor deze site in de Safari-instellingen en probeer opnieuw.
          </p>
        </div>
      )}

      <button
        onClick={running ? stop : start}
        style={{ width: "100%", padding: 14, fontSize: 16, marginTop: 12, background: running ? "#b00020" : "#1a7a3c", color: "white", border: "none", borderRadius: 8 }}
      >
        {running ? "Stop" : state === "PERMISSION_DENIED" ? "Opnieuw proberen" : "Start"}
      </button>

      <div style={panelStyle}>
        <div><strong>state:</strong> {state}</div>
        <div><strong>gps lost:</strong> {gpsHealth ? String(gpsHealth.isSignalLost) : "-"}</div>
        <hr />
        <div><strong>raw sample</strong></div>
        <div>lat/lon: {rawSample ? `${rawSample.lat.toFixed(6)}, ${rawSample.lon.toFixed(6)}` : "-"}</div>
        <div>accuracyM: {rawSample?.accuracyM.toFixed(1) ?? "-"}</div>
        <div>headingDeg: {rawSample?.headingDeg?.toFixed(0) ?? "null"}</div>
        <div>speedMps: {rawSample?.speedMps?.toFixed(2) ?? "null"}</div>
        <div>GPS timestamp (bronmetadata): {rawSample?.timestamp ?? "-"}</div>
        <hr />
        <div><strong>matched position</strong></div>
        <div>segmentIndex: {matched?.segmentIndex ?? "-"}</div>
        <div>perpendicularDistanceM: {matched?.perpendicularDistanceM.toFixed(1) ?? "-"}</div>
        <hr />
        <div><strong>progress</strong></div>
        <div>distanceAlongRouteM: {progress?.distanceAlongRouteM.toFixed(1) ?? "-"}</div>
        <div>remainingDistanceM: {progress?.remainingDistanceM.toFixed(1) ?? "-"}</div>
        <div>progressRatio: {progress ? (progress.progressRatio * 100).toFixed(1) + "%" : "-"}</div>
        <hr />
        <div><strong>reroute-context (mechanisch, geen netwerkverkeer)</strong></div>
        <div>temporaryAvoidEdgeIds: {temporaryAvoidEdgeIds.length ? temporaryAvoidEdgeIds.join(", ") : "(leeg)"}</div>
      </div>

      <div style={{ ...panelStyle, maxHeight: 200, overflowY: "auto" }}>
        <strong>log</strong>
        {log.map((entry, i) => (
          <div key={i}>
            {entry.t} — {entry.text}
          </div>
        ))}
      </div>
    </div>
  );
}
