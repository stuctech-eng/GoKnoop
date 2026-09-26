"use client";

/**
 * /debug/bike-route (19-9-2026, "eerst normale A->B-navigatie via fietspaden laten
 * werken", GO van Te). Eerste, losse test van de nieuwe `/api/route/direct` -- laat de
 * VOLLEDIGE route zien (kaart + lijst van straten waar de route langskomt), zodat Te dit
 * in één keer met een echt adrespaar kan beoordelen i.p.v. losse geïsoleerde pings.
 *
 * Bewust een APARTE debugpagina, niet in de hoofd-app-flow (`app/page.tsx`) gekoppeld --
 * dat koppelen ("normaal of via knooppunten laten kiezen") is een volgende, aparte stap,
 * pas ná bevestiging dat dit fundament werkt.
 *
 * Zelfde Leaflet+CARTO-opzet als NavigationScreen.tsx/LiveLocationScreen.tsx (zie die
 * bestanden voor de volledige toelichting over de dynamische import/Safari-crash-historie)
 * -- hier bewust een kale, simpele kaart: geen GPS, geen navigatie-state, alleen de
 * berekende route tonen.
 */

import { useRef, useState } from "react";
import type * as L from "leaflet";
import "leaflet/dist/leaflet.css";

type LatLon = { lat: number; lon: number };
type Step = { name: string; instruction: string; distanceM: number };
type DirectRouteResult = {
  origin: LatLon & { displayName: string };
  destination: LatLon & { displayName: string };
  geometry: LatLon[];
  distanceM: number;
  durationS: number;
  steps: Step[];
};

const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;
const CARTO_RASTER_URL = CARTO_API_KEY
  ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_API_KEY}`
  : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
const CARTO_ATTRIBUTION = "&copy; CARTO, &copy; OpenStreetMap contributors";
const CARTO_SUBDOMAINS = ["a", "b", "c", "d"];
const ROUTE_COLOR = "#085041";

export default function BikeRouteDebugPage() {
  const [originInput, setOriginInput] = useState("");
  const [destinationInput, setDestinationInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DirectRouteResult | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  async function ensureMap() {
    if (mapRef.current || !containerRef.current) return mapRef.current;
    const L = await import("leaflet");
    const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
    L.tileLayer(CARTO_RASTER_URL, { attribution: CARTO_ATTRIBUTION, subdomains: CARTO_SUBDOMAINS, maxZoom: 20 }).addTo(map);
    map.setView([52.1, 5.1], 8); // ruw NL-midden, wordt zo meteen overschreven door fitBounds
    mapRef.current = map;
    return map;
  }

  async function handleSubmit() {
    if (!originInput.trim() || !destinationInput.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch("/api/route/direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ originPlaceName: originInput, destinationPlaceName: destinationInput }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setResult(data as DirectRouteResult);

      const map = await ensureMap();
      if (!map) return;
      const L = await import("leaflet");

      for (const layer of layersRef.current) layer.remove();
      layersRef.current = [];

      const latLngs: L.LatLngTuple[] = (data.geometry as LatLon[]).map((p) => [p.lat, p.lon]);
      const line = L.polyline(latLngs, { color: ROUTE_COLOR, weight: 5, lineJoin: "round", lineCap: "round" }).addTo(map);
      const startMarker = L.circleMarker(latLngs[0], { radius: 8, color: "#FFFFFF", weight: 2, fillColor: "#1a7a3c", fillOpacity: 1 }).addTo(map);
      const endMarker = L.circleMarker(latLngs[latLngs.length - 1], { radius: 8, color: "#FFFFFF", weight: 2, fillColor: "#b00020", fillOpacity: 1 }).addTo(map);
      layersRef.current = [line, startMarker, endMarker];

      map.fitBounds(line.getBounds(), { padding: [32, 32] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 4 }}>Directe fietsroute (testpagina)</h1>
      <p style={{ color: "#555", fontSize: 14, marginBottom: 16 }}>
        Volledige route tussen twee adressen, rechtstreeks via echte fietspaden (OpenRouteService) —
        geen knooppuntennetwerk. Puur diagnostisch, nog niet gekoppeld aan de hoofd-app.
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
          {loading ? "Bezig..." : "Route berekenen"}
        </button>
      </div>

      {error && (
        <div style={{ background: "#fdecea", color: "#b00020", padding: 12, borderRadius: 8, marginBottom: 12, fontSize: 14 }}>
          {error}
        </div>
      )}

      <div ref={containerRef} style={{ width: "100%", height: 360, borderRadius: 12, overflow: "hidden", marginBottom: 16, background: "#eee" }} />

      {result && (
        <div>
          <div style={{ display: "flex", gap: 16, marginBottom: 12, fontSize: 14 }}>
            <div>
              <strong>{(result.distanceM / 1000).toFixed(1)} km</strong>
            </div>
            <div>
              <strong>{Math.round(result.durationS / 60)} min</strong>
            </div>
          </div>
          <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>
            {result.origin.displayName} → {result.destination.displayName}
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
