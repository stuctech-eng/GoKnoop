"use client";

/**
 * Lochem tile-inspector (6-9-2026, GPT-onderzoeksopdracht).
 *
 * Geïsoleerde diagnostische pagina -- volledig onafhankelijk van
 * LiveLocationScreen/NavigationScreen, raakt de live app op geen enkele
 * manier. Doel: bewijs verzamelen over de "i.codePointAt is not a
 * function"-crash bij Lochem-centrum (52.1578, 6.4221, zoom 16), i.p.v. nog
 * een fix te gokken.
 *
 * Drie stappen, exact zoals geadviseerd:
 * 1. queryRenderedFeatures() -- welke features/properties staan er echt,
 *    en zijn name/name_en/name:latin/name:nonlatin/ref overal strings?
 * 2. Beweging simuleren (kleine panBy-stappen, zoals live GPS-volgen doet)
 *    en fouten tellen -- reproduceert dit de hoge frequentie die we zagen?
 * 3. A/B-test: dezelfde simulatie met alle symbol-lagen (labels) uitgezet.
 *    Verdwijnt de fout? Dat isoleert vector tile -> feature property ->
 *    symbol/text rendering als oorzaak, zonder te gokken.
 */

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}

const LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const LOCHEM_CENTER: [number, number] = [6.422090574730873, 52.157814726340035]; // exact uit het echte incident
const LOCHEM_ZOOM = 16;
const NAME_LIKE_KEYS = ["name", "name_en", "name:latin", "name:nonlatin", "ref", "housenumber"];

type Suspect = {
  key: string;
  value: unknown;
  valueType: string;
  layer: string | undefined;
  sourceLayer: string | undefined;
  allProperties: Record<string, unknown>;
};

export default function LochemTileInspectorPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapStatus, setMapStatus] = useState<"laden" | "klaar" | "fout">("laden");
  const [totalFeatures, setTotalFeatures] = useState<number | null>(null);
  const [suspects, setSuspects] = useState<Suspect[]>([]);
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [simRunning, setSimRunning] = useState(false);
  const [errorCountA, setErrorCountA] = useState(0); // labels aan
  const [errorCountB, setErrorCountB] = useState(0); // labels uit
  const [lastErrorMessage, setLastErrorMessage] = useState<string | null>(null);
  const errorCountRef = useRef(0);
  const labelsEnabledRef = useRef(true);

  useEffect(() => {
    labelsEnabledRef.current = labelsEnabled;
  }, [labelsEnabled]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureWorkerUrlConfigured();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: LIBERTY_STYLE_URL,
      center: LOCHEM_CENTER,
      zoom: LOCHEM_ZOOM,
    });

    map.on("error", (e) => {
      errorCountRef.current++;
      setLastErrorMessage(e?.error?.message ?? "Onbekende fout.");
      if (labelsEnabledRef.current) {
        setErrorCountA((c) => c + 1);
      } else {
        setErrorCountB((c) => c + 1);
      }
    });

    map.on("idle", function onFirstIdle() {
      // Alleen de EERSTE keer idle -- daarna zou queryRenderedFeatures steeds
      // opnieuw kunnen, maar we willen één schone eerste meting.
      map.off("idle", onFirstIdle);
      inspectRenderedFeatures(map);
      setMapStatus("klaar");
    });

    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function inspectRenderedFeatures(map: maplibregl.Map) {
    const features = map.queryRenderedFeatures();
    setTotalFeatures(features.length);

    const found: Suspect[] = [];
    for (const feature of features) {
      const props = feature.properties || {};
      for (const key of NAME_LIKE_KEYS) {
        if (key in props) {
          const value = props[key];
          if (typeof value !== "string" && value !== null && value !== undefined) {
            found.push({
              key,
              value,
              valueType: typeof value,
              layer: feature.layer?.id,
              sourceLayer: feature.sourceLayer,
              allProperties: props,
            });
          }
        }
      }
    }
    setSuspects(found);
  }

  function toggleLabels() {
    const map = mapRef.current;
    if (!map) return;
    const newEnabled = !labelsEnabled;
    setLabelsEnabled(newEnabled);
    const style = map.getStyle();
    if (!style?.layers) return;
    for (const layer of style.layers) {
      if (layer.type === "symbol") {
        map.setLayoutProperty(layer.id, "visibility", newEnabled ? "visible" : "none");
      }
    }
  }

  async function runMovementSimulation() {
    const map = mapRef.current;
    if (!map || simRunning) return;
    setSimRunning(true);
    errorCountRef.current = 0;
    if (labelsEnabled) setErrorCountA(0);
    else setErrorCountB(0);

    // Simuleert live-GPS-volgen: veel kleine achtereenvolgende panBy-stappen,
    // zelfde orde van grootte als de centerLat/centerLon-verschillen die we
    // in de echte error-logs zagen (~1e-7 graden per stap).
    for (let i = 0; i < 60; i++) {
      map.panBy([i % 2 === 0 ? 1 : -1, i % 3 === 0 ? 1 : -1], { duration: 0 });
      await new Promise((r) => setTimeout(r, 40));
    }
    setSimRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Lochem tile-inspector</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Geïsoleerd van de live app. Kaart gecentreerd op exact de incident-locatie (52.1578, 6.4221, zoom 16).
      </p>

      <div ref={containerRef} style={{ width: "100%", height: 300, borderRadius: 8, marginBottom: 16, background: "#eee" }} />

      {mapStatus === "laden" && <p>Kaart laden...</p>}

      {mapStatus === "klaar" && (
        <>
          <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Stap 1: queryRenderedFeatures()</div>
            <div style={{ fontSize: 13 }}>
              {totalFeatures} gerenderde features in beeld · <b style={{ color: suspects.length > 0 ? "#c00" : "green" }}>{suspects.length} verdachte non-string name-achtige properties</b>
            </div>
          </div>

          {suspects.length > 0 && (
            <div style={{ marginBottom: 16, padding: 12, background: "#fee", border: "1px solid #fbb", borderRadius: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#c00", marginBottom: 6 }}>Verdachten gevonden:</div>
              {suspects.map((s, i) => (
                <div key={i} style={{ fontSize: 12, fontFamily: "monospace", marginBottom: 8, borderTop: "1px solid #fcc", paddingTop: 6 }}>
                  <div>
                    <b>{s.key}</b> = <code>{JSON.stringify(s.value)}</code> (type: {s.valueType})
                  </div>
                  <div style={{ opacity: 0.7 }}>
                    laag: {s.layer ?? "-"} · source-layer: {s.sourceLayer ?? "-"}
                  </div>
                  <pre style={{ fontSize: 10, background: "#fff", padding: 6, borderRadius: 4, overflowX: "auto", marginTop: 4 }}>
                    {JSON.stringify(s.allProperties, null, 2)}
                  </pre>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Stap 2+3: beweging simuleren (A/B, labels aan/uit)</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
              <button
                onClick={toggleLabels}
                style={{ flex: 1, padding: 10, fontSize: 14, background: labelsEnabled ? "#085041" : "#a83232", color: "white", border: "none", borderRadius: 8 }}
              >
                Labels: {labelsEnabled ? "AAN (test A)" : "UIT (test B)"}
              </button>
              <button
                onClick={runMovementSimulation}
                disabled={simRunning}
                style={{ flex: 1, padding: 10, fontSize: 14, background: "#1a73e8", color: "white", border: "none", borderRadius: 8 }}
              >
                {simRunning ? "Bezig..." : "Simuleer beweging"}
              </button>
            </div>
            <div style={{ fontSize: 13 }}>
              Fouten tijdens test A (labels aan): <b style={{ color: errorCountA > 0 ? "#c00" : "green" }}>{errorCountA}</b>
              <br />
              Fouten tijdens test B (labels uit): <b style={{ color: errorCountB > 0 ? "#c00" : "green" }}>{errorCountB}</b>
            </div>
            {lastErrorMessage && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>Laatste foutmelding: {lastErrorMessage}</div>}
          </div>
        </>
      )}

      {mapStatus === "fout" && <p style={{ color: "red" }}>Kaart kon niet laden.</p>}
    </div>
  );
}
