"use client";

/**
 * LiveLocationScreen (GOKNOOP-MASTER.md, live-locatiekaart, 29-8-2026).
 *
 * Toont een live kaart met de actuele GPS-positie + rijrichting, als
 * bevestigingsstap ná "Mijn locatie" en VÓÓR de bestaande afstandskeuze --
 * bewust GEEN route, GEEN matching, GEEN NavigationSession (die horen bij een
 * gekozen route, die is hier nog niet gekozen). Puur "waar ben ik nu".
 *
 * MIGRATIE 6-9-2026 (Fase 1+2, migratieplan MapLibre -> Leaflet): dit scherm
 * gebruikte MapLibre GL JS + OpenFreeMap/Liberty. Na een uitgebreid, hard
 * onderzoek (regio-audit, to-string()-stijlpatch, tegelaanbieder-vergelijking
 * OpenFreeMap vs CARTO) bleek een reproduceerbare Safari-crash
 * ("i.codePointAt is not a function") in MapLibre's client-side
 * labelweergave zelf te zitten -- onafhankelijk van brondata, stijl-instelling
 * of tegelaanbieder. Dit scherm gebruikt daarom nu Leaflet + CARTO-rastertegels
 * (kant-en-klare afbeeldingen, GEEN client-side vector-labelweergave -- deze
 * hele bugklasse is daarmee principieel uitgesloten).
 *
 * BEWUST ANDERS DAN VOORHEEN: de kaart draait niet meer mee met de rijrichting
 * (blijft altijd noord-boven). Leaflet heeft geen ingebouwde rotatie; de enige
 * beschikbare plugin (leaflet-rotate) overschrijft een groot deel van
 * Leaflet's kern en heeft bekende compatibiliteitsproblemen -- een bewuste,
 * expliciet afgestemde keuze (zie leaflet-migration-plan.md), geen vergeten
 * functionaliteit. Het bestaande kompaslabel ("Richting", NW/315°) blijft
 * ongewijzigd werken -- dat gebruikte toch al de rauwe headingDeg, niet de
 * (voorheen kaart-rotatie-specifieke) smoothedHeadingRef.
 *
 * NIET GEWIJZIGD: GPS-logica (BrowserGeolocationSource, sample-frequentie,
 * headingDeg/accuracyM-afhandeling), layout, teksten, knoppen, state,
 * route-engine, navigatie-elders -- uitsluitend de kaart-renderinglaag is
 * vervangen.
 */

import { useEffect, useRef, useState } from "react";
import type * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { BrowserGeolocationSource } from "@/lib/navigation/gps-sources/browser-geolocation-source";
import { selectHeadingDeg, smoothHeadingDeg } from "@/lib/navigation/direction/relative-direction";
import { compassAbbreviation } from "@/lib/navigation/direction/relative-direction";

// BELANGRIJK (6-9-2026, n.a.v. Vercel-buildfout "window is not defined"): Leaflet
// raakt browser-globals aan op het MOMENT VAN IMPORTEREN, niet pas bij gebruik --
// een gewone `import * as L from "leaflet"` bovenaan het bestand crasht daarom
// tijdens Next.js' server-side prerendering (waar geen `window` bestaat), ondanks
// "use client" (dat voorkomt geen server-side evaluatie, alleen client-hydratatie).
// Oplossing: hierboven alleen een TYPE-only import (verdwijnt volledig bij compilatie,
// dus geen runtime-risico), de daadwerkelijke module wordt hieronder pas dynamisch
// geladen binnen useEffect (dus gegarandeerd alleen in de browser).
type LeafletModule = typeof L;

// Leaflet's standaard marker-icoon-assets verwachten een relatief pad dat in een
// Next.js-webpack-bundel niet automatisch klopt. Dit scherm gebruikt zelf geen
// L.marker/divIcon (alleen L.circleMarker voor de positie-halo/-stip, die geen
// icoon-assets nodig heeft), maar deze config hoort bij "Leaflet basis" (Fase 1)
// en wordt hier eenmalig gezet zodat een toekomstig scherm dat wél L.marker
// gebruikt hier niet opnieuw over hoeft na te denken. Verwijst naar de exacte,
// bij package.json vastgepinde Leaflet-versie op de officiële unpkg-CDN --
// geen extra pakket, geen gok: dit is het door Leaflet zelf gedocumenteerde
// patroon voor bundlers die de standaard relatieve icoon-paths niet oplossen.
let leafletIconsConfigured = false;
function ensureLeafletIconsConfigured(L: LeafletModule) {
  if (leafletIconsConfigured) return;
  delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  });
  leafletIconsConfigured = true;
}

// CARTO vereist sinds eind augustus 2026 een (gratis) API-key voor hun
// rastertegels (voorheen niet nodig, zie leaflet-migration-plan.md-kanttekening
// die dit al benoemde als mogelijk toekomstig risico). Key wordt via een
// publieke env var aangeleverd (NEXT_PUBLIC_-prefix, want deze URL wordt
// client-side gebruikt) -- geen gevoelige secret, CARTO's eigen documentatie
// toont deze key ook gewoon rechtstreeks in client-side voorbeeldcode.
// Zonder ingestelde key valt dit terug op de kale URL (toont dan het
// "API KEY REQUIRED"-watermerk van CARTO, geen crash -- degradeert netjes).
const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;
const CARTO_RASTER_URL = CARTO_API_KEY
  ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_API_KEY}`
  : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
const CARTO_ATTRIBUTION = "&copy; CARTO, &copy; OpenStreetMap contributors";
const CARTO_SUBDOMAINS = ["a", "b", "c", "d"];
const CARTO_MAX_ZOOM = 20;

const POSITION_COLOR = "#3B82F6"; // zelfde blauw als de live-positiemarker op het navigatiescherm
// Heading-up op het Home-scherm (op verzoek, 29-8-2026) -- ALLEEN rotatie, GEEN automatisch
// inzoomen (dat hoort bij actieve navigatie, sectie 6H, niet bij dit rustige overzicht --
// bewust bevestigd met de gebruiker vóór het bouwen). NA DE LEAFLET-MIGRATIE: de rotatie zelf
// is losgelaten (zie toelichting bovenaan), maar de heading-berekening zelf blijft ongewijzigd
// draaien -- dit blijft "alleen de kaart-renderer vervangen", geen wijziging aan navigatielogica.
const HEADING_SMOOTHING_ALPHA = 0.35;
const MOVEMENT_SPEED_THRESHOLD_MPS = 0.5;
// Duration in SECONDEN voor Leaflet (was 900ms voor MapLibre se easeTo -- Leaflet's panTo/flyTo
// duration-optie is in seconden, geen 1-op-1 hernoeming, wel exact dezelfde bedoelde duur).
const PAN_DURATION_S = 0.9;

export type LiveLocationScreenProps = {
  /** Aangeroepen zodra de gebruiker deze locatie bevestigt om door te gaan naar afstandskeuze. */
  onConfirm: (lat: number, lon: number) => void;
  /** Weglaten als er niets is om naar terug te gaan (bijv. als Kaart-hometab) -- dan verschijnt er geen ✕-knop. */
  onCancel?: () => void;
  /**
   * true wanneer dit scherm permanent onder de tabbalk zit (de Kaart-hometab) i.p.v. als
   * volledig-scherm modale stap. Bepaalt alleen positionering/ruimte voor de tabbalk, geen
   * gedragsverschil.
   */
  embedded?: boolean;
};

function accuracyLabel(accuracyM: number): string {
  if (accuracyM <= 15) return "GPS nauwkeurig";
  if (accuracyM <= 50) return "GPS redelijk nauwkeurig";
  return "GPS onnauwkeurig";
}

/** Eenvoudige Leaflet-tegelfout-logging naar dezelfde bestaande debug-endpoint (ongewijzigd). */
function logTileError(context: Record<string, unknown>) {
  try {
    fetch("/api/debug/log-client-error", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Leaflet tileerror", stack: null, context }),
    }).catch(() => {
      // Bewust genegeerd -- logging mag de app nooit breken.
    });
  } catch {
    // Idem.
  }
}

export default function LiveLocationScreen({ onConfirm, onCancel, embedded = false }: LiveLocationScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const positionHaloRef = useRef<L.CircleMarker | null>(null);
  const positionDotRef = useRef<L.CircleMarker | null>(null);
  const networkNodesDataRef = useRef<[number, number, string, number][]>([]);
  const networkLabelsLayerRef = useRef<L.LayerGroup | null>(null);
  const sourceRef = useRef<BrowserGeolocationSource | null>(null);
  const hasCenteredRef = useRef(false);
  const smoothedHeadingRef = useRef<number | null>(null);

  const [mapStatus, setMapStatus] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<{ lat: number; lon: number; accuracyM: number; headingDeg: number | null } | null>(null);

  // Kaart eenmalig opzetten.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let cancelled = false;

    (async () => {
      // Dynamische import (zie toelichting bovenaan bij LeafletModule) -- garandeert dat
      // Leaflet's module-code nooit tijdens server-side prerendering wordt geëvalueerd.
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;
      ensureLeafletIconsConfigured(L);

      const map = L.map(containerRef.current, {
        center: [52.0907, 5.1214], // uitgangspunt, wordt direct overschreven zodra de eerste GPS-fix binnenkomt
        zoom: 15,
        zoomControl: false, // hieronder handmatig top-right toegevoegd, zelfde plek als voorheen
        attributionControl: true,
      });

      L.control.zoom({ position: "topright" }).addTo(map);

      const tileLayer = L.tileLayer(CARTO_RASTER_URL, {
        attribution: CARTO_ATTRIBUTION,
        subdomains: CARTO_SUBDOMAINS,
        maxZoom: CARTO_MAX_ZOOM,
      });

      tileLayer.on("tileerror", (e) => {
        const message = "Leaflet tileerror (CARTO)";
        logTileError({
          screen: "LiveLocationScreen",
          tileUrl: CARTO_RASTER_URL,
          errorTile: (e as unknown as { coords?: { x: number; y: number; z: number } }).coords ?? null,
          centerLat: map.getCenter().lat,
          centerLon: map.getCenter().lng,
          zoom: map.getZoom(),
          timestamp: new Date().toISOString(),
        });
        setMapStatus("error");
        setError(message);
      });

      tileLayer.addTo(map);

      // Contrastfilter (op verzoek, 7-9-2026): Voyager op zichzelf voelde "vaag"/moeilijk
      // te zien aan, Dark Matter bleek juist te donker/te weinig contrast (straatnamen
      // nauwelijks leesbaar). Dit verzadigt/verscherpt de bestaande Voyager-tegels zelf --
      // geen andere tegelaanbieder/-stijl nodig, puur een CSS-filter op de tegel-laag.
      const tilePane = map.getPane("tilePane");
      if (tilePane) {
        tilePane.style.filter = "saturate(1.6) contrast(1.2) brightness(1.03)";
      }

      // Attributie onderaan gecentreerd i.p.v. rechtsonder (op verzoek, 30-8-2026, zelfde
      // aanpak als voorheen bij MapLibre -- alleen de CSS-klasse hoort nu bij Leaflet).
      const attribContainer = map.getContainer().querySelector<HTMLElement>(".leaflet-control-attribution");
      if (attribContainer) {
        attribContainer.style.position = "absolute";
        attribContainer.style.left = "50%";
        attribContainer.style.right = "auto";
        attribContainer.style.transform = "translateX(-50%)";
      }

      // Buitenste, subtiele "nauwkeurigheids"-gloed + de blauwe stip zelf -- zelfde taal als
      // voorheen (MapLibre circle-lagen), nu als twee Leaflet circleMarkers die bij elke
      // GPS-sample van positie verplaatst worden i.p.v. opnieuw aangemaakt.
      positionHaloRef.current = L.circleMarker([52.0907, 5.1214], {
        radius: 22,
        color: POSITION_COLOR,
        weight: 0,
        fillColor: POSITION_COLOR,
        fillOpacity: 0.15,
      }).addTo(map);
      positionDotRef.current = L.circleMarker([52.0907, 5.1214], {
        radius: 8,
        color: "#FFFFFF",
        weight: 3,
        fillColor: POSITION_COLOR,
        fillOpacity: 1,
      }).addTo(map);
      // Nog geen echte positie bekend -- pas zichtbaar zodra de eerste GPS-sample binnenkomt.
      positionHaloRef.current.setStyle({ opacity: 0, fillOpacity: 0 });
      positionDotRef.current.setStyle({ opacity: 0, fillOpacity: 0 });

      setMapStatus("loaded");
      mapRef.current = map;

      // Eigen knooppuntennetwerk tonen (op verzoek, 7-9-2026) -- GoKnoop's eigen
      // data, niet afhankelijk van de kaartprovider daarvoor. Canvas-renderer:
      // bij ~11.000 knooppunten + ~28.000 verbindingen is de standaard SVG-
      // renderer (één DOM-element per vorm) merkbaar trager op een telefoon.
      const canvasRenderer = L.canvas({ padding: 0.5 });
      const LABEL_MIN_ZOOM = 14; // pas nummer-labels tonen als er zinnig weinig knooppunten tegelijk zichtbaar zijn
      networkLabelsLayerRef.current = L.layerGroup().addTo(map);

      function refreshVisibleLabels() {
        const currentMap = mapRef.current;
        const labelsLayer = networkLabelsLayerRef.current;
        if (!currentMap || !labelsLayer) return;
        labelsLayer.clearLayers();
        if (currentMap.getZoom() < LABEL_MIN_ZOOM) return;

        // Zelfde visuele stijl als KnoopBadge.tsx (components/KnoopBadge.tsx) --
        // hergebruikt i.p.v. opnieuw verzonnen, zodat een knooppunt op de kaart
        // er identiek uitziet als een knooppunt-badge elders in de app. Leaflet
        // divIcon kan geen React-component direct hergebruiken, dus dezelfde
        // CSS-variabelen (--color-knoop-green e.d., globals.css) hier herhaald.
        const BADGE_SIZE = 26;
        const bounds = currentMap.getBounds();
        for (const [lat, lon, displayNumber] of networkNodesDataRef.current) {
          if (!bounds.contains([lat, lon])) continue;
          L.marker([lat, lon], {
            icon: L.divIcon({
              className: "goknoop-network-node-badge",
              html: `<div style="
                width:${BADGE_SIZE}px;height:${BADGE_SIZE}px;border-radius:var(--radius-badge, 999px);
                display:flex;align-items:center;justify-content:center;
                background:var(--color-knoop-green, #1f6b44);border:2px solid var(--color-white, #fff);
                box-shadow:0 1px 3px rgba(0,0,0,0.3);
                color:var(--color-white, #fff);font-family:var(--font-display), -apple-system, sans-serif;
                font-weight:700;font-size:11px;line-height:1;
              ">${displayNumber}</div>`,
              iconSize: [BADGE_SIZE, BADGE_SIZE],
              iconAnchor: [BADGE_SIZE / 2, BADGE_SIZE / 2],
            }),
            interactive: false,
          }).addTo(labelsLayer);
        }
      }

      map.on("moveend zoomend", refreshVisibleLabels);

      fetch("/api/network/overview")
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.json();
        })
        .then((data: { nodes?: [number, number, string, number][]; edges?: [number, number, number, number][]; error?: string }) => {
          if (cancelled || !mapRef.current) return;
          if (data.error) throw new Error(data.error);
          const nodes = data.nodes ?? [];
          const edges = data.edges ?? [];
          networkNodesDataRef.current = nodes;

          for (const [fromLat, fromLon, toLat, toLon] of edges) {
            L.polyline(
              [
                [fromLat, fromLon],
                [toLat, toLon],
              ],
              { renderer: canvasRenderer, color: "#085041", weight: 1.5, opacity: 0.5 }
            ).addTo(mapRef.current);
          }
          for (const [lat, lon] of nodes) {
            L.circleMarker([lat, lon], { renderer: canvasRenderer, radius: 3, color: "#085041", weight: 1, fillColor: "#FFFFFF", fillOpacity: 1 }).addTo(
              mapRef.current
            );
          }
          refreshVisibleLabels();
        })
        .catch((err) => {
          // Netwerk-overzicht is een aanvulling, geen kernfunctie -- een mislukte
          // fetch mag de rest van het scherm (GPS, bevestigen) niet blokkeren.
          // Wel gelogd (stil, geen zichtbare balk meer -- die was een tijdelijk
          // hulpmiddel, inmiddels bevestigd werkend) voor eventuele toekomstige
          // problemen.
          const message = err instanceof Error ? err.message : String(err);
          fetch("/api/debug/log-client-error", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              message: `netwerk-overzicht laden mislukt: ${message}`,
              stack: null,
              context: { screen: "LiveLocationScreen", timestamp: new Date().toISOString() },
            }),
          }).catch(() => {});
        });
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      positionHaloRef.current = null;
      positionDotRef.current = null;
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
        const latlng: L.LatLngExpression = [sample.lat, sample.lon];
        positionHaloRef.current?.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 0.15 });
        positionDotRef.current?.setLatLng(latlng).setStyle({ opacity: 1, fillOpacity: 1 });

        if (!hasCenteredRef.current) {
          map.setView(latlng, 16, { animate: false });
          hasCenteredRef.current = true;
        } else {
          map.panTo(latlng, { animate: true, duration: PAN_DURATION_S });
        }

        // Heading-berekening blijft ongewijzigd draaien (zelfde functies als voorheen) --
        // alleen wordt het resultaat niet langer op de kaart zelf toegepast (geen bearing/
        // rotatie meer in Leaflet, zie toelichting bovenaan). Het bestaande kompaslabel
        // ("Richting") gebruikt de rauwe position.headingDeg hieronder, niet deze waarde.
        const selectedHeading = selectHeadingDeg(
          { gpsHeadingDeg: sample.headingDeg, speedMps: sample.speedMps, previousStableHeadingDeg: smoothedHeadingRef.current },
          { speedThresholdMps: MOVEMENT_SPEED_THRESHOLD_MPS }
        );
        if (selectedHeading !== null) {
          smoothedHeadingRef.current = smoothHeadingDeg(smoothedHeadingRef.current, selectedHeading, HEADING_SMOOTHING_ALPHA);
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
      mapRef.current.flyTo([position.lat, position.lon], 16);
    }
  }

  return (
    <div
      style={{
        position: embedded ? "absolute" : "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: embedded ? "calc(64px + env(safe-area-inset-bottom))" : 0, // tabbalk-hoogte (64px) + de safe-area-marge die de tabbalk zelf ook gebruikt -- zonder die laatste term liep de kaart er deels onder door
        width: "100%",
        // GEEN expliciete height hier: top+bottom bepalen de hoogte volledig. Een expliciete
        // height ernaast (zoals voorheen "100%") overschrijft `bottom` stilzwijgend (CSS
        // negeert bottom als top+height+bottom samen overconstrained zijn) -- dat was de
        // daadwerkelijke oorzaak van de eerdere overlap met de tabbalk.
        zIndex: embedded ? 1 : 50,
        background: "#000",
      }}
    >
      {/* zIndex hier is GEEN willekeurig getal -- het isoleert Leaflet's interne
          stapel-volgorde (tegels/markers/zoomknop lopen intern op tot 1000) in een
          eigen stapelcontext, zodat die nooit meer kan concurreren met de eigen
          knoppen/kaartjes hieronder (die zonder dit zichtbaar overschilderd werden). */}
      <div ref={containerRef} style={{ position: "absolute", inset: 0, zIndex: 0 }} />

      {onCancel && (
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
      )}

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
