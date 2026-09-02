"use client";

import { useState, useEffect } from "react";
import { KnoopBadge } from "@/components/KnoopBadge";
import { RoutePreview } from "@/components/RoutePreview";
import NavigationScreen from "@/components/navigation/NavigationScreen";
import LiveLocationScreen from "@/components/location/LiveLocationScreen";
import TabBar, { type TabId } from "@/components/layout/TabBar";
import { getRiddenRoutes, recordRiddenRoute } from "@/lib/history/ridden-routes-store";
import { getSavedRoutes, saveRoute, deleteSavedRoute, defaultSavedRouteName, type SavedRoute } from "@/lib/history/saved-routes-store";
import { getPausedRide, savePausedRide, clearPausedRide, type PausedRideSnapshot } from "@/lib/navigation/paused-ride-store";
import PauseScreen from "@/components/navigation/PauseScreen";
import type { GraphEdge } from "@/lib/route-engine/types";
import type { PhysicalAnchor } from "@/lib/navigation/physical-anchor";
import { loopOrientation } from "@/lib/route-engine/loop-orientation";

type Point = { x: number; y: number };
type Route = {
  nodes: string[];
  edges: string[];
  geometry: Point[];
  distanceM: number;
  /** Nodig om de NavigationSession aan de juiste dataset-versie te pinnen (ontwerp sectie 19). */
  datasetVersionId: string;
};
type LoopCandidate = {
  route: Route;
  actualDistanceM: number;
  deviationPercent: number;
  /** Volledige GraphEdge-objecten voor route.edges[] -- additief toegevoegd door de
   *  dataketen-fix (/api/route/loop), nodig om de Navigation Engine te voeden zonder
   *  edges te reconstrueren uit de platte geometrie. */
  resolvedEdges: GraphEdge[];
  /** Echte knooppuntnummers (GraphNode.displayNumber) voor route.nodes[], additief
   *  toegevoegd -- bugfix: route.nodes[] zijn interne Firestore-ID's, geen weergavenummers. */
  nodeDisplayNumbers: string[];
};
type LocationCandidate = {
  logicalNodeId: string;
  displayNumber?: string;
  displayRegio?: string;
  distanceM: number;
};

type Step = "distance" | "loading" | "results" | "detail" | "navigating" | "paused" | "error";

const DISTANCE_OPTIONS = [20, 30, 40, 50];

function formatKm(meters: number): string {
  return (meters / 1000).toLocaleString("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/**
 * Kwalificeert een route op afstandsafwijking -- puur ter presentatie.
 * De Route Engine zelf filtert of verbergt NOOIT routes op basis hiervan
 * (zie docs/phase2-route-engine-design.md sectie 9C, UX-inzicht 28-8-2026);
 * dit label helpt de gebruiker alleen om zelf te beoordelen welke optie het
 * best past, zonder dat de engine die keuze stiekem al voor 'm maakt.
 */
function qualifyDeviation(deviationPercent: number): { label: string; icon: string } {
  if (deviationPercent <= 5) return { label: "Zeer passend", icon: "⭐" };
  if (deviationPercent <= 15) return { label: "Passend", icon: "✓" };
  return { label: "Alternatief", icon: "↘" };
}

/**
 * Keert de rijrichting van een gekozen lus om (linksom <-> rechtsom) --
 * puur client-side, geen nieuwe serveraanroep nodig. Werkt correct dankzij
 * de richtingscorrectie in `buildRouteProgressModel` (Naarden-bugfix,
 * GOKNOOP-MASTER.md sectie 6D): die bepaalt per edge de juiste geometrie-
 * richting aan de hand van de knooppuntvolgorde, dus simpelweg de
 * nodes/edges-volgorde omkeren is voldoende -- geen handmatige edge-voor-
 * edge geometrie-omkering nodig.
 */
function reverseLoopCandidate(loop: LoopCandidate): LoopCandidate {
  return {
    ...loop,
    route: {
      ...loop.route,
      nodes: [...loop.route.nodes].reverse(),
      edges: [...loop.route.edges].reverse(),
      geometry: [...loop.route.geometry].reverse(),
    },
    resolvedEdges: [...loop.resolvedEdges].reverse(),
    nodeDisplayNumbers: [...loop.nodeDisplayNumbers].reverse(),
  };
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<TabId>("kaart");
  const [step, setStep] = useState<Step | null>(null);
  const [activeSavedRoute, setActiveSavedRoute] = useState<{
    edges: GraphEdge[];
    nodeSequence: string[];
    nodeDisplayNumbers: string[];
    datasetVersionId: string;
  } | null>(null);
  /** Fase 5 (sectie 9.18): het "terug naar het startknooppunt"-been van een Back to Start-rit. */
  const [activeBackToStartRoute, setActiveBackToStartRoute] = useState<{
    edges: GraphEdge[];
    nodeSequence: string[];
    nodeDisplayNumbers: string[];
    datasetVersionId: string;
    lastMileInfo: { distanceM: number; destinationLat: number; destinationLon: number; destinationLabel?: string };
  } | null>(null);
  /** Pauzeknop (sectie 9.19): bij mount gecheckt op een bestaande gepauzeerde rit (app opnieuw
   *  geopend/telefoon herstart). */
  const [pausedRide, setPausedRide] = useState<PausedRideSnapshot | null>(null);
  useEffect(() => {
    setPausedRide(getPausedRide());
  }, []);
  const [savedRoutesVersion, setSavedRoutesVersion] = useState(0); // bumpen om de Mijn-routes-lijst opnieuw te lezen
  const [showSaveNamePrompt, setShowSaveNamePrompt] = useState(false);
  const [routeNameInput, setRouteNameInput] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [startLocation, setStartLocation] = useState<LocationCandidate | null>(null);
  const [locationCandidates, setLocationCandidates] = useState<LocationCandidate[]>([]);
  const [resolvedStartNode, setResolvedStartNode] = useState<{
    logicalNodeId: string;
    displayNumber: string;
    distanceM: number | null;
    rank: number;
  } | null>(null);
  const [targetDistanceKm, setTargetDistanceKm] = useState<number | null>(null);
  const [loops, setLoops] = useState<LoopCandidate[]>([]);
  const [selectedLoop, setSelectedLoop] = useState<LoopCandidate | null>(null);
  const [errorMessage, setErrorMessage] = useState("");

  async function resolveByPlaceName() {
    if (!placeName.trim()) return;
    setStep("loading");
    try {
      const res = await fetch("/api/location/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ placeName }),
      });
      const data = await res.json();
      if (!res.ok || !data.candidates?.[0]) {
        setErrorMessage(`We konden '${placeName}' niet vinden. Probeer een andere plaatsnaam.`);
        setStep("error");
        return;
      }
      setStartLocation(data.candidates[0]);
      setLocationCandidates(data.candidates);
      setStep("distance");
    } catch {
      setErrorMessage("Er ging iets mis bij het zoeken. Probeer het opnieuw.");
      setStep("error");
    }
  }

  async function resolveFromConfirmedCoords(lat: number, lon: number) {
    setStep("loading");
    try {
      const res = await fetch("/api/location/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lon }),
      });
      const data = await res.json();
      if (!res.ok || !data.candidates?.[0]) {
        setErrorMessage("Geen knooppunten gevonden bij je locatie.");
        setStep("error");
        return;
      }
      setStartLocation(data.candidates[0]);
      setLocationCandidates(data.candidates);
      setStep("distance");
    } catch {
      setErrorMessage("Er ging iets mis bij het bepalen van je locatie. Probeer het opnieuw.");
      setStep("error");
    }
  }

  async function searchRoutes(km: number) {
    if (!startLocation || locationCandidates.length === 0) return;
    setTargetDistanceKm(km);
    setStep("loading");
    try {
      const res = await fetch("/api/route/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateNodeIds: locationCandidates.map((c) => c.logicalNodeId),
          candidateDistancesM: locationCandidates.map((c) => c.distanceM),
          targetDistanceM: km * 1000,
          count: 4,
          avoidRouteEdgeSets: getRiddenRoutes().map((r) => r.edgeIds),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // "no_usable_candidate" (Volendam-onderzoek 29-8-2026): geen van de kandidaat-
        // knooppunten leverde een bruikbare route op -- expliciet andere melding dan een
        // generieke serverfout, zodat de gebruiker begrijpt dat het aan de lokale
        // netwerktopologie ligt, niet aan een kapotte aanvraag.
        setErrorMessage(
          data.reason === "no_usable_candidate"
            ? `We konden geen bruikbare route van ${km} km vinden vanaf ${data.candidatesAttempted ?? locationCandidates.length} knooppunten bij je locatie. Probeer een andere afstand of locatie.`
            : "Er ging iets mis bij het zoeken naar routes."
        );
        setStep("error");
        return;
      }
      setLoops(data.loops || []);
      if (data.selectedStartNodeId) {
        setResolvedStartNode({
          logicalNodeId: data.selectedStartNodeId,
          displayNumber: data.selectedStartNodeDisplayNumber,
          distanceM: data.selectedStartNodeDistanceM,
          rank: data.selectedCandidateRank,
        });
      }
      setStep("results");
    } catch {
      setErrorMessage("Er ging iets mis bij het zoeken naar routes. Probeer het opnieuw.");
      setStep("error");
    }
  }

  function confirmSaveRoute() {
    if (!selectedLoop) return;
    saveRoute({
      name: routeNameInput.trim() || null,
      edgeIds: selectedLoop.route.edges,
      nodeIds: selectedLoop.route.nodes,
      startNodeId: selectedLoop.route.nodes[0],
      distanceM: selectedLoop.actualDistanceM,
      datasetVersionId: selectedLoop.route.datasetVersionId,
    });
    setShowSaveNamePrompt(false);
    setRouteNameInput("");
    setSavedRoutesVersion((v) => v + 1);
  }

  async function startSavedRoute(saved: SavedRoute) {
    setStep("loading");
    try {
      const res = await fetch("/api/route/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ datasetVersionId: saved.datasetVersionId, edgeIds: saved.edgeIds, nodeIds: saved.nodeIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error ?? "Deze opgeslagen route kon niet worden geladen.");
        setStep("error");
        return;
      }
      setActiveSavedRoute({
        edges: data.resolvedEdges,
        nodeSequence: saved.nodeIds,
        nodeDisplayNumbers: data.nodeDisplayNumbers,
        datasetVersionId: saved.datasetVersionId,
      });
      setStep("navigating");
    } catch {
      setErrorMessage("Er ging iets mis bij het laden van deze route.");
      setStep("error");
    }
  }

  /**
   * FASE 5 (sectie 9.18): berekent beide benen van "terug naar de parkeerplaats" in één
   * serveraanroep (`/api/route/back-to-start`) en remount NavigationScreen met het eerste been
   * (terug naar het startknooppunt, via de bestaande knooppunten-navigatie) als nieuwe actieve
   * route. Het tweede been (startknooppunt → parkeerplaats) wordt NIET als nieuwe in-app-
   * navigatie opgestart -- alleen de afstand + een Kaarten-link, getoond zodra het eerste been
   * "Aangekomen" bereikt (zelfde bewuste keuze als "auto naar parkeerplaats", sectie 9.6).
   */
  async function startBackToStart(payload: { currentLat: number; currentLon: number; physicalStart: PhysicalAnchor; routeStartNodeId: string }) {
    setStep("loading");
    try {
      const resolveRes = await fetch("/api/location/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: payload.currentLat, lon: payload.currentLon, limit: 5 }),
      });
      const resolveData = await resolveRes.json();
      if (!resolveRes.ok || !resolveData.candidates?.length) {
        setErrorMessage("Kon je huidige locatie niet bepalen voor Back to Start.");
        setStep("error");
        return;
      }

      const backRes = await fetch("/api/route/back-to-start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          candidateNodeIds: resolveData.candidates.map((c: { logicalNodeId: string }) => c.logicalNodeId),
          candidateDistancesM: resolveData.candidates.map((c: { distanceM: number }) => c.distanceM),
          routeStartNodeId: payload.routeStartNodeId,
          physicalStart: { lat: payload.physicalStart.lat, lon: payload.physicalStart.lon },
        }),
      });
      const backData = await backRes.json();
      if (!backRes.ok) {
        setErrorMessage(backData.error ?? "Back to Start kon niet berekend worden.");
        setStep("error");
        return;
      }

      setActiveBackToStartRoute({
        edges: backData.knotLeg.resolvedEdges,
        nodeSequence: backData.knotLeg.route.nodes,
        nodeDisplayNumbers: backData.knotLeg.nodeDisplayNumbers,
        datasetVersionId: backData.knotLeg.route.datasetVersionId,
        lastMileInfo: {
          distanceM: backData.lastMileLeg.distanceM,
          destinationLat: payload.physicalStart.lat,
          destinationLon: payload.physicalStart.lon,
          destinationLabel: payload.physicalStart.name,
        },
      });
      setStep("navigating");
    } catch {
      setErrorMessage("Er ging iets mis bij het berekenen van Back to Start.");
      setStep("error");
    }
  }

  /**
   * Geeft de nodes/edges/datasetVersionId van de HUIDIG actieve route terug, ongeacht welke
   * van de drie bronnen (Back to Start-been, opgeslagen route, of normaal gekozen rondje) op
   * dit moment NavigationScreen aandrijft -- nodig om een pauze-snapshot samen te stellen.
   */
  function getActiveRouteForPause(): { nodes: string[]; edges: string[]; datasetVersionId: string } | null {
    if (activeBackToStartRoute) {
      return {
        nodes: activeBackToStartRoute.nodeSequence,
        edges: activeBackToStartRoute.edges.map((e) => e.id),
        datasetVersionId: activeBackToStartRoute.datasetVersionId,
      };
    }
    if (activeSavedRoute) {
      return {
        nodes: activeSavedRoute.nodeSequence,
        edges: activeSavedRoute.edges.map((e) => e.id),
        datasetVersionId: activeSavedRoute.datasetVersionId,
      };
    }
    if (selectedLoop) {
      return { nodes: selectedLoop.route.nodes, edges: selectedLoop.route.edges, datasetVersionId: selectedLoop.route.datasetVersionId };
    }
    return null;
  }

  /** Pauzeknop (sectie 9.19): legt een snapshot vast en toont het aparte PauseScreen. */
  function handlePause(data: {
    lastKnownPosition: { lat: number; lon: number } | null;
    distanceTraveledM: number;
    rideTimeS: number;
    physicalStart: PhysicalAnchor | null;
  }) {
    const activeRoute = getActiveRouteForPause();
    if (!activeRoute) return;
    savePausedRide({
      routeNodes: activeRoute.nodes,
      routeEdges: activeRoute.edges,
      datasetVersionId: activeRoute.datasetVersionId,
      physicalStart: data.physicalStart,
      lastKnownPosition: data.lastKnownPosition,
      distanceTraveledM: data.distanceTraveledM,
      rideTimeS: data.rideTimeS,
    });
    setPausedRide(getPausedRide());
    setStep("paused");
  }

  /** Hervatten (sectie 9.19): zelfde patroon als startSavedRoute -- edges vers ophalen via /api/route/resolve. */
  async function resumePausedRide() {
    if (!pausedRide) return;
    setStep("loading");
    try {
      const res = await fetch("/api/route/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetVersionId: pausedRide.datasetVersionId,
          edgeIds: pausedRide.routeEdges,
          nodeIds: pausedRide.routeNodes,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage(data.error ?? "Deze gepauzeerde rit kon niet worden hervat.");
        setStep("error");
        return;
      }
      setActiveSavedRoute({
        edges: data.resolvedEdges,
        nodeSequence: pausedRide.routeNodes,
        nodeDisplayNumbers: data.nodeDisplayNumbers,
        datasetVersionId: pausedRide.datasetVersionId,
      });
      clearPausedRide();
      setPausedRide(null);
      setStep("navigating");
    } catch {
      setErrorMessage("Er ging iets mis bij het hervatten van deze rit.");
      setStep("error");
    }
  }

  /** Naar startpunt, vanuit het pauzescherm (sectie 9.19/9.22: altijd naar physicalStart, nooit iets anders). */
  function backToStartFromPause() {
    if (!pausedRide || !pausedRide.physicalStart || !pausedRide.lastKnownPosition) return;
    clearPausedRide();
    setPausedRide(null);
    startBackToStart({
      currentLat: pausedRide.lastKnownPosition.lat,
      currentLon: pausedRide.lastKnownPosition.lon,
      physicalStart: pausedRide.physicalStart,
      routeStartNodeId: pausedRide.routeNodes[0],
    });
  }

  /** Rit beëindigen vanuit pauze (sectie 9.19/9.23): voortgang tot nu toe onthouden, net als een normaal voltooide rit. */
  function endPausedRide() {
    if (!pausedRide) return;
    recordRiddenRoute({
      edgeIds: pausedRide.routeEdges,
      nodeIds: pausedRide.routeNodes,
      startNodeId: pausedRide.routeNodes[0],
      distanceM: pausedRide.distanceTraveledM,
    });
    clearPausedRide();
    setPausedRide(null);
    reset();
  }

  function reset() {
    setStep(null);
    setActiveTab("kaart");
    setActiveSavedRoute(null);
    setActiveBackToStartRoute(null);
    setPlaceName("");
    setStartLocation(null);
    setLocationCandidates([]);
    setResolvedStartNode(null);
    setTargetDistanceKm(null);
    setLoops([]);
    setSelectedLoop(null);
  }

  return (
    <main
      style={{
        minHeight: "100dvh",
        maxWidth: 480,
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {step === null ? (
        <>
          <header
            style={{
              background: "var(--color-knoop-green)",
              color: "white",
              padding: "1rem 1.25rem",
            }}
          >
            <h1 style={{ fontSize: 26, color: "white" }}>GoKnoop</h1>
          </header>

          <div style={{ flex: 1, position: "relative" }}>
            {activeTab === "kaart" && <LiveLocationScreen embedded onConfirm={resolveFromConfirmedCoords} />}

            {activeTab === "kaart" && pausedRide && (
              <div
                style={{
                  position: "absolute",
                  top: 12,
                  left: 12,
                  right: 12,
                  zIndex: 5,
                  background: "#085041",
                  color: "white",
                  borderRadius: 14,
                  padding: "12px 16px",
                  boxShadow: "0 2px 10px rgba(0,0,0,0.25)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                <div style={{ fontSize: 13 }}>
                  ⏸ Gepauzeerde rit — {(pausedRide.distanceTraveledM / 1000).toFixed(1)} km
                </div>
                <button
                  onClick={() => setStep("paused")}
                  style={{ background: "white", color: "#085041", border: "none", borderRadius: 10, padding: "6px 12px", fontSize: 13, fontWeight: 700 }}
                >
                  Bekijken
                </button>
              </div>
            )}

            {activeTab === "zoeken" && (
              <section style={{ padding: "1.5rem 1.25rem 4.5rem" }}>
                <h2 style={{ fontSize: 24, marginBottom: "1.25rem" }}>Zoek een plaats</h2>
                <input
                  value={placeName}
                  onChange={(e) => setPlaceName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && resolveByPlaceName()}
                  placeholder="Zoek een plaatsnaam"
                  style={{
                    width: "100%",
                    minHeight: 52,
                    padding: "0 16px",
                    fontSize: 17,
                    border: "2px solid var(--color-sand)",
                    borderRadius: "var(--radius-card)",
                    background: "white",
                  }}
                />
                <button
                  onClick={resolveByPlaceName}
                  disabled={!placeName.trim()}
                  style={{
                    width: "100%",
                    minHeight: 52,
                    marginTop: 12,
                    background: placeName.trim() ? "var(--color-canal-blue)" : "var(--color-sand)",
                    color: placeName.trim() ? "white" : "var(--color-ink)",
                    opacity: placeName.trim() ? 1 : 0.5,
                    border: "none",
                    borderRadius: "var(--radius-card)",
                    fontSize: 17,
                    fontWeight: 600,
                  }}
                >
                  Zoek plaats
                </button>
              </section>
            )}

            {activeTab === "mijnroutes" && (
              <section style={{ padding: "1.5rem 1.25rem 4.5rem" }}>
                <h2 style={{ fontSize: 24, marginBottom: "1.25rem" }}>Mijn routes</h2>
                {getSavedRoutes().length === 0 ? (
                  <p style={{ fontSize: 15, opacity: 0.6, textAlign: "center" }}>Je hebt nog geen routes opgeslagen.</p>
                ) : (
                  getSavedRoutes().map((saved) => (
                    <div
                      key={saved.id}
                      style={{
                        background: "white",
                        border: "1px solid #e5e5e0",
                        borderRadius: "var(--radius-card)",
                        padding: "1rem",
                        marginBottom: 12,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                        <div>
                          <div style={{ fontSize: 17, fontWeight: 700 }}>{saved.name ?? defaultSavedRouteName(saved.savedAt)}</div>
                          <div style={{ fontSize: 13, opacity: 0.6 }}>{formatKm(saved.distanceM)} km · {saved.nodeIds.length} knooppunten</div>
                        </div>
                        <button
                          onClick={() => { deleteSavedRoute(saved.id); setSavedRoutesVersion((v) => v + 1); }}
                          aria-label="Verwijderen"
                          style={{ background: "transparent", border: "none", color: "#999", fontSize: 13, padding: 4 }}
                        >
                          Verwijder
                        </button>
                      </div>
                      <button
                        onClick={() => startSavedRoute(saved)}
                        style={{
                          width: "100%",
                          minHeight: 44,
                          background: "var(--color-knoop-green)",
                          color: "white",
                          border: "none",
                          borderRadius: 8,
                          fontSize: 15,
                          fontWeight: 600,
                        }}
                      >
                        Start route
                      </button>
                    </div>
                  ))
                )}
              </section>
            )}

            {activeTab === "profiel" && (
              <section style={{ padding: "1.5rem 1.25rem 4.5rem", textAlign: "center" }}>
                <h2 style={{ fontSize: 24, marginBottom: "0.75rem" }}>Profiel</h2>
                <p style={{ fontSize: 15, opacity: 0.6 }}>Binnenkort beschikbaar.</p>
              </section>
            )}
          </div>

          <TabBar active={activeTab} onChange={setActiveTab} />
        </>
      ) : (
        <>
          <header
            style={{
              background: "var(--color-knoop-green)",
              color: "white",
              padding: "1.5rem 1.25rem 2rem",
            }}
          >
            <h1 style={{ fontSize: 34, color: "white" }}>GoKnoop</h1>
            <button
              onClick={reset}
              style={{
                marginTop: 8,
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.85)",
                fontSize: 14,
                padding: 0,
                textDecoration: "underline",
              }}
            >
              Opnieuw beginnen
            </button>
          </header>

          <div style={{ flex: 1, padding: "1.5rem 1.25rem 3rem" }}>
            {step === "distance" && startLocation && (
          <section>
            <p style={{ fontSize: 14, opacity: 0.65, marginBottom: 4 }}>
              Startpunt: knooppunt {startLocation.displayNumber} — {startLocation.displayRegio}
            </p>
            <h2 style={{ fontSize: 24, margin: "0.5rem 0 1.5rem" }}>Hoe ver?</h2>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              {DISTANCE_OPTIONS.map((km) => (
                <button
                  key={km}
                  onClick={() => searchRoutes(km)}
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 10,
                    padding: "1.25rem 0",
                    background: "white",
                    border: "2px solid var(--color-sand)",
                    borderRadius: "var(--radius-card)",
                  }}
                >
                  <KnoopBadge label={km} size={64} />
                  <span style={{ fontSize: 14, fontWeight: 600 }}>km</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === "loading" && (
          <section style={{ textAlign: "center", paddingTop: "3rem" }}>
            <p style={{ fontSize: 17 }}>Even zoeken...</p>
          </section>
        )}

        {step === "error" && (
          <section>
            <h2 style={{ fontSize: 22, marginBottom: 12 }}>Dat lukte niet</h2>
            <p style={{ fontSize: 16, lineHeight: 1.5, marginBottom: 20 }}>{errorMessage}</p>
            <button
              onClick={reset}
              style={{
                width: "100%",
                minHeight: 52,
                background: "var(--color-knoop-green)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-card)",
                fontSize: 17,
                fontWeight: 600,
              }}
            >
              Opnieuw beginnen
            </button>
          </section>
        )}

        {step === "results" && (
          <section>
            <h2 style={{ fontSize: 22, marginBottom: 4 }}>
              {loops.length === 0
                ? "Geen routes gevonden"
                : `Ik heb ${loops.length} ${loops.length === 1 ? "route" : "routes"} gevonden`}
            </h2>
            <p style={{ fontSize: 14, opacity: 0.65, marginBottom: "1.5rem" }}>
              Rond {targetDistanceKm} km vanaf knooppunt {resolvedStartNode?.displayNumber ?? startLocation?.displayNumber}
            </p>

            {resolvedStartNode && resolvedStartNode.rank > 1 && (
              <div
                style={{
                  background: "var(--color-sand)",
                  borderRadius: "var(--radius-card)",
                  padding: "0.85rem 1rem",
                  marginBottom: "1.5rem",
                  fontSize: 14,
                }}
              >
                <strong>Beste startpunt gevonden</strong>
                <br />
                📍 Knooppunt {resolvedStartNode.displayNumber}
                {resolvedStartNode.distanceM != null && <> — {(resolvedStartNode.distanceM / 1000).toFixed(1)} km van je locatie</>}
                <br />
                <span style={{ opacity: 0.7 }}>
                  Knooppunt {startLocation?.displayNumber} lag dichterbij, maar leverde geen bruikbare route op.
                </span>
              </div>
            )}

            {loops.length === 0 && (
              <>
                <p style={{ fontSize: 16, lineHeight: 1.5, marginBottom: 20 }}>
                  Er is geen route van ongeveer deze afstand vanaf dit knooppunt. Probeer een andere afstand.
                </p>
                <button
                  onClick={() => setStep("distance")}
                  style={{
                    width: "100%",
                    minHeight: 52,
                    background: "var(--color-canal-blue)",
                    color: "white",
                    border: "none",
                    borderRadius: "var(--radius-card)",
                    fontSize: 17,
                    fontWeight: 600,
                  }}
                >
                  Andere afstand kiezen
                </button>
              </>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {loops.map((loop, i) => (
                <button
                  key={i}
                  onClick={() => {
                    setSelectedLoop(loop);
                    setStep("detail");
                  }}
                  style={{
                    textAlign: "left",
                    background: "white",
                    border: "2px solid var(--color-sand)",
                    borderRadius: "var(--radius-card)",
                    padding: 14,
                    boxShadow: "var(--shadow-card)",
                  }}
                >
                  <RoutePreview geometry={loop.route.geometry} height={140} startLabel={loop.nodeDisplayNumbers[0]} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 10 }}>
                    <span style={{ fontFamily: "var(--font-display), -apple-system, sans-serif", fontSize: 28, fontWeight: 700 }}>
                      ~{formatKm(loop.actualDistanceM)} km
                    </span>
                    <span style={{ fontSize: 13, opacity: 0.6 }}>{loop.route.nodes.length} knooppunten</span>
                  </div>
                  <div style={{ fontSize: 13, marginTop: 4, opacity: 0.75 }}>
                    {qualifyDeviation(loop.deviationPercent).icon} {qualifyDeviation(loop.deviationPercent).label}
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {step === "detail" && selectedLoop && (
          <section>
            <button
              onClick={() => setStep("results")}
              style={{ background: "transparent", border: "none", color: "var(--color-canal-blue)", fontSize: 15, padding: 0, marginBottom: 16 }}
            >
              ← Terug naar routes
            </button>

            <RoutePreview geometry={selectedLoop.route.geometry} height={220} startLabel={selectedLoop.nodeDisplayNumbers[0]} />

            <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "1.25rem 0" }}>
              <span style={{ fontFamily: "var(--font-display), -apple-system, sans-serif", fontSize: 40, fontWeight: 700 }}>
                {formatKm(selectedLoop.actualDistanceM)} km
              </span>
              <span style={{ fontSize: 14, opacity: 0.6 }}>({selectedLoop.route.nodes.length} knooppunten)</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
              <KnoopBadge label={selectedLoop.nodeDisplayNumbers[0] || "?"} size={40} />
              <span style={{ fontSize: 14, opacity: 0.7 }}>Start en finish bij dit knooppunt — rondje</span>
            </div>

            <button
              onClick={() => setSelectedLoop(reverseLoopCandidate(selectedLoop))}
              style={{
                width: "100%",
                minHeight: 44,
                marginBottom: 8,
                background: "white",
                color: "var(--color-ink)",
                border: "1px solid #ccc",
                borderRadius: "var(--radius-card)",
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              ↻ Andere kant op rijden
            </button>
            <p style={{ fontSize: 13, opacity: 0.6, textAlign: "center", marginBottom: "1.5rem" }}>
              Rijdrichting: <strong>{loopOrientation(selectedLoop.route.geometry) === "linksom" ? "linksom" : "rechtsom"}</strong>
            </p>

            {!showSaveNamePrompt ? (
              <button
                onClick={() => setShowSaveNamePrompt(true)}
                style={{
                  width: "100%",
                  minHeight: 48,
                  marginBottom: 12,
                  background: "white",
                  color: "var(--color-knoop-green)",
                  border: "2px solid var(--color-knoop-green)",
                  borderRadius: "var(--radius-card)",
                  fontSize: 15,
                  fontWeight: 600,
                }}
              >
                ♡ Opslaan in Mijn routes
              </button>
            ) : (
              <div style={{ marginBottom: 12, background: "var(--color-sand)", borderRadius: "var(--radius-card)", padding: "0.85rem 1rem" }}>
                <p style={{ fontSize: 14, marginBottom: 8 }}>Geef je route een naam (optioneel)</p>
                <input
                  value={routeNameInput}
                  onChange={(e) => setRouteNameInput(e.target.value)}
                  placeholder="Bijv. Rondje Waterland"
                  style={{ width: "100%", minHeight: 44, padding: "0 12px", fontSize: 15, border: "1px solid #ccc", borderRadius: 8, marginBottom: 8, boxSizing: "border-box" }}
                />
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={confirmSaveRoute}
                    style={{ flex: 1, minHeight: 44, background: "var(--color-knoop-green)", color: "white", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600 }}
                  >
                    Opslaan
                  </button>
                  <button
                    onClick={() => { setShowSaveNamePrompt(false); setRouteNameInput(""); }}
                    style={{ flex: 1, minHeight: 44, background: "white", color: "var(--color-ink)", border: "1px solid #ccc", borderRadius: 8, fontSize: 15 }}
                  >
                    Annuleren
                  </button>
                </div>
              </div>
            )}

            <button
              onClick={() => setStep("navigating")}
              style={{
                width: "100%",
                minHeight: 56,
                background: "var(--color-knoop-green)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-card)",
                fontSize: 18,
                fontWeight: 700,
              }}
            >
              Start
            </button>
          </section>
        )}

        {step === "navigating" && (activeBackToStartRoute || activeSavedRoute || selectedLoop) && (
          <NavigationScreen
            key={
              activeBackToStartRoute
                ? `backtostart-${activeBackToStartRoute.datasetVersionId}-${activeBackToStartRoute.nodeSequence[0]}-${activeBackToStartRoute.nodeSequence[activeBackToStartRoute.nodeSequence.length - 1]}`
                : activeSavedRoute
                  ? `saved-${activeSavedRoute.datasetVersionId}-${activeSavedRoute.nodeSequence[0]}`
                  : `${startLocation?.logicalNodeId ?? "navigation"}-${selectedLoop?.route.edges.join(",") ?? ""}`
            }
            edges={activeBackToStartRoute ? activeBackToStartRoute.edges : activeSavedRoute ? activeSavedRoute.edges : selectedLoop!.resolvedEdges}
            nodeSequence={
              activeBackToStartRoute ? activeBackToStartRoute.nodeSequence : activeSavedRoute ? activeSavedRoute.nodeSequence : selectedLoop!.route.nodes
            }
            nodeDisplayNumbers={
              activeBackToStartRoute
                ? activeBackToStartRoute.nodeDisplayNumbers
                : activeSavedRoute
                  ? activeSavedRoute.nodeDisplayNumbers
                  : selectedLoop!.nodeDisplayNumbers
            }
            datasetVersionId={
              activeBackToStartRoute ? activeBackToStartRoute.datasetVersionId : activeSavedRoute ? activeSavedRoute.datasetVersionId : selectedLoop!.route.datasetVersionId
            }
            lastMileInfo={activeBackToStartRoute?.lastMileInfo}
            onExit={() => {
              if (activeBackToStartRoute) {
                setActiveBackToStartRoute(null);
                setStep(null);
                setActiveTab("kaart");
              } else if (activeSavedRoute) {
                setActiveSavedRoute(null);
                setStep(null);
                setActiveTab("mijnroutes");
              } else {
                setStep("detail");
              }
            }}
            onReverseDirection={
              activeBackToStartRoute || activeSavedRoute || !selectedLoop
                ? undefined
                : () => setSelectedLoop(reverseLoopCandidate(selectedLoop))
            }
            onPause={handlePause}
          />
        )}

        {step === "paused" && pausedRide && (
          <PauseScreen
            snapshot={pausedRide}
            onResume={resumePausedRide}
            onBackToStart={backToStartFromPause}
            onViewMap={() => {
              setStep(null);
              setActiveTab("kaart");
            }}
            onEndRide={endPausedRide}
          />
        )}
          </div>
        </>
      )}
    </main>
  );
}
