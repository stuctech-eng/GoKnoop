"use client";

/**
 * LiveLocationScreen (GOKNOOP-MASTER.md, live-locatiekaart, 29-8-2026).
 *
 * Toont een live MapLibre/Liberty-kaart met de actuele GPS-positie + rijrichting,
 * als bevestigingsstap ná "Mijn locatie" en VÓÓR de bestaande afstandskeuze --
 * bewust GEEN route, GEEN matching, GEEN NavigationSession (die horen bij een
 * gekozen route, die is hier nog niet gekozen). Puur "waar ben ik nu".
 *
 * Hergebruikt bewust dezelfde, al bewezen bouwstenen als NavigationScreen:
 * dezelfde worker-URL-fix, dezelfde Liberty-stijl-URL, dezelfde
 * BrowserGeolocationSource (stap 11) -- maar zonder de navigatie-engine
 * (geen state machine/deviation detector nodig, er is nog geen route).
 *
 * `compassAbbreviation` (lib/navigation/direction/) voor de NW/315°-weergave --
 * puur formattering, geen navigatiebeslissing.
 */

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { BrowserGeolocationSource } from "@/lib/navigation/gps-sources/browser-geolocation-source";
import { compassAbbreviation } from "@/lib/navigation/direction/relative-direction";

let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}

const LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const POSITION_COLOR = "#3B82F6"; // zelfde blauw als de live-positiemarker op het navigatiescherm

export type LiveLocationScreenProps = {
  /** Aangeroepen zodra de gebruiker deze locatie bevestigt om door te gaan naar afstandskeuze. */
  onConfirm: (lat: number, lon: number) => void;
  onCancel: () => void;
};

function accuracyLabel(accuracyM: number): string {
  if (accuracyM <= 15) return "GPS nauwkeurig";
  if (accuracyM <= 50) return "GPS redelijk nauwkeurig";
  return "GPS onnauwkeurig";
}

export default function LiveLocationScreen({ onConfirm, onCancel }: LiveLocationScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const sourceRef = useRef<BrowserGeolocationSource | null>(null);
  const hasCenteredRef = useRef(false);

  const [mapStatus, setMapStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ lat: number; lon: number; accuracyM: number; headingDeg: number | null } | null>(null);

  // Kaart eenmalig opzetten.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureWorkerUrlConfigured();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: LIBERTY_STYLE_URL,
      center: [5.1214, 52.0907], // uitgangspunt, wordt direct overschreven zodra de eerste GPS-fix binnenkomt
      zoom: 15,
      bearing: 0,
      pitch: 0,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");

    map.on("load", () => {
      map.addSource("goknoop-live-position", {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
      });
      // Buitenste, subtiele "nauwkeurigheids"-gloed + de blauwe stip zelf -- zelfde taal als de mockup.
      map.addLayer({
        id: "goknoop-live-position-halo",
        type: "circle",
        source: "goknoop-live-position",
        paint: { "circle-radius": 22, "circle-color": POSITION_COLOR, "circle-opacity": 0.15 },
      });
      map.addLayer({
        id: "goknoop-live-position-dot",
        type: "circle",
        source: "goknoop-live-position",
        paint: { "circle-radius": 8, "circle-color": POSITION_COLOR, "circle-stroke-color": "#FFFFFF", "circle-stroke-width": 3 },
      });

      setMapStatus("loaded");
    });

    map.on("error", (e) => {
      setMapStatus("error");
      setError(e?.error?.message ?? "Onbekende kaartfout.");
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Live GPS-positie starten.
  useEffect(() => {
    let source: BrowserGeolocationSource;
    try {
      source = new BrowserGeolocationSource({
        enableHighAccuracy: true,
        onError: (err) => setError(err.message),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const unsubscribe = source.subscribe((sample) => {
      setPosition({ lat: sample.lat, lon: sample.lon, accuracyM: sample.accuracyM, headingDeg: sample.headingDeg });

      const map = mapRef.current;
      if (map) {
        const src = map.getSource("goknoop-live-position") as maplibregl.GeoJSONSource | undefined;
        src?.setData({
          type: "FeatureCollection",
          features: [{ type: "Feature", geometry: { type: "Point", coordinates: [sample.lon, sample.lat] }, properties: {} }],
        });

        if (!hasCenteredRef.current) {
          map.jumpTo({ center: [sample.lon, sample.lat], zoom: 16 });
          hasCenteredRef.current = true;
        }
      }
    });

    source.start();
    sourceRef.current = source;
    return () => {
      source.stop();
      unsubscribe();
    };
  }, []);

  function recenter() {
    if (position && mapRef.current) {
      mapRef.current.flyTo({ center: [position.lon, position.lat], zoom: 16 });
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, width: "100%", height: "100dvh", zIndex: 50, background: "#000" }}>
      <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />

      <button
        onClick={onCancel}
        aria-label="Terug"
        style={{
          position: "absolute",
          top: 12,
          left: 12,
          zIndex: 11,
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

      <button
        onClick={recenter}
        disabled={!position}
        aria-label="Centreer op mijn locatie"
        style={{
          position: "absolute",
          bottom: 190,
          right: 12,
          zIndex: 10,
          width: 44,
          height: 44,
          borderRadius: 22,
          border: "none",
          background: "white",
          boxShadow: "0 2px 8px rgba(0,0,0,0.25)",
          fontSize: 18,
        }}
      >
        🎯
      </button>

      {error && (
        <div
          style={{
            position: "absolute",
            top: 12,
            left: 56,
            right: 12,
            background: "rgba(255,255,255,0.95)",
            borderRadius: 8,
            padding: "8px 12px",
            fontSize: 12,
            color: "#b00020",
            zIndex: 10,
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          bottom: 12,
          left: 12,
          right: 12,
          background: "white",
          borderRadius: 16,
          padding: "16px 18px",
          zIndex: 10,
          boxShadow: "0 -2px 16px rgba(0,0,0,0.15)",
        }}
      >
        {!position ? (
          <div style={{ fontSize: 14, color: "#7A7A7A" }}>{mapStatus === "loading" ? "Kaart laden..." : "Wachten op GPS-signaal..."}</div>
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 14, height: 14, borderRadius: 7, background: POSITION_COLOR, border: "2px solid white", boxShadow: "0 0 0 1px #ddd" }} />
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>Jouw locatie</div>
                <div style={{ fontSize: 12, color: "#7A7A7A" }}>{accuracyLabel(position.accuracyM)}</div>
              </div>
            </div>
            {position.headingDeg !== null && (
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 11, color: "#7A7A7A" }}>Richting</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: "#1A1A1A" }}>{compassAbbreviation(position.headingDeg)}</div>
                <div style={{ fontSize: 11, color: "#7A7A7A" }}>{Math.round(position.headingDeg)}°</div>
              </div>
            )}
          </div>
        )}

        <button
          onClick={() => position && onConfirm(position.lat, position.lon)}
          disabled={!position}
          style={{
            width: "100%",
            padding: 14,
            fontSize: 16,
            fontWeight: 700,
            borderRadius: 12,
            border: "none",
            background: position ? "#085041" : "#ccc",
            color: "white",
          }}
        >
          Gebruik deze locatie
        </button>
      </div>
    </div>
  );
}
