import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import type { NetworkBridge, NetworkBridgeValidationStatus, BridgeCandidate } from "@/lib/route-engine/network-bridge-types";
import { classifyBridgeAttempt } from "@/lib/route-engine/bridge-validation-thresholds";

export const maxDuration = 10; // Vercel Hobby: HARDE 10s-limiet per functie, ongeacht wat hier staat (zie docs/HANDOFF.md sectie 3.1, GOKNOOP-MASTER.md 9.43-9.48). Batches zijn daarom tijdsbudget-bewust, niet call-count-bewust.

/**
 * GET /api/import/generate-bridges — Network Bridge Layer-generator.
 * Implementatieplan: docs/network-bridge-layer-plan.md (§4-§8, §13, §17).
 *
 * HERONTWERP 5-9-2026 (GPT-review, n.a.v. landelijke analyze-run: 3081
 * kandidaatparen / 6162 benodigde ORS-calls, ruim boven de 200-cap per run).
 * Vervangt het oorspronkelijke single-shot compute/write door een
 * deterministisch batchmechanisme met expliciete statussen:
 *
 *   ANALYZE (phase=analyze, ongewijzigd, geen cache-effect)
 *        |
 *   PREPARE (phase=prepare&scope=strong|weak)
 *        -> berekent EENMALIG de deterministische, richtinggevoelige
 *           kandidatenlijst voor het gekozen signaal en cachet die
 *           (gechunkt, zelfde patroon als edgeMatchCache). Geen ORS-calls.
 *        |
 *   COMPUTE BATCHES (phase=compute-batch&scope=...&batchOffset=N)
 *        -> verwerkt een TIJDSBUDGET-bewuste slice van de gecachete lijst
 *           (stopt ruim vóór de harde 10s-Vercel-Hobby-limiet, ongeacht hoe
 *           groot de gevraagde batchSize was), batchOffset MOET gelijk zijn
 *           aan het al-verwerkte aantal (geen gaten/sprongen mogelijk).
 *           Herhaal totdat status "complete" is.
 *        |
 *   COMPLETE (status-veld in de cache, geen aparte phase)
 *        |
 *   WRITE (phase=write&scope=...)
 *        -> alleen toegestaan wanneer status "complete" is; persisteert alle
 *           resultaten (valid EN rejected, plan §8) naar networkBridges.
 *
 * RATE-LIMIT-INCIDENT (5-9-2026): de eerste volledige strong-scope-run (4002
 * items) liep tegen ORS's rate limit aan (HTTP 429) na de eerste paar
 * honderd calls, zonder retry/backoff/vertraging. Erger nog: de generator
 * classificeerde `provider_error` (429/HTTP-fouten) ten onrechte hetzelfde
 * als `no_route_found` (een ECHTE afwijzing) -- waardoor 4002 resultaten met
 * overwegend `rejected_no_route` werden geschreven die grotendeels helemaal
 * geen uitspraak deden over of er een fietsroute bestaat. Bevestigd doordat
 * de 3 al-bekende, eerder 100%-valide Amsterdam-knopen plotseling ook
 * `rejected_no_route`/429 gaven. Gerepareerd: `provider_error` krijgt een
 * eigen status (`rejected_provider_error`, NOOIT een impliciete "geen
 * route"-uitspraak), met retry+backoff vóórdat die status definitief wordt,
 * plus een verplichte vertraging tussen ORS-calls, plus een tijdsbudget dat
 * een batch veilig laat stoppen (i.p.v. de 10s-Vercel-limiet te riskeren).
 * De eerder geschreven 4002 resultaten van vóór deze fix zijn NIET
 * betrouwbaar en horen gewist te worden (phase=reset) vóór een nieuwe run.
 *
 * BELANGRIJK — bridges zijn DIRECTIONEEL (plan §2): de gecachete kandidatenlijst
 * bevat AL beide richtingen als aparte items (1 item = 1 ORS-call = 1
 * NetworkBridge-document) -- geen impliciete "x2"-vermenigvuldiging meer
 * ergens in de batch-logica, wat bij paginering foutgevoelig zou zijn.
 *
 * SCOPE (GPT 5-9-2026, n.a.v. de 80%-rejected-uitkomst op de ongesplitste
 * populatie): "strong" = edgeCount===0 (het sterke, ondubbelzinnige signaal --
 * hier starten we mee). "weak" = edgeCount===1 + kleine component (zwakker
 * heuristisch signaal, pas te gebruiken NADAT de strong-populatie een
 * bevredigende validity-rate heeft aangetoond).
 */

// ---- Harde server-side caps (plan §17 — query-parameters kunnen deze alleen VERLAGEN, nooit verhogen) ----
const MAX_CANDIDATES_PER_NODE_HARD_CAP = 3;
const MAX_BRIDGE_CANDIDATE_RADIUS_M_HARD_CAP = 3000;
const MAX_TOTAL_ORS_CALLS_PER_RUN = 30; // bovengrens per aanvraag; het TIJDSBUDGET (hieronder) is meestal de echte begrenzer

// ---- Vercel Hobby 10s-limiet-bewuste batchverwerking (5-9-2026, n.a.v. rate-limit-incident) ----
const FUNCTION_TIME_BUDGET_MS = 7000; // ruime marge onder de harde 10s (response-serialisatie, netwerklatentie, cold start)
const ORS_CALL_DELAY_MS = 400; // verplichte pauze TUSSEN elke ORS-call, proactief, om rate limiting te voorkomen i.p.v. er pas op te reageren
const ORS_RETRY_DELAYS_MS = [500, 1500]; // backoff-schema bij provider_error (bv. 429) -- 2 extra pogingen, dan pas rejected_provider_error

// ---- Gap-detection (plan §4, definitief herzien 5-9-2026) ----
const DEFAULT_GAP_COMPONENT_SIZE_THRESHOLD = 50;

const CANDIDATE_CACHE_COLLECTION = "generateBridgesCandidateCache";
const CANDIDATE_CACHE_CHUNK_SIZE = 500;
const ATTEMPTS_COLLECTION = "generateBridgesAttempts";
const FIRESTORE_OP_LIMIT = 450;

type LNode = { id: string; x: number; y: number; displayNumber?: string };
type Scope = "strong" | "weak";

/** Eén regel in de deterministische, gecachete kandidatenlijst -- vóór ORS-validatie. */
type DirectionalCandidate = {
  id: string; // `${datasetVersionId}_${sourceNodeId}_${targetNodeId}` -- ook het uiteindelijke NetworkBridge-ID (plan §8)
  sourceNodeId: string;
  targetNodeId: string;
  geographicDistanceM: number;
  sourceComponentSize: number;
  targetComponentSize: number;
};

/** Zoals DirectionalCandidate, plus het ORS-validatieresultaat -- 1 document per item in ATTEMPTS_COLLECTION. */
type StoredAttempt = DirectionalCandidate & {
  datasetVersionId: string;
  scope: Scope;
  validationStatus: NetworkBridgeValidationStatus;
  rejectionReason: string | null;
  distanceM: number | null;
  durationS: number | null;
  circuityRatio: number | null;
  geometry: { lat: number; lon: number }[] | null;
  validatedAt: string;
};

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

async function loadGraphStructure(db: FirebaseFirestore.Firestore, datasetVersionId: string) {
  const [logicalNodesSnap, matchedEdgesSnap] = await Promise.all([
    db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
    db.collection("edges").where("datasetVersionId", "==", datasetVersionId).where("matchConfidence", "==", "matched").get(),
  ]);

  if (logicalNodesSnap.empty) return null;

  const nodes: LNode[] = logicalNodesSnap.docs.map((d) => {
    const data = d.data();
    return { id: d.id, x: data.x, y: data.y, displayNumber: data.displayNumber };
  });
  const idToIndex = new Map<string, number>();
  nodes.forEach((n, i) => idToIndex.set(n.id, i));

  const uf = new UnionFind(nodes.length);
  const edgeCountByNode = new Map<string, number>();
  for (const doc of matchedEdgesSnap.docs) {
    const d = doc.data();
    const fromIdx = idToIndex.get(d.fromLogicalNodeId);
    const toIdx = idToIndex.get(d.toLogicalNodeId);
    if (fromIdx !== undefined && toIdx !== undefined) {
      uf.union(fromIdx, toIdx);
      edgeCountByNode.set(d.fromLogicalNodeId, (edgeCountByNode.get(d.fromLogicalNodeId) || 0) + 1);
      edgeCountByNode.set(d.toLogicalNodeId, (edgeCountByNode.get(d.toLogicalNodeId) || 0) + 1);
    }
  }

  const componentSize = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    const root = uf.find(i);
    componentSize.set(root, (componentSize.get(root) || 0) + 1);
  }

  return { nodes, idToIndex, uf, componentSize, edgeCountByNode };
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

type GraphStructure = NonNullable<Awaited<ReturnType<typeof loadGraphStructure>>>;

/**
 * Gap-detectie (plan §4, definitief 5-9-2026):
 *   isStrongGap = edgeCount === 0                               (729 landelijk)
 *   isWeakGap   = edgeCount === 1 AND componentSize < threshold  (609 landelijk)
 * Bewust GEEN "heeft-kandidaat-binnen-radius"-check hier -- dat hoort bij
 * kandidaatselectie (findCandidates), niet bij gap-detectie zelf.
 */
function detectGapNodes(structure: GraphStructure, gapComponentSizeThreshold: number) {
  const { nodes, uf, componentSize, edgeCountByNode } = structure;
  const strongGap = new Set<number>();
  const weakGap = new Set<number>();
  for (let i = 0; i < nodes.length; i++) {
    const edgeCount = edgeCountByNode.get(nodes[i].id) || 0;
    if (edgeCount === 0) {
      strongGap.add(i);
    } else if (edgeCount === 1) {
      const size = componentSize.get(uf.find(i)) || 1;
      if (size < gapComponentSizeThreshold) weakGap.add(i);
    }
  }
  return { strongGap, weakGap };
}

/** Kandidaatselectie (plan §5): andere, grotere component, binnen radius, top-N. */
function findCandidates(
  structure: GraphStructure,
  gapNodeIndices: Iterable<number>,
  candidateRadiusM: number,
  maxCandidatesPerNode: number
): BridgeCandidate[] {
  const { nodes, uf, componentSize } = structure;
  const radiusSq = candidateRadiusM * candidateRadiusM;
  const candidates: BridgeCandidate[] = [];

  for (const i of gapNodeIndices) {
    const node = nodes[i];
    const root = uf.find(i);
    const nodeComponentSize = componentSize.get(root) || 1;

    const nearby = nodes
      .map((n, j) => {
        if (j === i) return null;
        const otherRoot = uf.find(j);
        if (otherRoot === root) return null;
        const otherSize = componentSize.get(otherRoot) || 1;
        if (otherSize <= nodeComponentSize) return null;
        const dx = n.x - node.x;
        const dy = n.y - node.y;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) return null;
        return { node: n, distanceM: Math.sqrt(distSq), otherComponentSize: otherSize };
      })
      .filter((c): c is { node: LNode; distanceM: number; otherComponentSize: number } => c !== null)
      .sort((a, b) => a.distanceM - b.distanceM)
      .slice(0, maxCandidatesPerNode);

    for (const c of nearby) {
      candidates.push({
        sourceNodeId: node.id,
        sourceComponentSize: nodeComponentSize,
        targetNodeId: c.node.id,
        targetComponentSize: c.otherComponentSize,
        geographicDistanceM: c.distanceM,
      });
    }
  }
  return candidates;
}

/** Zet geografische paren om in een deterministische, gesorteerde lijst van BEIDE richtingen apart. */
function toDirectionalCandidates(datasetVersionId: string, pairs: BridgeCandidate[]): DirectionalCandidate[] {
  const out: DirectionalCandidate[] = [];
  for (const p of pairs) {
    out.push({
      id: `${datasetVersionId}_${p.sourceNodeId}_${p.targetNodeId}`,
      sourceNodeId: p.sourceNodeId,
      targetNodeId: p.targetNodeId,
      geographicDistanceM: p.geographicDistanceM,
      sourceComponentSize: p.sourceComponentSize,
      targetComponentSize: p.targetComponentSize,
    });
    out.push({
      id: `${datasetVersionId}_${p.targetNodeId}_${p.sourceNodeId}`,
      sourceNodeId: p.targetNodeId,
      targetNodeId: p.sourceNodeId,
      geographicDistanceM: p.geographicDistanceM,
      sourceComponentSize: p.targetComponentSize,
      targetComponentSize: p.sourceComponentSize,
    });
  }
  // Deterministisch: alfabetisch op id. Chunking/paginering hangt hiervan af,
  // dus de sortering moet stabiel en herhaalbaar zijn -- string sort is dat.
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

function candidateMetaRef(db: FirebaseFirestore.Firestore, datasetVersionId: string, scope: Scope) {
  return db.collection(CANDIDATE_CACHE_COLLECTION).doc(`${datasetVersionId}_${scope}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Roept ORS aan met retry+backoff bij `provider_error` (bv. 429) -- ALLEEN
 * `no_route_found` telt als een echte afwijzing. Na uitgeputte retries wordt
 * een provider-fout expliciet als zodanig geclassificeerd (nooit stilzwijgend
 * als "geen route", zie docstring bovenaan).
 */
async function routeWithRetry(
  router: LocalBikeRouter,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number }
): Promise<
  | { ok: true; distanceM: number; durationS: number; geometry: { lat: number; lon: number }[] }
  | { ok: false; validationStatus: "rejected_no_route" | "rejected_provider_error"; rejectionReason: string }
> {
  let lastReason = "";
  for (let attempt = 0; attempt <= ORS_RETRY_DELAYS_MS.length; attempt++) {
    const result = await router.route(from, to, "cycling");
    if (!("reason" in result)) {
      return { ok: true, distanceM: result.distanceM, durationS: result.durationS, geometry: result.geometry };
    }
    if (result.reason === "no_route_found") {
      // Echte afwijzing -- geen retry nodig, ORS heeft een definitief antwoord gegeven.
      return { ok: false, validationStatus: "rejected_no_route", rejectionReason: `ORS: ${result.reason} (${result.message})` };
    }
    // provider_error / invalid_response -- vermoedelijk transient (bv. 429). Retry met backoff.
    lastReason = `ORS: ${result.reason}${result.message ? ` (${result.message})` : ""}`;
    if (attempt < ORS_RETRY_DELAYS_MS.length) {
      await sleep(ORS_RETRY_DELAYS_MS[attempt]);
    }
  }
  return { ok: false, validationStatus: "rejected_provider_error", rejectionReason: `${lastReason} -- na ${ORS_RETRY_DELAYS_MS.length + 1} pogingen` };
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }
  const phase = req.nextUrl.searchParams.get("phase") || "analyze";

  const requestedMaxCandidates = parseInt(req.nextUrl.searchParams.get("maxCandidates") || String(MAX_CANDIDATES_PER_NODE_HARD_CAP), 10);
  const maxCandidatesPerNode = Math.min(requestedMaxCandidates, MAX_CANDIDATES_PER_NODE_HARD_CAP);

  const requestedRadiusM = parseFloat(req.nextUrl.searchParams.get("candidateRadiusM") || String(MAX_BRIDGE_CANDIDATE_RADIUS_M_HARD_CAP));
  const candidateRadiusM = Math.min(requestedRadiusM, MAX_BRIDGE_CANDIDATE_RADIUS_M_HARD_CAP);

  const gapComponentSizeThreshold = parseInt(
    req.nextUrl.searchParams.get("gapComponentSizeThreshold") || String(DEFAULT_GAP_COMPONENT_SIZE_THRESHOLD),
    10
  );

  try {
    const db = getDb();

    // ============================================================
    // PHASE: status -- puur lezen, geen enkele wijziging. Toegevoegd 5-9-2026
    // zodat een client (bv. de in-app batch-runner) de voortgang van een
    // eerdere prepare/compute-batch-reeks kan opvragen zonder het risico dat
    // phase=prepare per ongeluk opnieuw wordt aangeroepen en de al-opgebouwde
    // voortgang (processedCount) reset.
    // ============================================================
    if (phase === "status") {
      const scope = req.nextUrl.searchParams.get("scope") as Scope | null;
      if (scope !== "strong" && scope !== "weak") {
        return NextResponse.json({ error: "scope is verplicht en moet 'strong' of 'weak' zijn." }, { status: 400 });
      }
      const metaSnap = await candidateMetaRef(db, datasetVersionId, scope).get();

      // Diagnostisch (5-9-2026, n.a.v. onverklaarde discrepantie na reset: 852
      // deletedAttempts i.p.v. verwacht 4002, candidateCacheCleared:false
      // terwijl prepare eerder succesvol leek). Telt de WERKELIJKE Firestore-
      // staat i.p.v. te vertrouwen op de meta-cache, om te zien of er
      // documenten zonder scope-veld zijn blijven staan van vóór de
      // scope-toevoeging, of dat er iets anders aan de hand is.
      const [attemptsWithScopeSnap, allNetworkBridgesForDatasetSnap, networkBridgesWithScopeSnap] = await Promise.all([
        db.collection(ATTEMPTS_COLLECTION).where("datasetVersionId", "==", datasetVersionId).where("scope", "==", scope).get(),
        db.collection("networkBridges").where("datasetVersionId", "==", datasetVersionId).get(),
        db.collection("networkBridges").where("datasetVersionId", "==", datasetVersionId).where("scope", "==", scope).get(),
      ]);
      const networkBridgesWithoutScopeField = allNetworkBridgesForDatasetSnap.docs.filter((d) => d.data().scope === undefined).length;

      const diagnostics = {
        actualAttemptsWithScopeCount: attemptsWithScopeSnap.docs.length,
        actualNetworkBridgesTotalForDataset: allNetworkBridgesForDatasetSnap.docs.length,
        actualNetworkBridgesWithScopeCount: networkBridgesWithScopeSnap.docs.length,
        actualNetworkBridgesWithoutScopeField: networkBridgesWithoutScopeField,
      };

      if (!metaSnap.exists) {
        return NextResponse.json({ phase: "status", scope, prepared: false, diagnostics });
      }
      const meta = metaSnap.data();
      return NextResponse.json({ phase: "status", scope, prepared: true, ...meta, diagnostics });
    }

    // ============================================================
    // PHASE: analyze -- landelijke, ORS-vrije structuuranalyse. Ongewijzigd
    // t.o.v. de vorige versie; geen cache-effect, puur informatief.
    // ============================================================
    if (phase === "analyze") {
      const structure = await loadGraphStructure(db, datasetVersionId);
      if (!structure) {
        return NextResponse.json({ error: "Geen logicalNodes gevonden voor deze datasetVersionId." }, { status: 404 });
      }
      const { nodes, uf, componentSize, edgeCountByNode } = structure;

      const { strongGap, weakGap } = detectGapNodes(structure, gapComponentSizeThreshold);
      const strongCandidates = findCandidates(structure, strongGap, candidateRadiusM, maxCandidatesPerNode);
      const weakCandidates = findCandidates(structure, weakGap, candidateRadiusM, maxCandidatesPerNode);

      const strongGapWithCandidate = new Set(strongCandidates.map((c) => c.sourceNodeId));
      const weakGapWithCandidate = new Set(weakCandidates.map((c) => c.sourceNodeId));
      const strongGapIds = [...strongGap].map((i) => nodes[i].id);
      const weakGapIds = [...weakGap].map((i) => nodes[i].id);
      const weakGapComponentSizes = [...weakGap].map((i) => componentSize.get(uf.find(i)) || 1).sort((a, b) => a - b);

      return NextResponse.json({
        phase: "analyze",
        datasetVersionId,
        candidateRadiusM,
        maxCandidatesPerNode,
        gapComponentSizeThreshold,
        totalLogicalNodes: nodes.length,
        edgeCountBuckets: {
          zero: strongGap.size,
          one: nodes.filter((n) => (edgeCountByNode.get(n.id) || 0) === 1).length,
          twoPlus: nodes.filter((n) => (edgeCountByNode.get(n.id) || 0) >= 2).length,
        },
        isolatedNodes: {
          total: strongGap.size,
          withCandidate: strongGapIds.filter((id) => strongGapWithCandidate.has(id)).length,
          withoutCandidate: strongGapIds.filter((id) => !strongGapWithCandidate.has(id)).length,
          candidatePairsFound: strongCandidates.length,
          directionalOrsCallsRequired: strongCandidates.length * 2,
        },
        weakGapNodes: {
          total: weakGap.size,
          componentSizeStats: weakGapComponentSizes.length
            ? { min: weakGapComponentSizes[0], median: median(weakGapComponentSizes), max: weakGapComponentSizes[weakGapComponentSizes.length - 1] }
            : null,
          withCandidate: weakGapIds.filter((id) => weakGapWithCandidate.has(id)).length,
          withoutCandidate: weakGapIds.filter((id) => !weakGapWithCandidate.has(id)).length,
          candidatePairsFound: weakCandidates.length,
          directionalOrsCallsRequired: weakCandidates.length * 2,
        },
        orsCallsMade: 0,
        nextStep: "Roep phase=prepare&scope=strong aan om te starten (aanbevolen volgorde: eerst strong, pas daarna weak).",
      });
    }

    // ============================================================
    // PHASE: prepare -- berekent EENMALIG de deterministische, richtinggevoelige
    // kandidatenlijst voor één scope en cachet die gechunkt. Geen ORS-calls.
    // ============================================================
    if (phase === "prepare") {
      const scope = req.nextUrl.searchParams.get("scope") as Scope | null;
      if (scope !== "strong" && scope !== "weak") {
        return NextResponse.json({ error: "scope is verplicht en moet 'strong' of 'weak' zijn." }, { status: 400 });
      }

      const structure = await loadGraphStructure(db, datasetVersionId);
      if (!structure) {
        return NextResponse.json({ error: "Geen logicalNodes gevonden voor deze datasetVersionId." }, { status: 404 });
      }
      const { strongGap, weakGap } = detectGapNodes(structure, gapComponentSizeThreshold);
      const gapSet = scope === "strong" ? strongGap : weakGap;

      const pairs = findCandidates(structure, gapSet, candidateRadiusM, maxCandidatesPerNode);
      const directional = toDirectionalCandidates(datasetVersionId, pairs);

      const chunks: DirectionalCandidate[][] = [];
      for (let i = 0; i < directional.length; i += CANDIDATE_CACHE_CHUNK_SIZE) {
        chunks.push(directional.slice(i, i + CANDIDATE_CACHE_CHUNK_SIZE));
      }
      for (let i = 0; i < chunks.length; i++) {
        await db
          .collection(CANDIDATE_CACHE_COLLECTION)
          .doc(`${datasetVersionId}_${scope}_chunk${i}`)
          .set({ datasetVersionId, scope, chunkIndex: i, items: chunks[i] });
      }
      await candidateMetaRef(db, datasetVersionId, scope).set({
        datasetVersionId,
        scope,
        gapNodesInScope: gapSet.size,
        candidatePairsFound: pairs.length,
        totalDirectionalItems: directional.length,
        chunkCount: chunks.length,
        processedCount: 0,
        status: directional.length === 0 ? "complete" : "candidates_ready",
        preparedAt: new Date().toISOString(),
      });

      const suggestedBatches = Math.ceil(directional.length / MAX_TOTAL_ORS_CALLS_PER_RUN);

      return NextResponse.json({
        phase: "prepare",
        datasetVersionId,
        scope,
        gapNodesInScope: gapSet.size,
        candidatePairsFound: pairs.length,
        totalDirectionalItems: directional.length,
        maxBatchSize: MAX_TOTAL_ORS_CALLS_PER_RUN,
        suggestedBatches,
        nextStep:
          directional.length === 0
            ? "Geen kandidaten voor deze scope -- niets te doen."
            : `Roep nu ${suggestedBatches}x phase=compute-batch&scope=${scope} aan, met batchOffset=0, ${MAX_TOTAL_ORS_CALLS_PER_RUN}, ${2 * MAX_TOTAL_ORS_CALLS_PER_RUN}, ... totdat status "complete" is.`,
      });
    }

    // ============================================================
    // PHASE: compute-batch -- verwerkt een deterministische slice van de
    // gecachete lijst. batchOffset MOET gelijk zijn aan processedCount (geen
    // gaten/sprongen). batchSize hard begrensd op MAX_TOTAL_ORS_CALLS_PER_RUN.
    // ============================================================
    if (phase === "compute-batch") {
      const scope = req.nextUrl.searchParams.get("scope") as Scope | null;
      if (scope !== "strong" && scope !== "weak") {
        return NextResponse.json({ error: "scope is verplicht en moet 'strong' of 'weak' zijn." }, { status: 400 });
      }
      const batchOffset = parseInt(req.nextUrl.searchParams.get("batchOffset") || "-1", 10);
      if (batchOffset < 0) {
        return NextResponse.json({ error: "batchOffset is verplicht (0 of hoger)." }, { status: 400 });
      }
      // batchSize is nu een BOVENGRENS, geen doel -- het tijdsbudget (FUNCTION_TIME_BUDGET_MS)
      // bepaalt in de praktijk hoeveel items daadwerkelijk verwerkt worden (5-9-2026, n.a.v.
      // Vercel Hobby's harde 10s-limiet). batchProcessed in de response kan dus kleiner zijn
      // dan de gevraagde batchSize -- dat is verwacht gedrag, geen fout.
      const requestedBatchSize = parseInt(req.nextUrl.searchParams.get("batchSize") || String(MAX_TOTAL_ORS_CALLS_PER_RUN), 10);
      const batchSize = Math.min(requestedBatchSize, MAX_TOTAL_ORS_CALLS_PER_RUN);

      const metaRef = candidateMetaRef(db, datasetVersionId, scope);
      const metaSnap = await metaRef.get();
      if (!metaSnap.exists) {
        return NextResponse.json({ error: `Geen kandidatenlijst gevonden voor scope=${scope}. Roep eerst phase=prepare aan.` }, { status: 400 });
      }
      const meta = metaSnap.data() as {
        totalDirectionalItems: number;
        chunkCount: number;
        processedCount: number;
        status: string;
      };

      if (meta.status === "complete") {
        return NextResponse.json({
          phase: "compute-batch",
          scope,
          status: "complete",
          processedCount: meta.processedCount,
          totalDirectionalItems: meta.totalDirectionalItems,
          message: "Al volledig verwerkt -- niets te doen. Roep phase=write aan.",
        });
      }

      if (batchOffset !== meta.processedCount) {
        return NextResponse.json(
          {
            error: `batchOffset (${batchOffset}) komt niet overeen met het al-verwerkte aantal (${meta.processedCount}). ` +
              `Batches moeten strikt opeenvolgend zijn, geen gaten of sprongen. Gebruik batchOffset=${meta.processedCount}.`,
            expectedBatchOffset: meta.processedCount,
          },
          { status: 409 }
        );
      }

      const requestedSlice = Math.min(batchSize, meta.totalDirectionalItems - meta.processedCount);

      let router: LocalBikeRouter;
      try {
        router = new LocalBikeRouter(new OpenRouteServiceAdapter());
      } catch (err) {
        return NextResponse.json(
          {
            error: "ORS niet geconfigureerd -- compute-batch kan niet valideren zonder een werkende ORS-verbinding.",
            details: err instanceof Error ? err.message : String(err),
          },
          { status: 503 }
        );
      }

      // Slice ophalen: kan over chunk-grenzen heen lopen, dus lees alle relevante chunks.
      const startChunk = Math.floor(batchOffset / CANDIDATE_CACHE_CHUNK_SIZE);
      const endChunk = Math.floor((batchOffset + requestedSlice - 1) / CANDIDATE_CACHE_CHUNK_SIZE);
      let pool: DirectionalCandidate[] = [];
      for (let c = startChunk; c <= endChunk && c < meta.chunkCount; c++) {
        const chunkSnap = await db.collection(CANDIDATE_CACHE_COLLECTION).doc(`${datasetVersionId}_${scope}_chunk${c}`).get();
        const chunkData = chunkSnap.data() as { items: DirectionalCandidate[] } | undefined;
        if (chunkData) pool = pool.concat(chunkData.items);
      }
      const localOffset = batchOffset - startChunk * CANDIDATE_CACHE_CHUNK_SIZE;
      const slice = pool.slice(localOffset, localOffset + requestedSlice);

      // Gerichte node-lookup i.p.v. de volledige graph herladen (5-9-2026 performance-fix,
      // noodzakelijk gegeven het krappe tijdsbudget): Firestore "in"-query, max. 30 ID's per
      // call, dus in stukken van 30 opgehaald.
      const neededIds = [...new Set(slice.flatMap((c) => [c.sourceNodeId, c.targetNodeId]))];
      const nodeById = new Map<string, { lat: number; lon: number }>();
      for (let i = 0; i < neededIds.length; i += 30) {
        const idBatch = neededIds.slice(i, i + 30);
        const snap = await db
          .collection("logicalNodes")
          .where(FirebaseFirestore.FieldPath.documentId(), "in", idBatch)
          .get();
        for (const doc of snap.docs) {
          const d = doc.data();
          nodeById.set(doc.id, rdToWgs84(d.x, d.y));
        }
      }

      const batchStartTime = Date.now();
      const nowIso = new Date().toISOString();
      const results: StoredAttempt[] = [];
      let consecutiveProviderErrors = 0;
      let stoppedEarly: string | null = null;

      for (const c of slice) {
        if (Date.now() - batchStartTime > FUNCTION_TIME_BUDGET_MS) {
          stoppedEarly = `Tijdsbudget (${FUNCTION_TIME_BUDGET_MS}ms) bereikt -- veilig gestopt vóór de Vercel Hobby 10s-limiet.`;
          break;
        }

        const from = nodeById.get(c.sourceNodeId);
        const to = nodeById.get(c.targetNodeId);
        if (!from || !to) {
          results.push({
            ...c,
            datasetVersionId,
            scope,
            validationStatus: "rejected_provider_error",
            rejectionReason: "Node-coördinaten niet gevonden bij compute-batch (mogelijk dataset gewijzigd sinds prepare).",
            distanceM: null,
            durationS: null,
            circuityRatio: null,
            geometry: null,
            validatedAt: nowIso,
          });
          continue;
        }

        if (results.length > 0) await sleep(ORS_CALL_DELAY_MS); // proactieve rate-limit-preventie tussen calls

        const outcome = await routeWithRetry(router, from, to);

        if (!outcome.ok) {
          results.push({
            ...c,
            datasetVersionId,
            scope,
            validationStatus: outcome.validationStatus,
            rejectionReason: outcome.rejectionReason,
            distanceM: null,
            durationS: null,
            circuityRatio: null,
            geometry: null,
            validatedAt: nowIso,
          });
          consecutiveProviderErrors = outcome.validationStatus === "rejected_provider_error" ? consecutiveProviderErrors + 1 : 0;
          if (consecutiveProviderErrors >= 2) {
            stoppedEarly = "2 opeenvolgende provider-fouten (na retries) -- batch veilig afgebroken, ORS lijkt structureel niet bereikbaar. Probeer later opnieuw.";
            break;
          }
          continue;
        }

        consecutiveProviderErrors = 0;
        const { validationStatus, rejectionReason, circuityRatio } = classifyBridgeAttempt(outcome.distanceM, c.geographicDistanceM);
        results.push({
          ...c,
          datasetVersionId,
          scope,
          validationStatus,
          rejectionReason,
          distanceM: Math.round(outcome.distanceM),
          durationS: Math.round(outcome.durationS),
          circuityRatio,
          geometry: outcome.geometry,
          validatedAt: nowIso,
        });
      }

      // Elk resultaat als eigen document -- geen read-modify-write op een groeiende array.
      for (let i = 0; i < results.length; i += FIRESTORE_OP_LIMIT) {
        const batch = db.batch();
        for (const r of results.slice(i, i + FIRESTORE_OP_LIMIT)) {
          batch.set(db.collection(ATTEMPTS_COLLECTION).doc(r.id), r);
        }
        await batch.commit();
      }

      const newProcessedCount = meta.processedCount + results.length;
      const newStatus = newProcessedCount >= meta.totalDirectionalItems ? "complete" : "processing";
      await metaRef.update({ processedCount: newProcessedCount, status: newStatus, lastBatchAt: nowIso });

      return NextResponse.json({
        phase: "compute-batch",
        scope,
        batchOffset,
        batchProcessed: results.length,
        stoppedEarly,
        batchValidCount: results.filter((r) => r.validationStatus === "valid").length,
        batchRejectedBreakdown: {
          rejected_no_route: results.filter((r) => r.validationStatus === "rejected_no_route").length,
          rejected_distance: results.filter((r) => r.validationStatus === "rejected_distance").length,
          rejected_circuity: results.filter((r) => r.validationStatus === "rejected_circuity").length,
          rejected_provider_error: results.filter((r) => r.validationStatus === "rejected_provider_error").length,
        },
        processedCount: newProcessedCount,
        totalDirectionalItems: meta.totalDirectionalItems,
        status: newStatus,
        nextStep:
          newStatus === "complete"
            ? "Alle kandidaten verwerkt. Roep phase=write aan om de resultaten naar networkBridges te schrijven."
            : `Roep opnieuw phase=compute-batch&scope=${scope}&batchOffset=${newProcessedCount} aan.`,
      });
    }

    // ============================================================
    // PHASE: reset -- wist candidate-cache, attempts EN al-geschreven
    // networkBridges-documenten voor één scope. Toegevoegd 5-9-2026 n.a.v. het
    // rate-limit-incident: de eerste strong-scope-run bevatte overwegend
    // valse "rejected_no_route"-resultaten (in werkelijkheid 429-fouten) en
    // moet volledig opnieuw, niet hergebruikt worden.
    // ============================================================
    if (phase === "reset") {
      const scope = req.nextUrl.searchParams.get("scope") as Scope | null;
      if (scope !== "strong" && scope !== "weak") {
        return NextResponse.json({ error: "scope is verplicht en moet 'strong' of 'weak' zijn." }, { status: 400 });
      }
      const confirm = req.nextUrl.searchParams.get("confirm");
      if (confirm !== "yes") {
        return NextResponse.json(
          { error: "Dit verwijdert alle candidate-cache, attempts EN geschreven networkBridges voor deze scope. Voeg &confirm=yes toe om te bevestigen." },
          { status: 400 }
        );
      }

      let deleted = 0;

      const metaRef = candidateMetaRef(db, datasetVersionId, scope);
      const metaSnap = await metaRef.get();
      const meta = metaSnap.exists ? (metaSnap.data() as { chunkCount: number }) : null;
      if (meta) {
        for (let c = 0; c < meta.chunkCount; c++) {
          await db.collection(CANDIDATE_CACHE_COLLECTION).doc(`${datasetVersionId}_${scope}_chunk${c}`).delete();
        }
        await metaRef.delete();
      }

      const attemptsSnap = await db.collection(ATTEMPTS_COLLECTION).where("datasetVersionId", "==", datasetVersionId).where("scope", "==", scope).get();
      for (let i = 0; i < attemptsSnap.docs.length; i += FIRESTORE_OP_LIMIT) {
        const batch = db.batch();
        for (const doc of attemptsSnap.docs.slice(i, i + FIRESTORE_OP_LIMIT)) batch.delete(doc.ref);
        await batch.commit();
        deleted += Math.min(FIRESTORE_OP_LIMIT, attemptsSnap.docs.length - i);
      }

      const bridgesSnap = await db.collection("networkBridges").where("datasetVersionId", "==", datasetVersionId).where("scope", "==", scope).get();
      for (let i = 0; i < bridgesSnap.docs.length; i += FIRESTORE_OP_LIMIT) {
        const batch = db.batch();
        for (const doc of bridgesSnap.docs.slice(i, i + FIRESTORE_OP_LIMIT)) batch.delete(doc.ref);
        await batch.commit();
      }

      return NextResponse.json({
        phase: "reset",
        scope,
        deletedAttempts: attemptsSnap.docs.length,
        deletedNetworkBridges: bridgesSnap.docs.length,
        candidateCacheCleared: !!meta,
        nextStep: "Roep nu phase=prepare opnieuw aan om schoon te herstarten.",
      });
    }

    // ============================================================
    // PHASE: write -- alleen toegestaan wanneer status "complete" is.
    // ============================================================
    if (phase === "write") {
      const scope = req.nextUrl.searchParams.get("scope") as Scope | null;
      if (scope !== "strong" && scope !== "weak") {
        return NextResponse.json({ error: "scope is verplicht en moet 'strong' of 'weak' zijn." }, { status: 400 });
      }

      const metaRef = candidateMetaRef(db, datasetVersionId, scope);
      const metaSnap = await metaRef.get();
      if (!metaSnap.exists) {
        return NextResponse.json({ error: `Geen kandidatenlijst gevonden voor scope=${scope}. Roep eerst phase=prepare aan.` }, { status: 400 });
      }
      const meta = metaSnap.data() as { totalDirectionalItems: number; processedCount: number; status: string };

      if (meta.status !== "complete") {
        return NextResponse.json(
          {
            error:
              `Write geblokkeerd: scope=${scope} is nog niet compleet ` +
              `(${meta.processedCount}/${meta.totalDirectionalItems} verwerkt, status="${meta.status}"). ` +
              "Rond alle compute-batch-aanroepen af voordat er geschreven wordt.",
          },
          { status: 409 }
        );
      }

      const attemptsSnap = await db
        .collection(ATTEMPTS_COLLECTION)
        .where("datasetVersionId", "==", datasetVersionId)
        .where("scope", "==", scope)
        .get();

      const nowIso = new Date().toISOString();
      const docs = attemptsSnap.docs;
      for (let i = 0; i < docs.length; i += FIRESTORE_OP_LIMIT) {
        const batch = db.batch();
        for (const doc of docs.slice(i, i + FIRESTORE_OP_LIMIT)) {
          const a = doc.data() as StoredAttempt;
          const bridge: NetworkBridge = {
            id: a.id,
            datasetVersionId,
            scope,
            sourceNodeId: a.sourceNodeId,
            targetNodeId: a.targetNodeId,
            distanceM: a.distanceM ?? 0,
            durationS: a.durationS ?? 0,
            geometry: a.geometry ?? [],
            routingProvider: "openrouteservice",
            routingProfile: "cycling",
            circuityRatio: a.circuityRatio ?? 0,
            validationStatus: a.validationStatus,
            rejectionReason: a.rejectionReason,
            sourceComponentSizeAtCreation: a.sourceComponentSize,
            targetComponentSizeAtCreation: a.targetComponentSize,
            createdAt: nowIso,
          };
          batch.set(db.collection("networkBridges").doc(a.id), bridge);
        }
        await batch.commit();
      }

      await metaRef.update({ status: "written", writtenAt: nowIso });

      return NextResponse.json({
        phase: "write",
        scope,
        written: docs.length,
        validCount: docs.filter((d) => (d.data() as StoredAttempt).validationStatus === "valid").length,
      });
    }

    return NextResponse.json({ error: `Onbekende phase "${phase}". Gebruik status, analyze, prepare, compute-batch, write, of reset.` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { error: "Bridge-generatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
