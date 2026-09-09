/**
 * Connectorkandidaat-generatie -- Fase 3 (9-9-2026), TIJDELIJKE
 * onderzoeksinfrastructuur, geen productie-integratie. Puur, test bare
 * functie: geen Firestore/netwerk-afhankelijkheid, zodat de kernlogica
 * (vooral: wanneer een kandidaat afwijzen als vermoedelijk parallel)
 * onafhankelijk geverifieerd kan worden.
 *
 * Ontwerpkeuzes, expliciet gedocumenteerd (niet stilzwijgend aangenomen):
 *
 * 1. Alleen ECHTE NWB-segment-eindpunten (from/to) worden als kandidaat-
 *    locatie overwogen, nooit een geïnterpoleerd punt halverwege een
 *    segment. Dit lost het "kruising zonder verbinding op het midden van
 *    een doorlopend segment"-risico uit de opdracht al structureel op --
 *    er wordt domweg nooit een kandidaat op een middenpunt gegenereerd.
 *
 * 2. HIGH/LOWER confidence volgt primair uit de Fase 2-bevinding
 *    (Set A/FP = hoog vertrouwen, Set B/HR+RB = lager vertrouwen) --
 *    NIET primair uit afstand. Afstand wordt apart gerapporteerd als
 *    verdeling (zie connectorDistanceHistogram), conform de expliciete
 *    instructie om geen vaste afstandsdrempel vooraf vast te zetten.
 *
 * 3. Een kandidaat wordt AFGEWEZEN (rejected) wanneer de lokale richting
 *    van het NWB-segment sterk parallel loopt aan een GoKnoop-edge bij
 *    dezelfde node (hoek < PARALLEL_ANGLE_THRESHOLD_DEG) -- dit is de
 *    concrete, geautomatiseerde test voor het "twee parallelle
 *    fietspaden"-risico uit de opdracht.
 *
 * 4. Richting van de connector zelf wordt NOOIT afgeleid uit rijrichtng
 *    (Fase 2-bevinding: dat attribuut beschrijft gemotoriseerd verkeer).
 *    Elke connector krijgt daarom altijd directionAssessment =
 *    "onzeker_tweerichtingen_aangenomen" -- een eerlijke, expliciete
 *    onzekerheidsmarkering, geen gok.
 */

export type Vec2 = { x: number; y: number };

export type GoKnoopNodeInput = {
  id: string;
  x: number;
  y: number;
  /** Richtingsvector(en) van elke edge die vanaf deze node vertrekt (voor de parallel-check). */
  edgeBearings: Vec2[];
};

export type NwbSegmentInput = {
  id: string;
  bstCode: string | null;
  wegnummer: string | null;
  from: Vec2;
  to: Vec2;
};

export type ConnectorConfidence = "high" | "lower" | "rejected";

export type ConnectorCandidate = {
  goknoopNodeId: string;
  goknoopCoords: Vec2;
  nwbSegmentId: string;
  nwbEndpoint: "from" | "to";
  nwbCoords: Vec2;
  nwbBstCode: string | null;
  distanceM: number;
  bearingAngleDeg: number | null; // null als de GoKnoop-node geen edges heeft om mee te vergelijken
  nwbJunctionDegree: number; // aantal NWB-segmenten dat dit eindpunt deelt (binnen kleine snap-tolerantie)
  setClassification: "setA" | "setB" | "excluded";
  confidence: ConnectorConfidence;
  rejectionReason: string | null;
  directionAssessment: "onzeker_tweerichtingen_aangenomen";
};

const PARALLEL_ANGLE_THRESHOLD_DEG = 15;
const JUNCTION_SNAP_TOLERANCE_M = 3;

function angleBetweenDeg(a: Vec2, b: Vec2): number {
  const dot = a.x * b.x + a.y * b.y;
  const magA = Math.hypot(a.x, a.y);
  const magB = Math.hypot(b.x, b.y);
  if (magA === 0 || magB === 0) return 90; // geen richting bekend -- neutraal, niet als parallel behandelen
  const cos = Math.max(-1, Math.min(1, dot / (magA * magB)));
  const angleRad = Math.acos(cos);
  const angleDeg = (angleRad * 180) / Math.PI;
  // Richting is dubbelzijdig (een weg heeft geen voorkeursrichting voor deze check) --
  // een hoek van 170° (bijna tegengesteld) is voor "parallel lopen" even verdacht als 10°.
  return Math.min(angleDeg, 180 - angleDeg);
}

/** Classificatie, hergebruikt dezelfde regels als classify.ts (hier lokaal gehouden om deze module vrij van andere afhankelijkheden te houden -- puur voor Fase 3-onderzoek). */
function classify(bstCode: string | null, wegnummer: string | null): "setA" | "setB" | "excluded" {
  const isRijksautosnelweg = !!wegnummer && /^A\d/i.test(wegnummer.trim());
  if (isRijksautosnelweg) return "excluded";
  if (bstCode === "FP") return "setA";
  if (bstCode === "HR" || bstCode === "RB") return "setB";
  return "excluded";
}

export type CandidateGenerationResult = {
  candidates: ConnectorCandidate[];
  summary: {
    totalCandidates: number;
    highConfidence: number;
    lowerConfidence: number;
    rejected: number;
    distanceHistogram: Record<string, number>; // bv. "0-2m": 12, "2-5m": 34, ...
  };
};

/**
 * Genereert connector-kandidaten binnen `searchRadiusM` (een ZOEKGEBIED, geen
 * acceptatiedrempel -- zie ontwerpkeuze 2 hierboven). Elke NWB-segment-
 * eindpunt binnen die straal van een GoKnoop-node wordt een kandidaat,
 * ongeacht uiteindelijke confidence -- afwijzing gebeurt uitsluitend op
 * basis van de parallel-check, niet op afstand.
 */
export function generateConnectorCandidates(
  goknoopNodes: GoKnoopNodeInput[],
  nwbSegments: NwbSegmentInput[],
  searchRadiusM: number
): CandidateGenerationResult {
  // Stap 1: NWB-eindpunten verzamelen + junction-degree berekenen (snap-clustering, kleine tolerantie).
  type EndpointRecord = { segId: string; end: "from" | "to"; x: number; y: number; bstCode: string | null; wegnummer: string | null };
  const endpoints: EndpointRecord[] = [];
  for (const seg of nwbSegments) {
    endpoints.push({ segId: seg.id, end: "from", x: seg.from.x, y: seg.from.y, bstCode: seg.bstCode, wegnummer: seg.wegnummer });
    endpoints.push({ segId: seg.id, end: "to", x: seg.to.x, y: seg.to.y, bstCode: seg.bstCode, wegnummer: seg.wegnummer });
  }

  const junctionGrid = new Map<string, EndpointRecord[]>();
  const junctionCellOf = (x: number, y: number) => `${Math.floor(x / JUNCTION_SNAP_TOLERANCE_M)}:${Math.floor(y / JUNCTION_SNAP_TOLERANCE_M)}`;
  for (const ep of endpoints) {
    const cell = junctionCellOf(ep.x, ep.y);
    if (!junctionGrid.has(cell)) junctionGrid.set(cell, []);
    junctionGrid.get(cell)!.push(ep);
  }
  function junctionDegreeOf(ep: EndpointRecord): number {
    const [cx, cy] = junctionCellOf(ep.x, ep.y).split(":").map(Number);
    const uniqueSegIds = new Set<string>();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const candidates = junctionGrid.get(`${cx + dx}:${cy + dy}`);
        if (!candidates) continue;
        for (const c of candidates) {
          if (Math.hypot(c.x - ep.x, c.y - ep.y) <= JUNCTION_SNAP_TOLERANCE_M) uniqueSegIds.add(c.segId);
        }
      }
    }
    return uniqueSegIds.size;
  }

  // Stap 2: zoek-grid voor NWB-eindpunten (efficiënte nabijheidszoektocht i.p.v. O(N×M)).
  const searchGrid = new Map<string, EndpointRecord[]>();
  const searchCellOf = (x: number, y: number) => `${Math.floor(x / searchRadiusM)}:${Math.floor(y / searchRadiusM)}`;
  for (const ep of endpoints) {
    const cell = searchCellOf(ep.x, ep.y);
    if (!searchGrid.has(cell)) searchGrid.set(cell, []);
    searchGrid.get(cell)!.push(ep);
  }

  const candidates: ConnectorCandidate[] = [];
  for (const node of goknoopNodes) {
    const [cx, cy] = searchCellOf(node.x, node.y).split(":").map(Number);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const nearby = searchGrid.get(`${cx + dx}:${cy + dy}`);
        if (!nearby) continue;
        for (const ep of nearby) {
          const distanceM = Math.hypot(ep.x - node.x, ep.y - node.y);
          if (distanceM > searchRadiusM) continue;

          // NWB-segment vinden om de "outward"-richting vanaf dit eindpunt te bepalen.
          const seg = nwbSegments.find((s) => s.id === ep.segId)!;
          const nwbBearing: Vec2 =
            ep.end === "from" ? { x: seg.to.x - seg.from.x, y: seg.to.y - seg.from.y } : { x: seg.from.x - seg.to.x, y: seg.from.y - seg.to.y };

          let minAngle: number | null = null;
          for (const edgeBearing of node.edgeBearings) {
            const angle = angleBetweenDeg(nwbBearing, edgeBearing);
            if (minAngle === null || angle < minAngle) minAngle = angle;
          }

          const setClassification = classify(ep.bstCode, ep.wegnummer);
          let confidence: ConnectorConfidence;
          let rejectionReason: string | null = null;

          if (setClassification === "excluded") {
            confidence = "rejected";
            rejectionReason = "NWB-segment valt buiten Set A/B (bv. autosnelweg of niet-fietsrelevant type)";
          } else if (minAngle !== null && minAngle < PARALLEL_ANGLE_THRESHOLD_DEG) {
            confidence = "rejected";
            rejectionReason = `vermoedelijk parallelle infrastructuur (hoek ${minAngle.toFixed(1)}° < ${PARALLEL_ANGLE_THRESHOLD_DEG}°)`;
          } else if (setClassification === "setA") {
            confidence = "high";
          } else {
            confidence = "lower";
          }

          candidates.push({
            goknoopNodeId: node.id,
            goknoopCoords: { x: node.x, y: node.y },
            nwbSegmentId: ep.segId,
            nwbEndpoint: ep.end,
            nwbCoords: { x: ep.x, y: ep.y },
            nwbBstCode: ep.bstCode,
            distanceM,
            bearingAngleDeg: minAngle,
            nwbJunctionDegree: junctionDegreeOf(ep),
            setClassification,
            confidence,
            rejectionReason,
            directionAssessment: "onzeker_tweerichtingen_aangenomen",
          });
        }
      }
    }
  }

  const distanceHistogram: Record<string, number> = { "0-2m": 0, "2-5m": 0, "5-10m": 0, "10-20m": 0, "20-50m": 0, "50m+": 0 };
  for (const c of candidates) {
    if (c.distanceM <= 2) distanceHistogram["0-2m"]++;
    else if (c.distanceM <= 5) distanceHistogram["2-5m"]++;
    else if (c.distanceM <= 10) distanceHistogram["5-10m"]++;
    else if (c.distanceM <= 20) distanceHistogram["10-20m"]++;
    else if (c.distanceM <= 50) distanceHistogram["20-50m"]++;
    else distanceHistogram["50m+"]++;
  }

  return {
    candidates,
    summary: {
      totalCandidates: candidates.length,
      highConfidence: candidates.filter((c) => c.confidence === "high").length,
      lowerConfidence: candidates.filter((c) => c.confidence === "lower").length,
      rejected: candidates.filter((c) => c.confidence === "rejected").length,
      distanceHistogram,
    },
  };
}
