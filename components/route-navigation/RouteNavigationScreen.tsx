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

  // Kaart + routepolyline eenmalig opzetten.
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
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
  }, []);

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
        <div
          ref={mapRotateWrapperRef}
          style={{
            position: "absolute",
            top: "-25%",
            left: "-25%",
            width: "150%",
            height: "150%",
            transformOrigin: "center center",
            transition: `transform ${EASE_DURATION_MS}ms ease`,
          }}
        >
          <div ref={containerRef} style={{ position: "absolute", inset: 0 }} />
        </div>
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
            bottom: sheetExpanded ? "70vh" : 140,
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
          maxHeight: sheetExpanded ? "70vh" : "auto",
          overflowY: sheetExpanded ? "auto" : "visible",
          transition: "max-height 0.25s ease",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
        }}
      >
        <button
          onClick={() => setSheetExpanded((v) => !v)}
          style={{ width: "100%", padding: "10px 0 4px", border: "none", background: "transparent" }}
          aria-label={sheetExpanded ? "Inklappen" : "Uitklappen"}
        >
          <div style={{ width: 40, height: 5, borderRadius: 3, background: "#d0d0d0", margin: "0 auto" }} />
        </button>

        {/* Ingeklapt: alleen het belangrijkste. */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "4px 20px 18px" }}>
          {update?.maneuver ? (
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

            {update.offRoute.isOffRoute && (
              <div style={{ background: "#fff4e0", color: "#8a5a00", padding: 10, borderRadius: 8, marginBottom: 14 }}>
                ⚠️ Je lijkt van de route af te zijn.
              </div>
            )}

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
