"use client";

/**
 * Tile-inspector (6-9-2026, uitgebreid met tegelaanbieder-vergelijking).
 *
 * Geïsoleerd van de live app -- eigen, onafhankelijke kaartinstantie.
 *
 * NIEUW (6-9-2026, n.a.v. het weerlegde to-string()-resultaat): een los
 * project bleek exact dezelfde OpenFreeMap+MapLibre-faalmodus te hebben en
 * loste het op door van tegelaanbieder te wisselen (niet van bibliotheek).
 * CARTO biedt een MapLibre-compatibele VECTOR-stijl (dus rotatie/volledige
 * stijlcontrole blijven behouden, in tegenstelling tot Leaflet+raster).
 * Deze pagina laat nu kiezen tussen OpenFreeMap en CARTO, met exact dezelfde
 * A/B/simulatie-test, om te zien of de crash tegelaanbieder-specifiek is.
 *
 * Wisselen van stijl gebeurt via een volledige remount (React `key`-prop) --
 * bewust GEEN map.setStyle() hier, want dat gaf eerder een race condition
 * (simulatie kon starten vóórdat de nieuwe stijl echt geladen was). Een
 * remount garandeert een schone, nieuwe kaartinstantie per stijl.
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

const STYLE_SOURCES = {
  openfreemap: { label: "OpenFreeMap (Liberty)", url: "https://tiles.openfreemap.org/styles/liberty" },
  carto: { label: "CARTO (Voyager)", url: "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json" },
} as const;
type StyleSourceKey = keyof typeof STYLE_SOURCES;

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

function MapInspector({ styleUrl, initialLat, initialLon }: { styleUrl: string; initialLat: number; initialLon: number }) {
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
  const [lat, setLat] = useState(String(initialLat));
  const [lon, setLon] = useState(String(initialLon));
  const labelsEnabledRef = useRef(true);

  useEffect(() => {
    labelsEnabledRef.current = labelsEnabled;
  }, [labelsEnabled]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    ensureWorkerUrlConfigured();

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleUrl,
      center: [initialLon, initialLat],
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
            found.push({ key, value, valueType: typeof value, layer: feature.layer?.id, sourceLayer: feature.sourceLayer, allProperties: props });
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
      if (layer.type === "symbol") map.setLayoutProperty(layer.id, "visibility", newEnabled ? "visible" : "none");
    }
  }

  function toggleToStringPatch() {
    const map = mapRef.current;
    if (!map || !originalStyleRef.current) return;
    const newActive = !toStringPatchActive;
    setToStringPatchActive(newActive);
    map.setStyle(newActive ? patchStyleWithToString(originalStyleRef.current) : originalStyleRef.current);
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
    <>
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
    </>
  );
}

export default function TileInspectorPage() {
  const [styleSource, setStyleSource] = useState<StyleSourceKey>("openfreemap");

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Tile-inspector</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>Geïsoleerd van de live app -- eigen kaartinstantie.</p>

      <div style={{ marginBottom: 16, padding: 12, background: "#eef", borderRadius: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Tegelaanbieder (volledige remount bij wisselen)</div>
        <div style={{ display: "flex", gap: 8 }}>
          {(Object.keys(STYLE_SOURCES) as StyleSourceKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setStyleSource(key)}
              style={{
                flex: 1,
                padding: 10,
                fontSize: 13,
                background: styleSource === key ? "#1a73e8" : "#ccc",
                color: styleSource === key ? "white" : "#333",
                border: "none",
                borderRadius: 8,
              }}
            >
              {STYLE_SOURCES[key].label}
            </button>
          ))}
        </div>
      </div>

      <MapInspector key={styleSource} styleUrl={STYLE_SOURCES[styleSource].url} initialLat={PRESETS.lochem.lat} initialLon={PRESETS.lochem.lon} />
    </div>
  );
}
