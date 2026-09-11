import type { GraphEdge, GraphProvider, Point } from "./types";
import type { CombinedGraph, CostAwareStep } from "../nwb-analysis/combined-graph";
import { resolveNwbGeometry } from "../nwb-analysis/nwb-geometry-resolver";
import { fetchGoknoopEdgeGeometry } from "./fetch-goknoop-edge-geometry";

/**
 * Combined-route-geometrie -- Fase M4, 10-9-2026, UITGEBREID Fase M6/M7
 * (geometrie-scheiding), 10-9-2026.
 *
 * Zet een pad uit `dijkstraWithCostModel` (CostAwareStep[], met het
 * BETROUWBARE `nwbSegmentId` per stap -- zie de segmentId-fix van eerder
 * vandaag) om naar een reeks ECHTE `GraphEdge`-objecten, geschikt voor
 * `resolveRouteEdges()`/`buildRouteProgressModel()` (navigatie, GPS-
 * voortgang) EN voor `Route.geometry` (kaartweergave).
 *
 * EXPLICIET, conform Te's opdracht:
 * - GEEN deduplicatie -- een segment dat het pad tweemaal doorkruist,
 *   verschijnt ook tweemaal in de uitvoer (elke keer met zijn eigen,
 *   voor die specifieke doorkruising correcte reisrichting).
 * - Volgorde exact behouden, identiek aan het Dijkstra-pad.
 * - GoKnoop-hops: geometrie wordt ON-DEMAND opgehaald (`fetchGoknoopEdgeGeometry`),
 *   NIET meer aangenomen dat de GraphProvider 'm al heeft -- sinds de
 *   opslagformaat-fix bevat de bulk-graaf alleen nog topologie (from/to/
 *   distanceM), geen geometrie (die bleek de bottleneck: 78 gebatchte
 *   edge-documenten MET coords kostte 6,2s bij elke aanvraag, terwijl
 *   een gekozen route maar een tiental edges gebruikt).
 * - NWB-hops: synthetische GraphEdge, met LIVE bij PDOK opgehaalde
 *   volledige geometrie (via de al-geverifieerde resolver).
 * - Connector-hops: synthetische GraphEdge met een RECHTE lijn tussen de
 *   twee eindpunten -- connectors zijn typisch een paar meter, een rechte
 *   lijn is hier een eerlijke, niet-misleidende representatie (geen
 *   bronroute-geometrie bestaat voor een connector, die is per definitie
 *   een kunstmatige brug tussen twee lagen).
 */

export type BuildCombinedRouteGeometryResult =
  | { ok: true; edges: GraphEdge[]; geometry: Point[]; unresolvedNwbSegments: string[] }
  | { ok: false; reason: string };

function distanceOf(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Kiest de rijrichting van een opgehaalde NWB-polylijn: begint 'ie bij `fromPos` of bij `toPos`? */
function orientNwbGeometry(coords: Point[], fromPos: Point): Point[] {
  if (coords.length === 0) return coords;
  const distToStart = distanceOf(coords[0], fromPos);
  const distToEnd = distanceOf(coords[coords.length - 1], fromPos);
  return distToStart <= distToEnd ? coords : [...coords].reverse();
}

export async function buildCombinedRouteGeometry(steps: CostAwareStep[], graph: CombinedGraph, goknoopProvider: GraphProvider): Promise<BuildCombinedRouteGeometryResult> {
  if (steps.length < 2) {
    return { ok: false, reason: "Een route met minder dan 2 stappen is ongeldig." };
  }

  // Vooraf alle benodigde NWB-segment-geometrie in één keer ophalen (efficiënter dan per-hop).
  const neededSegmentIds = new Set<string>();
  // Vooraf ook alle benodigde GoKnoop-edge-ID's verzamelen, voor dezelfde reden.
  const neededGoknoopEdgeIds = new Set<string>();
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i];
    if (step.edgeSource === "nwb" && step.nwbSegmentId) neededSegmentIds.add(step.nwbSegmentId);
    if (step.edgeSource === "goknoop") {
      const realEdge = goknoopProvider.getEdgesFrom(steps[i - 1].nodeId).find((e) => e.toLogicalNodeId === step.nodeId || e.fromLogicalNodeId === step.nodeId);
      if (realEdge) neededGoknoopEdgeIds.add(realEdge.id);
    }
  }
  const nwbGeometryResult = neededSegmentIds.size > 0 ? await resolveNwbGeometry(Array.from(neededSegmentIds)) : { resolved: new Map(), failed: [] };
  const goknoopGeometryMap = neededGoknoopEdgeIds.size > 0 ? await fetchGoknoopEdgeGeometry(Array.from(neededGoknoopEdgeIds)) : new Map<string, Point[]>();

  const edges: GraphEdge[] = [];
  const fullGeometry: Point[] = [];

  for (let i = 1; i < steps.length; i++) {
    const fromStep = steps[i - 1];
    const toStep = steps[i];
    const fromPos = graph.nodePosition.get(fromStep.nodeId);
    const toPos = graph.nodePosition.get(toStep.nodeId);
    if (!fromPos || !toPos) {
      return { ok: false, reason: `Knoop zonder positie in de graaf: '${!fromPos ? fromStep.nodeId : toStep.nodeId}'.` };
    }

    let edge: GraphEdge;

    if (toStep.edgeSource === "goknoop") {
      const realEdge = goknoopProvider.getEdgesFrom(fromStep.nodeId).find((e) => e.toLogicalNodeId === toStep.nodeId || e.fromLogicalNodeId === toStep.nodeId);
      if (!realEdge) {
        return { ok: false, reason: `GoKnoop-edge tussen '${fromStep.nodeId}' en '${toStep.nodeId}' niet gevonden in de GraphProvider.` };
      }
      const forward = realEdge.fromLogicalNodeId === fromStep.nodeId;
      const fetchedGeometry = goknoopGeometryMap.get(realEdge.id) ?? realEdge.geometry; // fallback op provider's eigen geometrie (bijv. in tests, waar de provider 'm wel al heeft)
      edge = { ...realEdge, geometry: forward ? fetchedGeometry : [...fetchedGeometry].reverse() };
    } else if (toStep.edgeSource === "nwb") {
      const segId = toStep.nwbSegmentId;
      if (!segId) return { ok: false, reason: `NWB-stap zonder nwbSegmentId (index ${i}) -- zou niet moeten voorkomen na de segmentId-fix.` };
      const fromPoint: Point = { x: fromPos.x, y: fromPos.y };
      const toPoint: Point = { x: toPos.x, y: toPos.y };
      const rawCoords = nwbGeometryResult.resolved.get(segId);
      const geometry = rawCoords ? orientNwbGeometry(rawCoords as Point[], fromPoint) : [fromPoint, toPoint]; // veilige degradatie: rechte lijn als geometrie-ophalen faalde
      edge = {
        id: `nwb-edge:${segId}:${i}`, // uniek per doorkruising (index i), zelfs als segId hergebruikt wordt
        fromLogicalNodeId: fromStep.nodeId,
        toLogicalNodeId: toStep.nodeId,
        distanceM: distanceAlongPolyline(geometry),
        directionality: "bidirectional",
        geometry,
      };
    } else {
      // connector: rechte lijn, geen bronroute-geometrie bestaat hiervoor.
      const fromPoint: Point = { x: fromPos.x, y: fromPos.y };
      const toPoint: Point = { x: toPos.x, y: toPos.y };
      edge = {
        id: `connector-edge:${i}`,
        fromLogicalNodeId: fromStep.nodeId,
        toLogicalNodeId: toStep.nodeId,
        distanceM: distanceOf(fromPoint, toPoint),
        directionality: "bidirectional",
        geometry: [fromPoint, toPoint],
      };
    }

    edges.push(edge);
    if (i === 1) fullGeometry.push(...edge.geometry);
    else fullGeometry.push(...edge.geometry.slice(1)); // gedeeld punt niet dupliceren
  }

  return { ok: true, edges, geometry: fullGeometry, unresolvedNwbSegments: nwbGeometryResult.failed };
}

function distanceAlongPolyline(points: Point[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += distanceOf(points[i - 1], points[i]);
  return sum;
}
