import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";
import type { NetworkBridge, NetworkBridgeValidationStatus, BridgeCandidate } from "@/lib/route-engine/network-bridge-types";
import { classifyBridgeAttempt } from "@/lib/route-engine/bridge-validation-thresholds";

export const maxDuration = 60;

/**
 * GET /api/import/generate-bridges — Network Bridge Layer-generator.
 * Implementatieplan: docs/network-bridge-layer-plan.md (§4-§8, §13, §17).
 * Two-phase patroon, zelfde als match-edges/route.ts: phase=compute (rapport +
 * cache, incl. de daadwerkelijke ORS-validatie), dan phase=write (persisteert
 * de gevalideerde bridges naar `networkBridges`).
 *
 * BELANGRIJK — bridges zijn DIRECTIONEEL (plan §2, gecorrigeerd na de
 * 24-richtingentest): voor elk candidate-paar (source, target) worden BEIDE
 * richtingen apart gevalideerd via ORS en apart opgeslagen. Geen aanname dat
 * A->B ook B->A impliceert.
 */

// ---- Harde server-side caps (plan §17 — query-parameters kunnen deze alleen VERLAGEN, nooit verhogen) ----
const MAX_CANDIDATES_PER_NODE_HARD_CAP = 3;
const MAX_BRIDGE_CANDIDATE_RADIUS_M_HARD_CAP = 3000;
const MAX_TOTAL_ORS_CALLS_PER_RUN = 200;

// ---- Kwaliteitsdrempels (plan §7): zie lib/route-engine/bridge-validation-thresholds.ts
//      (single source of truth, ook gebruikt door de unit tests) ----

// ---- Gap-detection (plan §4, bijgesteld: componentSize is secundair signaal, geen foutclassificatie) ----
const DEFAULT_GAP_COMPONENT_SIZE_THRESHOLD = 50;

const CACHE_COLLECTION = "generateBridgesCache";

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

type LNode = { id: string; x: number; y: number; displayNumber?: string };

/** Eén ORS-validatiepoging in één richting -- wordt 1-op-1 een NetworkBridge-doc. */
type BridgeAttempt = {
  id: string; // `${datasetVersionId}_${sourceNodeId}_${targetNodeId}`
  sourceNodeId: string;
  targetNodeId: string;
  geographicDistanceM: number;
  sourceComponentSize: number;
  targetComponentSize: number;
  validationStatus: NetworkBridgeValidationStatus;
  rejectionReason: string | null;
  distanceM: number | null;
  durationS: number | null;
  circuityRatio: number | null;
  geometry: { lat: number; lon: number }[] | null;
};

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
  const phase = req.nextUrl.searchParams.get("phase") || "compute";

  // Query-parameters kunnen de harde caps alleen VERLAGEN, nooit verhogen (plan §17).
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
    const cacheRef = db.collection(CACHE_COLLECTION).doc(datasetVersionId);

    if (phase === "compute") {
      let router: LocalBikeRouter;
      try {
        router = new LocalBikeRouter(new OpenRouteServiceAdapter());
      } catch (err) {
        return NextResponse.json(
          {
            error: "ORS niet geconfigureerd -- generate-bridges kan niet valideren zonder een werkende ORS-verbinding.",
            details: err instanceof Error ? err.message : String(err),
          },
          { status: 503 }
        );
      }

      const [logicalNodesSnap, matchedEdgesSnap] = await Promise.all([
        db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
        db.collection("edges").where("datasetVersionId", "==", datasetVersionId).where("matchConfidence", "==", "matched").get(),
      ]);

      if (logicalNodesSnap.empty) {
        return NextResponse.json({ error: "Geen logicalNodes gevonden voor deze datasetVersionId." }, { status: 404 });
      }

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

      // Gap-detection (plan §4, bijgesteld): edgeCount<=1 is het PRIMAIRE signaal.
      // componentSize<threshold is een SECUNDAIR signaal -- apart geteld, niet
      // blind samengevoegd, zodat zichtbaar is hoeveel elk signaal oplevert
      // vóórdat er ook maar één ORS-call gedaan wordt.
      const gapByEdgeCount = new Set<number>();
      const gapByComponentSize = new Set<number>();
      for (let i = 0; i < nodes.length; i++) {
        const edgeCount = edgeCountByNode.get(nodes[i].id) || 0;
        if (edgeCount <= 1) gapByEdgeCount.add(i);
        const size = componentSize.get(uf.find(i)) || 1;
        if (size < gapComponentSizeThreshold) gapByComponentSize.add(i);
      }
      const gapNodeIndices = new Set<number>([...gapByEdgeCount, ...gapByComponentSize]);

      // ---- Kandidaatselectie (plan §5) ----
      const candidates: BridgeCandidate[] = [];
      for (const i of gapNodeIndices) {
        const node = nodes[i];
        const root = uf.find(i);
        const nodeComponentSize = componentSize.get(root) || 1;
        const radiusSq = candidateRadiusM * candidateRadiusM;

        const nearby = nodes
          .map((n, j) => {
            if (j === i) return null;
            const otherRoot = uf.find(j);
            if (otherRoot === root) return null; // zelfde component, geen bridge nodig
            const otherSize = componentSize.get(otherRoot) || 1;
            if (otherSize <= nodeComponentSize) return null; // moet richting grotere component wijzen (plan §5)
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

      // ---- ORS-validatie, BEIDE richtingen per candidate-paar (plan §2/§6) ----
      const nodeById = new Map(nodes.map((n) => [n.id, n]));
      const attempts: BridgeAttempt[] = [];
      let orsCallCount = 0;
      let partial = false;

      outer: for (const candidate of candidates) {
        const sourceNode = nodeById.get(candidate.sourceNodeId)!;
        const targetNode = nodeById.get(candidate.targetNodeId)!;
        const sourceWgs = rdToWgs84(sourceNode.x, sourceNode.y);
        const targetWgs = rdToWgs84(targetNode.x, targetNode.y);

        const directions: { sourceId: string; targetId: string; from: typeof sourceWgs; to: typeof targetWgs; sourceCompSize: number; targetCompSize: number }[] = [
          { sourceId: candidate.sourceNodeId, targetId: candidate.targetNodeId, from: sourceWgs, to: targetWgs, sourceCompSize: candidate.sourceComponentSize, targetCompSize: candidate.targetComponentSize },
          { sourceId: candidate.targetNodeId, targetId: candidate.sourceNodeId, from: targetWgs, to: sourceWgs, sourceCompSize: candidate.targetComponentSize, targetCompSize: candidate.sourceComponentSize },
        ];

        for (const dir of directions) {
          if (orsCallCount >= MAX_TOTAL_ORS_CALLS_PER_RUN) {
            partial = true;
            break outer;
          }
          orsCallCount++;

          const id = `${datasetVersionId}_${dir.sourceId}_${dir.targetId}`;
          const orsResult = await router.route({ lat: dir.from.lat, lon: dir.from.lon }, { lat: dir.to.lat, lon: dir.to.lon }, "cycling");

          if ("reason" in orsResult) {
            attempts.push({
              id,
              sourceNodeId: dir.sourceId,
              targetNodeId: dir.targetId,
              geographicDistanceM: candidate.geographicDistanceM,
              sourceComponentSize: dir.sourceCompSize,
              targetComponentSize: dir.targetCompSize,
              validationStatus: "rejected_no_route",
              rejectionReason: `ORS: ${orsResult.reason}${orsResult.message ? ` (${orsResult.message})` : ""}`,
              distanceM: null,
              durationS: null,
              circuityRatio: null,
              geometry: null,
            });
            continue;
          }

          const { validationStatus, rejectionReason, circuityRatio } = classifyBridgeAttempt(orsResult.distanceM, candidate.geographicDistanceM);

          attempts.push({
            id,
            sourceNodeId: dir.sourceId,
            targetNodeId: dir.targetId,
            geographicDistanceM: candidate.geographicDistanceM,
            sourceComponentSize: dir.sourceCompSize,
            targetComponentSize: dir.targetCompSize,
            validationStatus,
            rejectionReason,
            distanceM: Math.round(orsResult.distanceM),
            durationS: Math.round(orsResult.durationS),
            circuityRatio,
            geometry: orsResult.geometry,
          });
        }
      }

      const report = {
        totalLogicalNodes: nodes.length,
        gapNodesByEdgeCountSignal: gapByEdgeCount.size,
        gapNodesByComponentSizeSignal: gapByComponentSize.size,
        gapNodesTotal: gapNodeIndices.size,
        candidatePairsFound: candidates.length,
        orsCallsMade: orsCallCount,
        attemptsTotal: attempts.length,
        validCount: attempts.filter((a) => a.validationStatus === "valid").length,
        rejectedCount: attempts.filter((a) => a.validationStatus !== "valid").length,
        rejectedBreakdown: {
          rejected_no_route: attempts.filter((a) => a.validationStatus === "rejected_no_route").length,
          rejected_distance: attempts.filter((a) => a.validationStatus === "rejected_distance").length,
          rejected_circuity: attempts.filter((a) => a.validationStatus === "rejected_circuity").length,
        },
        partial,
      };

      // Gecorrigeerd (GPT 5-9-2026, plan-update): bij partial=true wordt de
      // write-fase HARD geblokkeerd -- geen halve bridge-set die er compleet
      // uitziet voor de rest van de pipeline. `phase=write` checkt dit hieronder.
      await cacheRef.set({
        datasetVersionId,
        computedAt: new Date().toISOString(),
        report,
        attempts,
      });

      return NextResponse.json({
        phase: "compute",
        datasetVersionId,
        report,
        nextStep: partial
          ? "partial=true: ORS-call-limiet bereikt vóórdat alle kandidaten verwerkt waren. Write-fase is GEBLOKKEERD. Verhoog MAX_TOTAL_ORS_CALLS_PER_RUN of verklein de scope (bv. gapComponentSizeThreshold) en draai compute opnieuw."
          : "Roep nu phase=write aan om de gevalideerde bridges naar networkBridges weg te schrijven.",
      });
    }

    // phase === "write"
    const cacheSnap = await cacheRef.get();
    if (!cacheSnap.exists) {
      return NextResponse.json({ error: "Geen cache gevonden. Roep eerst phase=compute aan." }, { status: 400 });
    }
    const cached = cacheSnap.data() as { report: { partial: boolean }; attempts: BridgeAttempt[] };

    if (cached.report.partial) {
      return NextResponse.json(
        {
          error:
            "Write geblokkeerd: de laatste compute-run was partial (ORS-call-limiet bereikt vóór volledige verwerking). " +
            "Draai phase=compute opnieuw met een hogere limiet of kleinere scope totdat partial=false, voordat er geschreven wordt.",
        },
        { status: 409 }
      );
    }

    const FIRESTORE_OP_LIMIT = 450;
    const nowIso = new Date().toISOString();
    for (let i = 0; i < cached.attempts.length; i += FIRESTORE_OP_LIMIT) {
      const chunk = cached.attempts.slice(i, i + FIRESTORE_OP_LIMIT);
      const batch = db.batch();
      for (const a of chunk) {
        const bridge: NetworkBridge = {
          id: a.id,
          datasetVersionId,
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

    return NextResponse.json({
      phase: "write",
      datasetVersionId,
      written: cached.attempts.length,
      report: cached.report,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Bridge-generatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
