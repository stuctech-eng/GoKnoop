"use client";

/**
 * "Fase B: nieuwe Apple-style route-navigatie" (19-9-2026, GO van Te + aanscherping GPT:
 * geometrisch bepaald, geen ORS-tekstherkenning). Volledig zelfstandig scherm voor routes
 * die als externe geometrie bestaan (functie 1: directe fietsroute, functie 2: route via
 * knooppunten met functie-1-motor) -- GEEN afhankelijkheid van het bestaande
 * GoKnoop-knooppuntenmodel (candidate-matcher, DeviationDetector, NavigationStateMachine).
 * Zie `lib/route-navigation/` voor de volledige, losse en pure navigatielogica.
 *
 * Kaart/CARTO/heading-up-rotatie/GPS-follow-patroon hergebruikt (als TECHNIEK, geen
 * gedeelde module) van `components/navigation/NavigationScreen.tsx` -- dat scherm zelf
 * blijft volledig ongewijzigd en is niet aangeraakt.
 */

import { useEffect, useRef, useState } from "react";
import type * as L from "leaflet";
import "leaflet/dist/leaflet.css";
import { RouteNavigationSession } from "@/lib/route-navigation/route-navigation-session";
import { classifyManeuverDirection } from "@/lib/route-navigation/maneuver-detection";
import type { NavigationRoute } from "@/lib/route-navigation/types";
import type { NavigationUpdate } from "@/lib/route-navigation/route-navigation-session";
import type { RelativeDirection } from "@/lib/navigation/direction/relative-direction";

const CARTO_API_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY;
const CARTO_RASTER_URL = CARTO_API_KEY
  ? `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${CARTO_API_KEY}`
  : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";
const CARTO_ATTRIBUTION = "&copy; CARTO, &copy; OpenStreetMap contributors";
const CARTO_SUBDOMAINS = ["a", "b", "c", "d"];
const ROUTE_COLOR = "#085041";
const NAVIGATION_ZOOM = 17.5;
const EASE_DURATION_MS = 900;

/** Ingeklapte hoogte van de bottom sheet, in pixels. */
const SHEET_COLLAPSED_PX = 118;
/** Aandeel van de schermhoogte dat de bottom sheet uitgeklapt inneemt. */
const SHEET_EXPANDED_RATIO = 0.7;
/** Voorbij dit aandeel van de sleepafstand snapt de sheet naar de andere stand. */
const SHEET_SNAP_RATIO = 0.35;

const DIRECTION_LABEL: Record<RelativeDirection, string> = {
  RECHTDOOR: "Rechtdoor",
  LICHT_LINKS: "Licht links",
  LINKS: "Linksaf",
  LICHT_RECHTS: "Licht rechts",
  RECHTS: "Rechtsaf",
  ACHTERUIT: "Keer om",
};

export type RouteNavigationScreenProps = {
  route: NavigationRoute;
  /** Bijv. "Volendam → Hoorn" -- puur weergave. */
  routeLabel?: string;
  onExit: () => void;
};

export default function RouteNavigationScreen({ route, routeLabel, onExit }: RouteNavigationScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRotateWrapperRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const positionMarkerRef = useRef<L.CircleMarker | null>(null);
  const sessionRef = useRef<RouteNavigationSession | null>(null);
  const isFollowingRef = useRef(true);
  const watchIdRef = useRef<number | null>(null);

  const [isFollowing, setIsFollowing] = useState(true);
  const [update, setUpdate] = useState<NavigationUpdate | null>(null);
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  /**
   * BUGFIX (live test: zwarte hoeken zichtbaar in de kaart tijdens rotatie): een vaste
   * 150%-marge is bij een smal telefoonscherm ONVOLDOENDE -- de diagonaal (nodig om bij een
   * willekeurige rotatiehoek alle hoeken te blijven bedekken) is voor een smal, hoog scherm
   * veel groter dan 150% van de BREEDTE. Nu op basis van de werkelijke schermdiagonaal
   * berekend (vierkante wrapper, zijde = diagonaal + marge), gegarandeerd voldoende bij elke
   * rotatiehoek, ongeacht schermverhouding.
   */
  const [mapWrapperSizePx, setMapWrapperSizePx] = useState(0);

  // Sleepbare bottom sheet (live test: was een tik, moet een sleepgebaar zijn).
  const [sheetHeightPx, setSheetHeightPx] = useState(SHEET_COLLAPSED_PX);
  const expandedHeightPxRef = useRef(SHEET_COLLAPSED_PX);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [isDraggingSheet, setIsDraggingSheet] = useState(false);

  // Schermafmetingen meten -- voor zowel de kaartwrapper-diagonaal als de sheet-hoogte.
  useEffect(() => {
    function measure() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      // +40px marge bovenop de exacte diagonaal, puur als veiligheidsmarge (afronding/subpixels).
      setMapWrapperSizePx(Math.ceil(Math.sqrt(w * w + h * h)) + 40);
      expandedHeightPxRef.current = Math.round(h * SHEET_EXPANDED_RATIO);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  // Kaart + routepolyline eenmalig opzetten. Afhankelijk van `mapWrapperSizePx` (i.p.v. een
  // vaste lege dependency-array) omdat `containerRef`'s div nu pas rendert zodra de
  // schermdiagonaal gemeten is (zie het effect hierboven) -- zonder deze afhankelijkheid zou
  // `containerRef.current` bij de allereerste render nog null zijn en de kaart nooit mounten.
  // De `mapRef.current`-guard voorkomt dubbel mounten als dit effect door een latere resize
  // nogmaals zou vuren.
  useEffect(() => {
    if (mapWrapperSizePx === 0 || !containerRef.current || mapRef.current) return;
    let cancelled = false;

    (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true });
      L.tileLayer(CARTO_RASTER_URL, { attribution: CARTO_ATTRIBUTION, subdomains: CARTO_SUBDOMAINS, maxZoom: 20 }).addTo(map);

      const latLngs: L.LatLngTuple[] = route.geometry.map((p) => [p.lat, p.lon]);
      const line = L.polyline(latLngs, { color: ROUTE_COLOR, weight: 5, lineJoin: "round", lineCap: "round" }).addTo(map);
      map.fitBounds(line.getBounds(), { padding: [40, 40] });

      const marker = L.circleMarker(latLngs[0], {
        radius: 9,
        color: "#FFFFFF",
        weight: 3,
        fillColor: "#1a73e8",
        fillOpacity: 1,
      }).addTo(map);
      positionMarkerRef.current = marker;

      map.on("dragstart", () => {
        isFollowingRef.current = false;
        setIsFollowing(false);
      });

      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      positionMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapWrapperSizePx]);

  // GPS-sessie starten.
  useEffect(() => {
    sessionRef.current = new RouteNavigationSession(route);

    if (!navigator.geolocation) {
      setGpsError("Dit toestel ondersteunt geen locatiebepaling.");
      return;
    }

    const watchId = navigator.geolocation.watchPosition(
      (position) => {
        const sample = {
          position: { lat: position.coords.latitude, lon: position.coords.longitude },
          headingDeg: position.coords.heading,
          speedMps: position.coords.speed,
        };
        const result = sessionRef.current?.process(sample);
        if (!result) return;
        setUpdate(result);
        setGpsError(null);

        const map = mapRef.current;
        const marker = positionMarkerRef.current;
        if (map && marker) {
          const matched: L.LatLngTuple = [result.progress.matchedPoint.lat, result.progress.matchedPoint.lon];
          marker.setLatLng(matched);

          if (isFollowingRef.current) {
            map.flyTo(matched, NAVIGATION_ZOOM, { animate: true, duration: EASE_DURATION_MS / 1000 });
          }
          if (mapRotateWrapperRef.current && result.smoothedHeadingDeg !== null) {
            mapRotateWrapperRef.current.style.transform = `rotate(${-result.smoothedHeadingDeg}deg)`;
          }
        }
      },
      (error) => {
        setGpsError(
          error.code === error.PERMISSION_DENIED
            ? "Geen toestemming voor locatie. Zet locatietoegang aan in je instellingen."
            : "Kon je locatie niet bepalen."
        );
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
    watchIdRef.current = watchId;

    return () => {
      if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleRecenter() {
    isFollowingRef.current = true;
    setIsFollowing(true);
    const map = mapRef.current;
    if (map && update) {
      map.flyTo([update.progress.matchedPoint.lat, update.progress.matchedPoint.lon], NAVIGATION_ZOOM, {
        animate: true,
        duration: EASE_DURATION_MS / 1000,
      });
    }
  }

  const maneuverLabel = update?.maneuver ? DIRECTION_LABEL[classifyManeuverDirection(update.maneuver.turnAngleDeg)] : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#000" }}>
      {/* Kaartlaag: geclipte, overgrote rotatiewrapper -- zelfde techniek als de bestaande
          Apple-stijl-kaart (NavigationScreen.tsx), hier als losse, eigen implementatie. */}
      <div style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 0 }}>
        {mapWrapperSizePx > 0 && (
          <div
            ref={mapRotateWrapperRef}
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              width: mapWrapperSizePx,
              height: mapWrapperSizePx,
              marginLeft: -mapWrapperSizePx / 2,
              marginTop: -mapWrapperSizePx / 2,
              transformOrigin: "center center",
              transition: `transform ${EASE_DURATION_MS}ms ease`,
            }}
          >
            <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
          </div>
        )}
      </div>

      {/* Sluitknop */}
      <button
        onClick={onExit}
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          left: 12,
          zIndex: 5,
          width: 44,
          height: 44,
          borderRadius: 22,
          border: "none",
          background: "rgba(40,40,40,0.85)",
          color: "#FFFFFF",
          fontSize: 20,
        }}
      >
        ✕
      </button>

      {gpsError && (
        <div
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top, 0px) + 12px)",
            left: 68,
            right: 12,
            zIndex: 5,
            background: "#b00020",
            color: "#FFFFFF",
            padding: "10px 14px",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          {gpsError}
        </div>
      )}

      {!isFollowing && (
        <button
          onClick={handleRecenter}
          style={{
            position: "absolute",
            bottom: sheetHeightPx + 20,
            right: 12,
            zIndex: 5,
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "10px 16px",
            borderRadius: 999,
            border: "none",
            background: "#085041",
            color: "#FFFFFF",
            fontSize: 14,
            fontWeight: 700,
            boxShadow: "0 2px 8px rgba(0,0,0,0.35)",
          }}
        >
          <span style={{ fontSize: 16 }}>📍</span> Volg mij
        </button>
      )}

      {/* Bottom sheet */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 4,
          background: "#FFFFFF",
          borderTopLeftRadius: 20,
          borderTopRightRadius: 20,
          boxShadow: "0 -4px 20px rgba(0,0,0,0.25)",
          height: sheetHeightPx,
          overflowY: sheetHeightPx > SHEET_COLLAPSED_PX + 20 ? "auto" : "hidden",
          transition: isDraggingSheet ? "none" : "height 0.25s ease",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          touchAction: "none",
        }}
      >
        {/* BUGFIX (live test: "nu is de onderste knop een tik, maar moet vegen"): echt
            sleepgebaar via Pointer Events (werkt voor zowel touch als muis) i.p.v. een
            simpele klik-knop. De handgreep zelf én de titelbalk zijn beide sleepbaar. */}
        <div
          onPointerDown={(e) => {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            dragStateRef.current = { startY: e.clientY, startHeight: sheetHeightPx };
            setIsDraggingSheet(true);
          }}
          onPointerMove={(e) => {
            if (!dragStateRef.current) return;
            const delta = dragStateRef.current.startY - e.clientY; // omhoog slepen = positief = groter
            const next = Math.min(
              expandedHeightPxRef.current,
              Math.max(SHEET_COLLAPSED_PX, dragStateRef.current.startHeight + delta)
            );
            setSheetHeightPx(next);
          }}
          onPointerUp={() => {
            if (!dragStateRef.current) return;
            const range = expandedHeightPxRef.current - SHEET_COLLAPSED_PX;
            const progress = range > 0 ? (sheetHeightPx - SHEET_COLLAPSED_PX) / range : 0;
            const snapExpanded = progress > SHEET_SNAP_RATIO;
            setSheetHeightPx(snapExpanded ? expandedHeightPxRef.current : SHEET_COLLAPSED_PX);
            setSheetExpanded(snapExpanded);
            dragStateRef.current = null;
            setIsDraggingSheet(false);
          }}
          style={{ width: "100%", padding: "10px 0 4px", cursor: "grab" }}
          aria-label={sheetExpanded ? "Sleep omlaag om in te klappen" : "Sleep omhoog om uit te klappen"}
        >
          <div style={{ width: 40, height: 5, borderRadius: 3, background: "#d0d0d0", margin: "0 auto" }} />
        </div>

        {/* BUGFIX (live test: "als je verkeerd rijdt reageert hij niet"): de afwijkings-
            indicatie was voorheen alleen zichtbaar in uitgeklapte toestand -- tijdens gewoon
            fietsen (ingeklapt, de standaardstand) was er dus GEEN enkele zichtbare reactie
            op een afwijking. Nu ook in de ingeklapte balk zelf, als kleurverandering +
            tekst, altijd zichtbaar ongeacht de sheet-stand. */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "4px 20px 18px",
            background: update?.offRoute.isOffRoute ? "#fff4e0" : "transparent",
            transition: "background 0.2s ease",
          }}
        >
          {update?.offRoute.isOffRoute ? (
            <>
              <div style={{ fontSize: 28, flexShrink: 0 }}>⚠️</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: "#8a5a00" }}>Je lijkt van de route af te zijn</div>
                <div style={{ fontSize: 13, color: "#8a5a00" }}>Controleer je positie op de kaart</div>
              </div>
            </>
          ) : update?.maneuver ? (
            <>
              <div
                style={{
                  flexShrink: 0,
                  transform: `rotate(${update.maneuverArrowDeg}deg)`,
                  transition: "transform 0.3s ease",
                }}
              >
                <svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M12 2L12 22M12 2L5 9M12 2L19 9" stroke="#085041" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: "#111" }}>{maneuverLabel}</div>
                <div style={{ fontSize: 14, color: "#666" }}>
                  {Math.round(update.maneuver.distanceToManeuverM)} m
                  {update.maneuver.streetName ? ` · ${update.maneuver.streetName}` : ""}
                </div>
              </div>
            </>
          ) : (
            <div style={{ fontSize: 15, color: "#666" }}>{update ? "Volg de route" : "GPS zoeken..."}</div>
          )}
          {update && (
            <div style={{ textAlign: "right", fontSize: 13, color: "#888", flexShrink: 0 }}>
              <div>{(update.progress.remainingDistanceM / 1000).toFixed(1)} km</div>
            </div>
          )}
        </div>

        {sheetExpanded && update && (
          <div style={{ padding: "0 20px 24px", fontSize: 14 }}>
            {routeLabel && <div style={{ color: "#888", marginBottom: 12 }}>{routeLabel}</div>}

            <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ color: "#888", fontSize: 12 }}>Resterend</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{(update.progress.remainingDistanceM / 1000).toFixed(1)} km</div>
              </div>
              <div>
                <div style={{ color: "#888", fontSize: 12 }}>Totaal</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{(route.distanceM / 1000).toFixed(1)} km</div>
              </div>
              <div>
                <div style={{ color: "#888", fontSize: 12 }}>Voortgang</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{Math.round(update.progress.progressRatio * 100)}%</div>
              </div>
            </div>

            <button
              onClick={onExit}
              style={{
                width: "100%",
                minHeight: 48,
                border: "none",
                borderRadius: 12,
                background: "#b00020",
                color: "#FFFFFF",
                fontWeight: 700,
                fontSize: 15,
              }}
            >
              Route beëindigen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
