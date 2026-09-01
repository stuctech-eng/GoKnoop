"use client";

import { useState } from "react";
import { KnoopBadge } from "@/components/KnoopBadge";
import { RoutePreview } from "@/components/RoutePreview";
import NavigationScreen from "@/components/navigation/NavigationScreen";
import type { GraphEdge } from "@/lib/route-engine/types";

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

type Step = "location" | "distance" | "loading" | "results" | "detail" | "navigating" | "error";

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

export default function Home() {
  const [step, setStep] = useState<Step>("location");
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

  async function resolveByGps() {
    setStep("loading");
    if (!navigator.geolocation) {
      setErrorMessage("Dit toestel ondersteunt geen locatiebepaling. Zoek op plaatsnaam.");
      setStep("error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const res = await fetch("/api/location/resolve", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ lat: position.coords.latitude, lon: position.coords.longitude }),
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
      },
      () => {
        setErrorMessage("We konden je locatie niet gebruiken. Zoek op plaatsnaam, of geef locatietoegang in je instellingen.");
        setStep("error");
      }
    );
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

  function reset() {
    setStep("location");
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
      <header
        style={{
          background: "var(--color-knoop-green)",
          color: "white",
          padding: "1.5rem 1.25rem 2rem",
        }}
      >
        <h1 style={{ fontSize: 34, color: "white" }}>GoKnoop</h1>
        {step !== "location" && (
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
        )}
      </header>

      <div style={{ flex: 1, padding: "1.5rem 1.25rem 3rem" }}>
        {step === "location" && (
          <section>
            <h2 style={{ fontSize: 24, marginBottom: "1.25rem" }}>Waar wil je fietsen?</h2>

            <button
              onClick={resolveByGps}
              style={{
                width: "100%",
                minHeight: 52,
                background: "var(--color-knoop-green)",
                color: "white",
                border: "none",
                borderRadius: "var(--radius-card)",
                fontSize: 17,
                fontWeight: 600,
                marginBottom: 12,
              }}
            >
              📍 Mijn locatie
            </button>

            <div style={{ textAlign: "center", color: "var(--color-ink)", opacity: 0.5, fontSize: 13, margin: "10px 0" }}>of</div>

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

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "1.5rem" }}>
              <KnoopBadge label={selectedLoop.nodeDisplayNumbers[0] || "?"} size={40} />
              <span style={{ fontSize: 14, opacity: 0.7 }}>Start en finish bij dit knooppunt — rondje</span>
            </div>

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

        {step === "navigating" && selectedLoop && (
          <NavigationScreen
            key={startLocation?.logicalNodeId ?? "navigation"}
            edges={selectedLoop.resolvedEdges}
            nodeSequence={selectedLoop.route.nodes}
            nodeDisplayNumbers={selectedLoop.nodeDisplayNumbers}
            datasetVersionId={selectedLoop.route.datasetVersionId}
            onExit={() => setStep("detail")}
          />
        )}
      </div>
    </main>
  );
}
