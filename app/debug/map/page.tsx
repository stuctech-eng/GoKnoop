"use client";

/**
 * MapLibre-basisintegratie (GOKNOOP-MASTER.md sectie 7, stap 12.2).
 *
 * Bewijst precies één ding: "Kan GoKnoop betrouwbaar een MapLibre-kaart
 * tonen?" Bewust GEEN route, GEEN GPS, GEEN navigatielogica -- dat komt pas
 * in 12.3/12.4. Dit bestand raakt `lib/navigation/` niet aan (sectie 5.0,
 * de isolatieregel: de navigatie-engine mag nooit van MapLibre weten, en
 * omgekeerd blijft deze stap ook vrij van de navigatie-engine totdat 12.4
 * daadwerkelijk de live positie erbij haalt).
 *
 * Noordgericht (bearing altijd 0), geen kaartrotatie via slepen of
 * pinch-gebaren (sectie 5.3: de kaart draait niet mee met de rijrichting) --
 * pannen/zoomen blijft wel gewoon mogelijk.
 *
 * Stijl: MapLibre's publieke demo-stijl (geen API-key nodig, geschikt om
 * puur de integratie zelf te bewijzen). Een eigen/definitieve kaartstijl is
 * een latere beslissing (12.3+), hier bewust niet vooruitgelopen.
 */

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";

// Next.js (Turbopack) breekt de automatische worker-URL-resolutie van MapLibre v6:
// `new URL('maplibre-gl/dist/maplibre-gl-worker.mjs', import.meta.url)` wordt door
// Turbopack omgezet in een gehasht asset zonder de vereiste sibling
// (maplibre-gl-shared.mjs) ernaast te plaatsen. Gevolg: de kaart mount (canvas,
// achtergrondkleur, besturing werken), maar er wordt nooit een tegel opgevraagd --
// exact het "blijft op loading staan, verder gebeurt er niets"-symptoom.
// Oplossing: beide workerbestanden zelf in public/ zetten en hier expliciet naar
// wijzen, één keer, vóór de eerste kaart wordt aangemaakt.
let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}
import "maplibre-gl/dist/maplibre-gl.css";

const DEMO_STYLE_URL = "https://demotiles.maplibre.org/style.json";
// Utrecht-omgeving, dezelfde regio als de stap 11-iPhone-tests -- geen diepere betekenis, alleen een zinvol startpunt.
const INITIAL_CENTER: [number, number] = [5.1214, 52.0907]; // MapLibre: [lon, lat], LET OP omgekeerd t.o.v. de eigen Point-conventie (x=RD-oost, y=RD-noord)
// BEWUST LAAG: de publieke demo-stijl is een wereldkaart-op-lage-resolutie (landen als
// vlakken), geen straatniveau-dataset. Op een hoog zoomniveau (bijv. 13) is er geen data
// meer -- je ziet dan alleen de vlakkleur van het land waar je middenin zit, wat als een
// "lege" kaart oogt terwijl het renderen zelf prima werkt. Zoom 4 toont daadwerkelijk
// landgrenzen, genoeg om de integratie zelf te bewijzen (stap 12.2's enige doel). Een
// straatniveau-geschikte stijl voor Nederland is een APARTE, nog te nemen beslissing bij
// stap 12.3 (route-visualisatie) -- hier niet stilzwijgend vooruitgelopen.
const INITIAL_ZOOM = 4;

type LoadStatus = "loading" | "loaded" | "error";

export default function MapDebugPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);

  function appendLog(text: string) {
    setLog((prev) => [`${new Date().toISOString().slice(11, 23)} — ${text}`, ...prev].slice(0, 20));
  }

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    ensureWorkerUrlConfigured();

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: containerRef.current,
        style: DEMO_STYLE_URL,
        center: INITIAL_CENTER,
        zoom: INITIAL_ZOOM,
        bearing: 0,
        pitch: 0,
        dragRotate: false, // geen rotatie via slepen (sectie 5.3: kaart blijft noordgericht)
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
      appendLog(`Kaart-initialisatie mislukt: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Pinch-zoom blijft werken, alleen de rotatie-component van dat gebaar wordt uitgeschakeld
    // (dragRotate hierboven dekt alleen muis/sleep-rotatie, niet het twee-vinger-draaigebaar).
    map.touchZoomRotate.disableRotation();

    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), "top-right");

    map.on("load", () => {
      setStatus("loaded");
      appendLog("Kaart geladen (style 'load'-event).");
    });

    map.on("error", (e) => {
      setStatus("error");
      const message = e?.error?.message ?? "Onbekende MapLibre-fout.";
      setErrorMessage(message);
      appendLog(`MapLibre-fout: ${message}`);
    });

    // Resize/lifecycle: expliciete resize bij viewport-wijziging (rotatie van het toestel,
    // PWA-safe-area-verschuivingen) -- niet blind vertrouwen op automatische detectie.
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
