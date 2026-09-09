/**
 * Regiodefinities voor de achtergrond-verzamelaar -- TIJDELIJKE
 * onderzoeksinfrastructuur (8-9-2026). Geen productiefeature.
 */

import { wgs84ToRd } from "../route-engine/coordinate-transform";
import type { Bbox } from "./quad-collector";

export type CollectorRegion = {
  label: string;
  latMin: number;
  latMax: number;
  lonMin: number;
  lonMax: number;
  /** Voor de finale Dijkstra-test na volledige verzameling. */
  fromNodeId: string;
  toNodeId: string;
};

export const COLLECTOR_REGIONS: Record<string, CollectorRegion> = {
  hilversum: {
    label: "Amsterdam <-> Hilversum, ruime buffer",
    latMin: 52.15,
    latMax: 52.45,
    lonMin: 4.75,
    lonMax: 5.25,
    fromNodeId: "CJSXBPUMG49vOPmYvhJd", // Amsterdam Centraal
    toNodeId: "ZYuO6ZfzSa2iim0HcUbn", // knooppunt 55, Hilversum
  },
  lochem: {
    label: "Lochem / Achterhoek, ruime buffer",
    latMin: 52.05,
    latMax: 52.25,
    lonMin: 6.25,
    lonMax: 6.55,
    // Kandidaat-startpunt Lochem (zie eerdere sessie -- 9cdQ8xUK4u2DFybtRTfg).
    fromNodeId: "9cdQ8xUK4u2DFybtRTfg",
    toNodeId: "9cdQ8xUK4u2DFybtRTfg", // Voor Lochem is de test primair connectiviteit/componenten, niet A->B; zelfde node als placeholder.
  },
  volendam: {
    label: "Volendam / Edam / Purmerend, ruime buffer",
    latMin: 52.38,
    latMax: 52.58,
    lonMin: 4.85,
    lonMax: 5.2,
    fromNodeId: "7fmSWIHYsKu3Wb3yOtM2", // Volendam knooppunt 95
    toNodeId: "7fmSWIHYsKu3Wb3yOtM2",
  },
};

export function regionRootBbox(region: CollectorRegion): Bbox {
  const corners = [
    wgs84ToRd(region.latMin, region.lonMin),
    wgs84ToRd(region.latMin, region.lonMax),
    wgs84ToRd(region.latMax, region.lonMin),
    wgs84ToRd(region.latMax, region.lonMax),
  ];
  return {
    minX: Math.min(...corners.map((c) => c.x)),
    maxX: Math.max(...corners.map((c) => c.x)),
    minY: Math.min(...corners.map((c) => c.y)),
    maxY: Math.max(...corners.map((c) => c.y)),
  };
}
