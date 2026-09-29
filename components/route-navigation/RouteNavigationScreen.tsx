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
 *
 * VISUELE HERBOUW (19-9-2026, live-feedback "Dit wil ik" + Apple Kaarten-referentie-
 * screenshot): kompaswidget, grote instructiekaart bovenaan (met een tweede regel die de
 * daaropvolgende afslag alvast toont), een bovenbalk met aankomsttijd/duur/afstand, en
 * ECHTE gesproken aankondigingen (Web Speech API) met een werkende mute-knop -- bewust geen
 * nepknop zonder functie.
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

const BAR_COLLAPSED_PX = 84;
const BAR_EXPANDED_RATIO = 0.55;
const BAR_SNAP_RATIO = 0.35;
const ANNOUNCE_DISTANCE_M = 150;

const DIRECTION_LABEL: Record<RelativeDirection, string> = {
  RECHTDOOR: "Rechtdoor",
  LICHT_LINKS: "Licht links",
  LINKS: "Linksaf",
  LICHT_RECHTS: "Licht rechts",
  RECHTS: "Rechtsaf",
  ACHTERUIT: "Keer om",
};
const DIRECTION_SPOKEN: Record<RelativeDirection, string> = {
  RECHTDOOR: "Blijf rechtdoor rijden",
  LICHT_LINKS: "Houd links aan",
  LINKS: "Ga linksaf",
  LICHT_RECHTS: "Houd rechts aan",
  RECHTS: "Ga rechtsaf",
  ACHTERUIT: "Keer om",
};

export type RouteNavigationScreenProps = {
  route: NavigationRoute;
  routeLabel?: string;
  approachGeometryEndIndex?: number;
  onExit: () => void;
};

export default function RouteNavigationScreen({ route, routeLabel, approachGeometryEndIndex, onExit }: RouteNavigationScreenProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRotateWrapperRef = useRef<HTMLDivElement>(null);
  const compassNeedleRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const positionMarkerRef = useRef<L.CircleMarker | null>(null);
  const sessionRef = useRef<RouteNavigationSession | null>(null);
  const isFollowingRef = useRef(true);
  const watchIdRef = useRef<number | null>(null);

  const [isFollowing, setIsFollowing] = useState(true);
  const [update, setUpdate] = useState<NavigationUpdate | null>(null);
  const [barExpanded, setBarExpanded] = useState(false);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const [mapWrapperSizePx, setMapWrapperSizePx] = useState(0);

  const [barHeightPx, setBarHeightPx] = useState(BAR_COLLAPSED_PX);
  const expandedHeightPxRef = useRef(BAR_COLLAPSED_PX);
  const dragStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [isDraggingBar, setIsDraggingBar] = useState(false);

  const announcedManeuverIndexRef = useRef<number | null>(null);
  const mutedRef = useRef(false);
  useEffect(() => {
    mutedRef.current = muted;
    if (muted && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, [muted]);

  useEffect(() => {
    function measure() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setMapWrapperSizePx(Math.ceil(Math.sqrt(w * w + h * h)) + 40);
      expandedHeightPxRef.current = Math.round(h * BAR_EXPANDED_RATIO);
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);

  useEffect(() => {
    if (mapWrapperSizePx === 0 || !containerRef.current || mapRef.current) return;
    let cancelled = false;

    (async () => {
      const L = await import("leaflet");
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, { zoomControl: false, attributionControl: true });
      L.tileLayer(CARTO_RASTER_URL, { attribution: CARTO_ATTRIBUTION, subdomains: CARTO_SUBDOMAINS, maxZoom: 20 }).addTo(map);

      const latLngs: L.LatLngTuple[] = route.geometry.map((p) => [p.lat, p.lon]);
      const splitIdx = approachGeometryEndIndex;
      let bounds: L.LatLngBounds;
      if (splitIdx && splitIdx > 0 && splitIdx < latLngs.length) {
        L.polyline(latLngs.slice(0, splitIdx), { color: "#5b7280", weight: 4, dashArray: "2 10", lineCap: "round" }).addTo(map);
        L.polyline(latLngs.slice(splitIdx - 1), { color: ROUTE_COLOR, weight: 5, lineJoin: "round", lineCap: "round" }).addTo(map);
        bounds = L.polyline(latLngs).getBounds();
      } else {
        const line = L.polyline(latLngs, { color: ROUTE_COLOR, weight: 5, lineJoin: "round", lineCap: "round" }).addTo(map);
        bounds = line.getBounds();
      }
      map.fitBounds(bounds, { padding: [40, 40] });

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

        if (
          result.maneuver &&
          result.maneuver.distanceToManeuverM <= ANNOUNCE_DISTANCE_M &&
          announcedManeuverIndexRef.current !== result.maneuver.atGeometryIndex &&
          !mutedRef.current &&
          typeof window !== "undefined" &&
          window.speechSynthesis
        ) {
          announcedManeuverIndexRef.current = result.maneuver.atGeometryIndex;
          const direction = classifyManeuverDirection(result.maneuver.turnAngleDeg);
          const text = `Over ${Math.round(result.maneuver.distanceToManeuverM)} meter. ${DIRECTION_SPOKEN[direction]}${
            result.maneuver.streetName ? `, naar ${result.maneuver.streetName}` : ""
          }.`;
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.lang = "nl-NL";
          window.speechSynthesis.speak(utterance);
        }

        const map = mapRef.current;
        const marker = positionMarkerRef.current;
        if (map && marker) {
          const matched: L.LatLngTuple = [result.progress.matchedPoint.lat, result.progress.matchedPoint.lon];
          marker.setLatLng(matched);

          if (isFollowingRef.current) {
            map.flyTo(matched, NAVIGATION_ZOOM, { animate: true, duration: EASE_DURATION_MS / 1000 });
          }
          if (result.smoothedHeadingDeg !== null) {
            const rotation = `rotate(${-result.smoothedHeadingDeg}deg)`;
            if (mapRotateWrapperRef.current) mapRotateWrapperRef.current.style.transform = rotation;
            if (compassNeedleRef.current) compassNeedleRef.current.style.transform = rotation;
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
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
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

  function handleBarPointerDown(e: React.PointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStateRef.current = { startY: e.clientY, startHeight: barHeightPx };
    setIsDraggingBar(true);
  }
  function handleBarPointerMove(e: React.PointerEvent) {
    if (!dragStateRef.current) return;
    const delta = dragStateRef.current.startY - e.clientY;
    const next = Math.min(expandedHeightPxRef.current, Math.max(BAR_COLLAPSED_PX, dragStateRef.current.startHeight + delta));
    setBarHeightPx(next);
  }
  function handleBarPointerUp() {
    if (!dragStateRef.current) return;
    const range = expandedHeightPxRef.current - BAR_COLLAPSED_PX;
    const progress = range > 0 ? (barHeightPx - BAR_COLLAPSED_PX) / range : 0;
    const snapExpanded = progress > BAR_SNAP_RATIO;
    setBarHeightPx(snapExpanded ? expandedHeightPxRef.current : BAR_COLLAPSED_PX);
    setBarExpanded(snapExpanded);
    dragStateRef.current = null;
    setIsDraggingBar(false);
  }

  const nextManeuverLabel = update?.nextManeuver ? DIRECTION_LABEL[classifyManeuverDirection(update.nextManeuver.turnAngleDeg)] : null;

  let arrivalLabel = "--:--";
  let etaMinutes: number | null = null;
  if (update) {
    const avgSpeedMps = route.durationS > 0 ? route.distanceM / route.durationS : 0;
    const remainingS = avgSpeedMps > 0 ? update.progress.remainingDistanceM / avgSpeedMps : route.durationS;
    etaMinutes = Math.max(0, Math.round(remainingS / 60));
    const arrivalDate = new Date(Date.now() + remainingS * 1000);
    arrivalLabel = arrivalDate.toLocaleTimeString("nl-NL", { hour: "2-digit", minute: "2-digit" });
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 1000, background: "#000" }}>
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

      <button
        onClick={onExit}
        style={{
          position: "absolute",
          top: "calc(env(safe-area-inset-top, 0px) + 12px)",
          left: 12,
          zIndex: 6,
          width: 40,
          height: 40,
          borderRadius: 20,
          border: "none",
          background: "rgba(30,30,30,0.7)",
          color: "#FFFFFF",
          fontSize: 18,
        }}
      >
        ✕
      </button>

      {update && (update.maneuver || update.offRoute.isOffRoute) && (
        <div
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top, 0px) + 8px)",
            left: 12,
            right: 12,
            zIndex: 5,
            borderRadius: 18,
            overflow: "hidden",
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          }}
        >
          {update.offRoute.isOffRoute ? (
            <div style={{ background: "#8a3b00", padding: "18px 20px", display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ fontSize: 30 }}>⚠️</div>
              <div>
                <div style={{ color: "#FFFFFF", fontSize: 19, fontWeight: 800 }}>Je lijkt van de route af te zijn</div>
                <div style={{ color: "#ffe0b3", fontSize: 13 }}>Controleer je positie op de kaart</div>
              </div>
            </div>
          ) : (
            update.maneuver && (
              <>
                <div style={{ background: "#1c2b24e6", padding: "16px 20px 14px", display: "flex", alignItems: "center", gap: 16 }}>
                  <div style={{ flexShrink: 0, transform: `rotate(${update.maneuverArrowDeg}deg)`, transition: "transform 0.3s ease" }}>
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <path d="M12 2L12 22M12 2L5 9M12 2L19 9" stroke="#FFFFFF" strokeWidth="2.75" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ color: "#FFFFFF", fontSize: 30, fontWeight: 800, lineHeight: 1.1 }}>
                      {Math.round(update.maneuver.distanceToManeuverM)} m
                    </div>
                    {update.maneuver.streetName && (
                      <div style={{ color: "#b9c4bf", fontSize: 16, marginTop: 2 }}>{update.maneuver.streetName}</div>
                    )}
                    <div style={{ color: "#4ade80", fontSize: 14, fontWeight: 700, marginTop: 2 }}>Fietsroute</div>
                  </div>
                </div>
                {update.nextManeuver && (
                  <div style={{ background: "#0f1a15cc", padding: "10px 20px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ flexShrink: 0, transform: `rotate(${update.nextManeuver.turnAngleDeg}deg)` }}>
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M12 2L12 22M12 2L5 9M12 2L19 9" stroke="#cfd8d4" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                    <div style={{ color: "#cfd8d4", fontSize: 14 }}>
                      Daarna: {nextManeuverLabel}
                      {update.nextManeuver.streetName ? ` naar ${update.nextManeuver.streetName}` : ""}
                    </div>
                  </div>
                )}
              </>
            )
          )}
        </div>
      )}

      {!update && !gpsError && (
        <div
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top, 0px) + 8px)",
            left: 12,
            right: 12,
            zIndex: 5,
            background: "#1c2b24e6",
            borderRadius: 18,
            padding: "16px 20px",
            color: "#FFFFFF",
            fontSize: 15,
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          }}
        >
          GPS zoeken...
        </div>
      )}

      {gpsError && (
        <div
          style={{
            position: "absolute",
            top: "calc(env(safe-area-inset-top, 0px) + 8px)",
            left: 60,
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

      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: barHeightPx + 16,
          zIndex: 5,
          width: 46,
          height: 46,
          borderRadius: 23,
          background: "rgba(255,255,255,0.92)",
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transition: isDraggingBar ? "none" : "bottom 0.25s ease",
        }}
      >
        <div ref={compassNeedleRef} style={{ transition: `transform ${EASE_DURATION_MS}ms ease` }}>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M12 2L15 12L12 10L9 12L12 2Z" fill="#b00020" />
            <path d="M12 22L9 12L12 14L15 12L12 22Z" fill="#8a8a8a" />
          </svg>
        </div>
      </div>

      {!isFollowing && (
        <button
          onClick={handleRecenter}
          style={{
            position: "absolute",
            bottom: barHeightPx + 16,
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
            transition: isDraggingBar ? "none" : "bottom 0.25s ease",
          }}
        >
          <span style={{ fontSize: 16 }}>📍</span> Volg mij
        </button>
      )}

      <button
        onClick={() => setMuted((v) => !v)}
        aria-label={muted ? "Geluid aanzetten" : "Geluid uitzetten"}
        style={{
          position: "absolute",
          top: update ? "calc(env(safe-area-inset-top, 0px) + 8px + 96px)" : "calc(env(safe-area-inset-top, 0px) + 64px)",
          right: 12,
          zIndex: 6,
          width: 44,
          height: 44,
          borderRadius: 22,
          border: "none",
          background: "rgba(255,255,255,0.92)",
          fontSize: 19,
          boxShadow: "0 2px 8px rgba(0,0,0,0.3)",
        }}
      >
        {muted ? "🔇" : "🔊"}
      </button>

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
          height: barHeightPx,
          overflowY: barHeightPx > BAR_COLLAPSED_PX + 20 ? "auto" : "hidden",
          transition: isDraggingBar ? "none" : "height 0.25s ease",
          paddingBottom: "env(safe-area-inset-bottom, 0px)",
          touchAction: "none",
        }}
      >
        <div
          onPointerDown={handleBarPointerDown}
          onPointerMove={handleBarPointerMove}
          onPointerUp={handleBarPointerUp}
          style={{ width: "100%", cursor: "grab" }}
          aria-label={barExpanded ? "Sleep omlaag om in te klappen" : "Sleep omhoog om uit te klappen"}
        >
          <div style={{ padding: "10px 0 6px" }}>
            <div style={{ width: 40, height: 5, borderRadius: 3, background: "#d0d0d0", margin: "0 auto" }} />
          </div>
          <div style={{ display: "flex", padding: "0 20px 16px", textAlign: "center" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#111" }}>{arrivalLabel}</div>
              <div style={{ fontSize: 12, color: "#888" }}>aankomst</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#111" }}>{etaMinutes ?? "--"}</div>
              <div style={{ fontSize: 12, color: "#888" }}>min.</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: "#111" }}>
                {update ? (update.progress.remainingDistanceM / 1000).toFixed(1) : (route.distanceM / 1000).toFixed(1)}
              </div>
              <div style={{ fontSize: 12, color: "#888" }}>km</div>
            </div>
          </div>
        </div>

        {barExpanded && (
          <div style={{ padding: "0 20px 24px", fontSize: 14 }}>
            {routeLabel && <div style={{ color: "#888", marginBottom: 12 }}>{routeLabel}</div>}

            <div style={{ display: "flex", gap: 16, marginBottom: 16 }}>
              <div>
                <div style={{ color: "#888", fontSize: 12 }}>Totale afstand</div>
                <div style={{ fontWeight: 700, fontSize: 16 }}>{(route.distanceM / 1000).toFixed(1)} km</div>
              </div>
              {update && (
                <div>
                  <div style={{ color: "#888", fontSize: 12 }}>Voortgang</div>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{Math.round(update.progress.progressRatio * 100)}%</div>
                </div>
              )}
            </div>

            <button
              onClick={() => setMuted((v) => !v)}
              style={{
                width: "100%",
                minHeight: 48,
                marginBottom: 10,
                border: "1px solid #d0d0d0",
                borderRadius: 12,
                background: "#FFFFFF",
                color: "#111",
                fontWeight: 600,
                fontSize: 15,
              }}
            >
              {muted ? "🔇 Gesproken aankondigingen uit" : "🔊 Gesproken aankondigingen aan"}
            </button>

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
