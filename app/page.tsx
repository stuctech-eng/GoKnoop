"use client";

import { useState } from "react";
import { KnoopBadge } from "@/components/KnoopBadge";
import { RoutePreview } from "@/components/RoutePreview";

type Point = { x: number; y: number };
type Route = {
  nodes: string[];
  edges: string[];
  geometry: Point[];
  distanceM: number;
};
type LoopCandidate = {
  route: Route;
  actualDistanceM: number;
  deviationPercent: number;
};
type LocationCandidate = {
  logicalNodeId: string;
  displayNumber?: string;
  displayRegio?: string;
  distanceM: number;
};

type Step = "location" | "distance" | "loading" | "results" | "detail" | "error";

const DISTANCE_OPTIONS = [20, 30, 40, 50];

function formatKm(meters: number): string {
  return (meters / 1000).toLocaleString("nl-NL", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

export default function Home() {
  const [step, setStep] = useState<Step>("location");
  const [placeName, setPlaceName] = useState("");
  const [startLocation, setStartLocation] = useState<LocationCandidate | null>(null);
  const [targetDistanceKm, setTargetDistanceKm] = useState<number | null>(null);
  const [loops, setLoops] = useState<LoopCandidate[]>([]);
  const [selectedLoop, setSelectedLoop] = useState<LoopCandidate | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [navigationStarted, setNavigationStarted] = useState(false);

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
    if (!startLocation) return;
    setTargetDistanceKm(km);
    setStep("loading");
    try {
      const res = await fetch("/api/route/loop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startLogicalNodeId: startLocation.logicalNodeId,
          targetDistanceM: km * 1000,
          count: 4,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setErrorMessage("Er ging iets mis bij het zoeken naar routes.");
        setStep("error");
        return;
      }
      setLoops(data.loops || []);
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
    setTargetDistanceKm(null);
    setLoops([]);
    setSelectedLoop(null);
    setNavigationStarted(false);
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
              Rond {targetDistanceKm} km vanaf knooppunt {startLocation?.displayNumber}
            </p>

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
                  <RoutePreview geometry={loop.route.geometry} height={140} startLabel={startLocation?.displayNumber} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 10 }}>
                    <span style={{ fontFamily: "var(--font-display), -apple-system, sans-serif", fontSize: 28, fontWeight: 700 }}>
                      ~{formatKm(loop.actualDistanceM)} km
                    </span>
                    <span style={{ fontSize: 13, opacity: 0.6 }}>{loop.route.nodes.length} knooppunten</span>
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

            <RoutePreview geometry={selectedLoop.route.geometry} height={220} startLabel={startLocation?.displayNumber} />

            <div style={{ display: "flex", alignItems: "baseline", gap: 10, margin: "1.25rem 0" }}>
              <span style={{ fontFamily: "var(--font-display), -apple-system, sans-serif", fontSize: 40, fontWeight: 700 }}>
                {formatKm(selectedLoop.actualDistanceM)} km
              </span>
              <span style={{ fontSize: 14, opacity: 0.6 }}>({selectedLoop.route.nodes.length} knooppunten)</span>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: "1.5rem" }}>
              <KnoopBadge label={startLocation?.displayNumber || "?"} size={40} />
              <span style={{ fontSize: 14, opacity: 0.7 }}>Start en finish bij dit knooppunt — rondje</span>
            </div>

            {!navigationStarted ? (
              <button
                onClick={() => setNavigationStarted(true)}
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
            ) : (
              <p style={{ fontSize: 15, textAlign: "center", opacity: 0.7, padding: "1rem 0" }}>
                Navigatie tijdens het fietsen volgt in een latere fase van GoKnoop.
              </p>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
