"use client";

/**
 * Tile-inspector (6-9-2026, herbouwd na GPT-review van de eerste ronde).
 *
 * Geïsoleerd van de live app -- eigen, onafhankelijke kaartinstantie.
 * Reparaties t.o.v. de eerste versie:
 * - queryRenderedFeatures() gaf altijd 0 features terug. Vermoedelijke
 *   oorzaak: de EERSTE "idle" kan te vroeg vuren (vóór de tegels voor de
 *   exacte zoom/center daadwerkelijk geladen zijn), en de oude code stopte
 *   na die ene meting. Nu: blijft op ELKE idle opnieuw meten, plus een
 *   handmatige "Herhaal meting"-knop.
 * - Locatie is nu instelbaar (Lochem EN Diepenheim testen, niet hardcoded).
 * - Directe to-string()-A/B-test ingebouwd: patcht de live stijl met
 *   to-string() rond alle text-field-expressies, zodat je meteen kunt zien
 *   of dat de crash oplost -- zonder eerst iets naar productie te bouwen.
 */

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from "maplibre-gl";

let workerUrlConfigured = false;
function ensureWorkerUrlConfigured() {
  if (workerUrlConfigured) return;
  maplibregl.setWorkerUrl("/maplibre-gl-worker.mjs");
  workerUrlConfigured = true;
}

const LIBERTY_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
const PRESETS = {
  lochem: { lat: 52.157814726340035, lon: 6.422090574730873, label: "Lochem" },
  diepenheim: { lat: 52.209, lon: 6.575, label: "Diepenheim (bij benadering)" },
};
const NAME_LIKE_KEYS = ["name", "name_en", "name:latin", "name:nonlatin", "ref", "housenumber"];

type Suspect = {
  key: string;
  value: unknown;
  valueType: string;
  layer: string | undefined;
  sourceLayer: string | undefined;
  allProperties: Record<string, unknown>;
};

/** Wrapt elke text-field-expressie (array-vorm) in to-string(), tenzij al gewrapt. */
function patchStyleWithToString(style: StyleSpecification): StyleSpecification {
  const patched: StyleSpecification = JSON.parse(JSON.stringify(style));
  for (const layer of patched.layers as LayerSpecification[]) {
    if (layer.type !== "symbol") continue;
    const layout = (layer as { layout?: Record<string, unknown> }).layout;
    const textField = layout?.["text-field"];
    if (Array.isArray(textField) && textField[0] !== "to-string") {
      (layout as Record<string, unknown>)["text-field"] = ["to-string", textField] as unknown as ExpressionSpecification;
    }
  }
  return patched;
}

export default function TileInspectorPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const originalStyleRef = useRef<StyleSpecification | null>(null);
  const [mapStatus, setMapStatus] = useState<"laden" | "klaar" | "fout">("laden");
  const [totalFeatures, setTotalFeatures] = useState<number | null>(null);
  const [suspects, setSuspects] = useState<Suspect[]>([]);
  const [idleCount, setIdleCount] = useState(0);
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [toStringPatchActive, setToStringPatchActive] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [errorCountA, setErrorCountA] = useState(0);
  const [errorCountB, setErrorCountB] = useState(0);
  const [lastErrorMessage, setLastErrorMessage] = useState<string | null>(null);
  const [lat, setLat] = useState(String(PRESETS.lochem.lat));
  const [lon, setLon] = useState(String(PRESETS.lochem.lon));
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
      center: [Number(lat) ? Number(lon) : 6.4221, Number(lat) || 52.1578],
      zoom: 16,
    });

    map.on("error", (e) => {
      setLastErrorMessage(e?.error?.message ?? "Onbekende fout.");
      if (labelsEnabledRef.current) setErrorCountA((c) => c + 1);
      else setErrorCountB((c) => c + 1);
    });

    map.on("styledata", () => {
      if (!originalStyleRef.current) {
        const s = map.getStyle();
        if (s) originalStyleRef.current = JSON.parse(JSON.stringify(s));
      }
    });

    // Gerepareerd: blijft op ELKE idle opnieuw meten (niet alleen de eerste --
    // die kan te vroeg vuren vóór tegels echt geladen zijn), zodat de weergave
    // vanzelf naar de juiste waarde convergeert.
    map.on("idle", () => {
      inspectRenderedFeatures(map);
      setIdleCount((c) => c + 1);
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

  function goToLocation(targetLat: number, targetLon: number) {
    const map = mapRef.current;
    if (!map) return;
    setLat(String(targetLat));
    setLon(String(targetLon));
    setTotalFeatures(null);
    setSuspects([]);
    map.jumpTo({ center: [targetLon, targetLat], zoom: 16 });
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

  function toggleToStringPatch() {
    const map = mapRef.current;
    if (!map || !originalStyleRef.current) return;
    const newActive = !toStringPatchActive;
    setToStringPatchActive(newActive);
    if (newActive) {
      map.setStyle(patchStyleWithToString(originalStyleRef.current));
    } else {
      map.setStyle(originalStyleRef.current);
    }
  }

  async function runMovementSimulation() {
    const map = mapRef.current;
    if (!map || simRunning) return;
    setSimRunning(true);
    if (labelsEnabled) setErrorCountA(0);
    else setErrorCountB(0);

    for (let i = 0; i < 60; i++) {
      map.panBy([i % 2 === 0 ? 1 : -1, i % 3 === 0 ? 1 : -1], { duration: 0 });
      await new Promise((r) => setTimeout(r, 40));
    }
    setSimRunning(false);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Tile-inspector</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>Geïsoleerd van de live app -- eigen kaartinstantie.</p>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <button onClick={() => goToLocation(PRESETS.lochem.lat, PRESETS.lochem.lon)} style={{ flex: 1, padding: 8, fontSize: 13, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          Lochem
        </button>
        <button onClick={() => goToLocation(PRESETS.diepenheim.lat, PRESETS.diepenheim.lon)} style={{ flex: 1, padding: 8, fontSize: 13, background: "#085041", color: "white", border: "none", borderRadius: 8 }}>
          Diepenheim
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="lat" style={{ flex: 1, padding: 8, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <input value={lon} onChange={(e) => setLon(e.target.value)} placeholder="lon" style={{ flex: 1, padding: 8, fontSize: 13, border: "1px solid #ccc", borderRadius: 8 }} />
        <button onClick={() => goToLocation(Number(lat), Number(lon))} style={{ padding: "8px 12px", fontSize: 13, background: "#555", color: "white", border: "none", borderRadius: 8 }}>
          Ga
        </button>
      </div>

      <div ref={containerRef} style={{ width: "100%", height: 300, borderRadius: 8, marginBottom: 16, background: "#eee" }} />

      {mapStatus === "laden" && <p>Kaart laden...</p>}

      {mapStatus === "klaar" && (
        <>
          <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>queryRenderedFeatures() -- idle #{idleCount}</div>
              <button onClick={() => mapRef.current && inspectRenderedFeatures(mapRef.current)} style={{ padding: "4px 10px", fontSize: 12, background: "#1a73e8", color: "white", border: "none", borderRadius: 6 }}>
                Herhaal meting
              </button>
            </div>
            <div style={{ fontSize: 13 }}>
              {totalFeatures} gerenderde features · <b style={{ color: suspects.length > 0 ? "#c00" : "green" }}>{suspects.length} verdachte non-string properties</b>
            </div>
          </div>

          {suspects.length > 0 && (
            <div style={{ marginBottom: 16, padding: 12, background: "#fee", border: "1px solid #fbb", borderRadius: 8 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#c00", marginBottom: 6 }}>Verdachten:</div>
              {suspects.map((s, i) => (
                <div key={i} style={{ fontSize: 12, fontFamily: "monospace", marginBottom: 8, borderTop: "1px solid #fcc", paddingTop: 6 }}>
                  <div>
                    <b>{s.key}</b> = <code>{JSON.stringify(s.value)}</code> (type: {s.valueType})
                  </div>
                  <div style={{ opacity: 0.7 }}>
                    laag: {s.layer ?? "-"} · source-layer: {s.sourceLayer ?? "-"}
                  </div>
                  <pre style={{ fontSize: 10, background: "#fff", padding: 6, borderRadius: 4, overflowX: "auto", marginTop: 4 }}>{JSON.stringify(s.allProperties, null, 2)}</pre>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 16, padding: 12, background: "#f5f5f0", borderRadius: 8 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>A/B: labels + to-string()-patch</div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <button onClick={toggleLabels} style={{ flex: 1, padding: 10, fontSize: 13, background: labelsEnabled ? "#085041" : "#a83232", color: "white", border: "none", borderRadius: 8 }}>
                Labels: {labelsEnabled ? "AAN" : "UIT"}
              </button>
              <button onClick={toggleToStringPatch} style={{ flex: 1, padding: 10, fontSize: 13, background: toStringPatchActive ? "#1a73e8" : "#888", color: "white", border: "none", borderRadius: 8 }}>
                to-string(): {toStringPatchActive ? "AAN" : "UIT"}
              </button>
            </div>
            <button onClick={runMovementSimulation} disabled={simRunning} style={{ width: "100%", padding: 10, fontSize: 13, background: "#1a73e8", color: "white", border: "none", borderRadius: 8, marginBottom: 10 }}>
              {simRunning ? "Bezig..." : "Simuleer beweging (60 stappen)"}
            </button>
            <div style={{ fontSize: 13 }}>
              Fouten -- huidige configuratie ({labelsEnabled ? "labels aan" : "labels uit"}, to-string {toStringPatchActive ? "aan" : "uit"}):{" "}
              <b style={{ color: (labelsEnabled ? errorCountA : errorCountB) > 0 ? "#c00" : "green" }}>{labelsEnabled ? errorCountA : errorCountB}</b>
            </div>
            {lastErrorMessage && <div style={{ fontSize: 11, opacity: 0.6, marginTop: 6 }}>Laatste foutmelding: {lastErrorMessage}</div>}
          </div>
        </>
      )}

      {mapStatus === "fout" && <p style={{ color: "red" }}>Kaart kon niet laden.</p>}
    </div>
  );
}
