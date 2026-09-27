"use client";

/**
 * /debug/bike-route-knooppunten (19-9-2026, "functie 2", GO + overleg met Te).
 * Testpagina voor `/api/route/via-knooppunten` -- laat de kortste knooppuntvolgorde
 * zien, MET voor elk tussenstuk of het uit de permanente cache kwam of vers bij ORS
 * opgehaald is (relevant om te zien hoe snel de cache in de praktijk gaat vullen).
 *
 * Zelfde Leaflet+CARTO-opzet als /debug/bike-route (functie 1) -- zie dat bestand
 * voor de volledige toelichting. Bewust een APARTE pagina, nog niet in de hoofd-app
 * gekoppeld.
 */

import { useRef, useState } from "react";
import type * as L from "leaflet";
import "leaflet/dist/leaflet.css";

type LatLon = { lat: number; lon: number };
type Step = { name: string; instruction: string; distanceM: number };
type ViaKnooppuntenResult = {
  origin: LatLon & { displayName: string };
  destination: LatLon & { displayName: string };
  nodeIds: string[];
  displayNumbers: string[];
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  steps: Step[];
  segmentSources: ("cache" | "ors")[];
  usedDirectFallback: boolean;
  detourRatio: number;
};

type TooManyError = {
  error: string;
  reason: "too_many_knooppunten";
  knooppuntenCount: number;
  limit: number;
  nodeIds: string[];
  displayNumbers: string[];
  positions: LatLon[];
};

const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;
const CARTO_RASTER_URL = CARTO_API_KEY
  ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_API_KEY}`
  : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
const CARTO_ATTRIBUTION = "&copy; CARTO, &copy; OpenStreetMap contributors";
const CARTO_SUBDOMAINS = ["a", "b", "c", "d"];
const ROUTE_COLOR = "#085041";

export default function BikeRouteKnooppuntenDebugPage() {
  const [originInput, setOriginInput] = useState("");
  const [destinationInput, setDestinationInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ViaKnooppuntenResult | null>(null);
  const [tooManySequence, setTooManySequence] = useState<TooManyError | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  async function ensureMap() {
    if (mapRef.current || !containerRef.current) return mapRef.current;
    const L = await import("leaflet");
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
    L.tileLayer(CARTO_RASTER_URL, { attribution: CARTO_ATTRIBUTION, subdomains: CARTO_SUBDOMAINS, maxZoom: 20 }).addTo(map);
    map.setView([52.1, 5.1], 8);
    mapRef.current = map;
    return map;
  }

  async function handleSubmit() {
    if (!originInput.trim() || !destinationInput.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setTooManySequence(null);

    try {
      const res = await fetch("/api/route/via-knooppunten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originPlaceName: originInput, destinationPlaceName: destinationInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data.reason === "too_many_knooppunten") {
          const tooMany = data as TooManyError;
          setTooManySequence(tooMany);

          const map = await ensureMap();
          if (map) {
            const L = await import("leaflet");
            for (const layer of layersRef.current) layer.remove();
            const newLayers: L.Layer[] = [];

            const latLngs: L.LatLngTuple[] = tooMany.positions.map((p) => [p.lat, p.lon]);
            // Rechte lijnen tussen opeenvolgende knooppunten (GEEN echte fietspad-geometrie --
            // die is hier bewust niet opgehaald, dat kost immers ORS-aanroepen). Puur om
            // richting/volgorde in één oogopslag te zien, niet om het exacte fietspad te tonen.
            const line = L.polyline(latLngs, { color: "#b00020", weight: 3, dashArray: "6 6" }).addTo(map);
            newLayers.push(line);
            latLngs.forEach((pos, i) => {
              const marker = L.marker(pos, {
                icon: L.divIcon({
                  className: "",
                  html: `<div style="background:#b00020;color:#fff;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.4);">${i + 1}</div>`,
                  iconSize: [26, 26],
                  iconAnchor: [13, 13],
                }),
              }).addTo(map);
              newLayers.push(marker);
            });
            layersRef.current = newLayers;
            map.fitBounds(line.getBounds(), { padding: [32, 32] });
          }
        }
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data as ViaKnooppuntenResult);

      const map = await ensureMap();
      if (!map) return;
      const L = await import("leaflet");

      for (const layer of layersRef.current) layer.remove();
      layersRef.current = [];

      const latLngs: L.LatLngTuple[] = (data.geometry as LatLon[]).map((p) => [p.lat, p.lon]);
      const line = L.polyline(latLngs, { color: ROUTE_COLOR, weight: 5, lineJoin: "round", lineCap: "round" }).addTo(map);
      const newLayers: L.Layer[] = [line];

      const startMarker = L.circleMarker(latLngs[0], { radius: 8, color: "#FFFFFF", weight: 2, fillColor: "#1a7a3c", fillOpacity: 1 }).addTo(map);
      const endMarker = L.circleMarker(latLngs[latLngs.length - 1], { radius: 8, color: "#FFFFFF", weight: 2, fillColor: "#b00020", fillOpacity: 1 }).addTo(map);
      newLayers.push(startMarker, endMarker);
      layersRef.current = newLayers;

      map.fitBounds(line.getBounds(), { padding: [32, 32] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Route via knooppunten (functie 2, testpagina)</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 16 }}>
        Kortste knooppuntvolgorde (pure Dijkstra) + per tussenstap de echte-fietspad-motor (functie 1).
        Puur diagnostisch, nog niet gekoppeld aan de hoofd-app.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
        <input
          value={originInput}
          onChange={(e) => setOriginInput(e.target.value)}
          placeholder="Vertrekpunt (bv. Volendam)"
          style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #ccc", fontSize: 15 }}
        />
        <input
          value={destinationInput}
          onChange={(e) => setDestinationInput(e.target.value)}
          placeholder="Bestemming (bv. Hoorn)"
          style={{ padding: "10px 12px", borderRadius: 8, border: "1px solid #ccc", fontSize: 15 }}
        />
        <button
          onClick={handleSubmit}
          disabled={loading}
          style={{
            padding: "10px 16px",
            borderRadius: 8,
            border: "none",
            background: loading ? "#9bbdb2" : "#085041",
            color: "#FFFFFF",
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          {loading ? "Bezig... (kan even duren bij veel nieuwe stukken)" : "Route berekenen"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#fdecea", color: "#b00020", padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14 }}>
          {error}
        </div>
      )}

      {tooManySequence && (
        <div style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>
            Gevonden knooppuntvolgorde ({tooManySequence.knooppuntenCount} knooppunten, geen ORS-aanroepen gedaan)
          </h2>
          <p style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>
            De genummerde rode stippen hieronder op de kaart tonen de volgorde met rechte
            lijnen ertussen (geen echte fietspad-geometrie, puur om richting te zien) — zo is in
            één oogopslag te zien of dit een zinnig-maar-lang pad is of een terugkerende beweging.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {tooManySequence.displayNumbers.map((num, i) => (
              <span
                key={i}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: "#fdecea",
                  border: "1px solid #b00020",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {i + 1}. {num}
              </span>
            ))}
          </div>
        </div>
      )}

      <div ref={containerRef} style={{ width: "100%", height: 360, borderRadius: 12, overflow: "hidden", marginBottom: 16, background: "#eee" }} />

      {result && (
        <div>
          {result.usedDirectFallback && (
            <div style={{ background: "#fff4e0", color: "#8a5a00", padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14 }}>
              ⚠️ De knooppuntengraaf gaf een onredelijke omweg ({result.detourRatio}x de hemelsbrede afstand) — automatisch
              teruggevallen op de directe fietsroute (functie 1) tussen {result.displayNumbers[0]} en{" "}
              {result.displayNumbers[result.displayNumbers.length - 1]}.
            </div>
          )}
          <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 14 }}>
            <div>
              <strong>{(result.distanceM / 1000).toFixed(1)} km</strong>
            </div>
            <div>
              <strong>{Math.round(result.durationS / 60)} min</strong>
            </div>
            <div>
              <strong>{result.nodeIds.length} knooppunten</strong>
            </div>
          </div>
          <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>
            {result.origin.displayName} → {result.destination.displayName}
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Knooppuntvolgorde</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
            {result.displayNumbers.map((num, i) => (
              <span
                key={i}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  background: "#eef5f2",
                  border: "1px solid #085041",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {num}
                {i < result.segmentSources.length && (
                  <span style={{ marginLeft: 6, fontSize: 11, color: result.segmentSources[i] === "cache" ? "#3a5fcd" : "#b8860b" }}>
                    {result.segmentSources[i] === "cache" ? "cache" : "ors"}
                  </span>
                )}
              </span>
            ))}
          </div>

          <h2 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Straten onderweg ({result.steps.length} stappen)</h2>
          <ol style={{ paddingLeft: 20, fontSize: 14, lineHeight: 1.6 }}>
            {result.steps.map((s, i) => (
              <li key={i}>
                {s.instruction || s.name || "(naamloos pad)"} {s.name && s.instruction ? `— ${s.name}` : ""}{" "}
                <span style={{ color: "#888" }}>({Math.round(s.distanceM)} m)</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
