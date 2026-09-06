"use client";

/**
 * PauseScreen -- eigen, apart scherm voor een gepauzeerde rit (sectie 9.19,
 * 30-8-2026). Bewust NIET binnen NavigationScreen.tsx gebouwd ("blijft het
 * overzichtelijk, staat niet alles in het navigatiescherm") -- eigen
 * bestand, eigen verantwoordelijkheid.
 *
 * Puur presentatie + doorverwijzing naar callbacks -- de daadwerkelijke
 * hervat/beëindig-logica (snapshot laden, GPS herstarten, opnieuw matchen)
 * hoort bij de aanroeper (app/page.tsx), niet hier.
 */

import { useState } from "react";
import type { PausedRideSnapshot } from "@/lib/navigation/paused-ride-store";

export type PauseScreenProps = {
  snapshot: PausedRideSnapshot;
  onResume: () => void;
  onBackToStart: () => void;
  onViewMap: () => void;
  onEndRide: () => void;
};

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export default function PauseScreen({ snapshot, onResume, onBackToStart, onViewMap, onEndRide }: PauseScreenProps) {
  const [showEndConfirm, setShowEndConfirm] = useState(false);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--color-bg, #F7F5EF)",
        display: "flex",
        flexDirection: "column",
        zIndex: 50,
      }}
    >
      <div style={{ background: "#085041", color: "white", padding: "2rem 1.5rem 1.5rem", textAlign: "center" }}>
        <div style={{ fontSize: 13, letterSpacing: 1, color: "#9FE1CB", marginBottom: 6 }}>RIT GEPAUZEERD</div>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{(snapshot.distanceTraveledM / 1000).toFixed(1)} km · {formatDuration(snapshot.rideTimeS)}</div>
      </div>

      <div style={{ flex: 1, padding: "1.5rem", display: "flex", flexDirection: "column", gap: 12 }}>
        {!showEndConfirm ? (
          <>
            <button onClick={onResume} style={buttonStyle("#085041", "white")}>
              ▶️ Rit hervatten
            </button>
            <button onClick={onBackToStart} style={buttonStyle("white", "var(--color-ink, #1A1A1A)")}>
              📍 Naar startpunt
            </button>
            <button onClick={onViewMap} style={buttonStyle("white", "var(--color-ink, #1A1A1A)")}>
              🗺️ Kaart bekijken
            </button>
            {snapshot.lastKnownPosition && (
              // "Zoek koffie/eten in de buurt" (30-8-2026, op verzoek) -- zelfde Apple
              // Kaarten-truc als de parkeerplek-zoekfunctie tijdens fase A: GoKnoop bouwt hier
              // GEEN eigen restaurant-/koffiedatabase voor (zelfde reden als bij parkeren,
              // sectie 9.42-9.48's ervaring met een eigen Overpass-zoekdienst) -- Apple Kaarten
              // doet dit al betrouwbaar, GoKnoop stuurt alleen door.
              <a
                href={`https://maps.apple.com/?q=Koffie&near=${snapshot.lastKnownPosition.lat},${snapshot.lastKnownPosition.lon}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ ...buttonStyle("white", "var(--color-ink, #1A1A1A)"), display: "flex", alignItems: "center", justifyContent: "center", textDecoration: "none" }}
              >
                ☕ Koffie/eten in de buurt
              </a>
            )}
            <div style={{ flex: 1 }} />
            <button onClick={() => setShowEndConfirm(true)} style={buttonStyle("white", "#b00020")}>
              🏁 Rit beëindigen
            </button>
          </>
        ) : (
          <div style={{ textAlign: "center", marginTop: 40 }}>
            <p style={{ fontSize: 17, fontWeight: 600, marginBottom: 24 }}>Rit beëindigen?</p>
            <p style={{ fontSize: 14, opacity: 0.7, marginBottom: 24 }}>
              Je voortgang tot nu toe ({(snapshot.distanceTraveledM / 1000).toFixed(1)} km) wordt onthouden voor toekomstige
              routevoorstellen. Deze pauze kan daarna niet meer hervat worden.
            </p>
            <button onClick={onEndRide} style={{ ...buttonStyle("#b00020", "white"), marginBottom: 12 }}>
              Rit beëindigen
            </button>
            <button onClick={() => setShowEndConfirm(false)} style={buttonStyle("white", "var(--color-ink, #1A1A1A)")}>
              Doorgaan met fietsen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function buttonStyle(background: string, color: string): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 52,
    background,
    color,
    border: background === "white" ? "1px solid #ccc" : "none",
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 600,
  };
}
