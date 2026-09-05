import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import { LocalBikeRouter } from "@/lib/local-bike-router/local-bike-router";
import { OpenRouteServiceAdapter } from "@/lib/local-bike-router/open-route-service-adapter";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/bridge-validator
 *
 * GPT-voorstel (sessie 5-9-2026, "Network Bridge Layer"): voordat er ook maar
 * één regel bridge-architectuur gebouwd wordt, eerst bewijzen dat ORS
 * daadwerkelijk een valide fietsverbinding vindt tussen de bekende
 * structurele-gap-knopen en het hoofdnetwerk. Drie stappen (GPT):
 *   1. componenten bepalen (Union-Find over matched edges)
 *   2. per probleemknoop de dichtstbijzijnde knopen in een ANDER component zoeken
 *   3. alleen die kandidaten aan ORS voorleggen (niet alle 11.000 onderling)
 *
 * Query params:
 *   key              — DEBUG_SECRET
 *   datasetVersionId — optioneel, default: config/activeDataset
 *   nodeIds          — comma-separated logicalNodeId's om te testen
 *                       (default: de 4 bekende structurele-gap-knopen + knooppunt 5)
 *   candidateRadiusM — max. zoekradius voor kandidaten (default 3000)
 *   maxCandidates    — max. aantal kandidaten per probleemknoop (default 3)
 *
 * BELANGRIJK: roept ORS aan via de bestaande LocalBikeRouter/OpenRouteServiceAdapter
 * (nooit een eigen fetch naar ORS) -- respecteert de architectuurregel dat de app
 * nergens rechtstreeks van ORS afhankelijk mag zijn (lib/local-bike-router/types.ts).
 * OPENROUTESERVICE_API_KEY was op 30-8-2026 nog niet geconfigureerd volgens de
 * adapter-documentatie -- deze route vangt die situatie expliciet op i.p.v. te crashen.
 */

const DEFAULT_NODE_IDS = [
  "CJSXBPUMG49vOPmYvhJd", // knooppunt 5, Amsterdam Centraal (1 edge -- de Buiksloterweg-patch zelf)
  "pR2n6KWgtHLRPwvkUmZ8", // NDSM-eiland-node (0 edges)
  "MlD0oYfflMtqblDgqoaf", // 0-edge node bij De Ruijterkade
  "sPSiwXQwlcY7dacptKvS", // 0-edge node bij De Ruijterkade
];

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

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const nodeIdsParam = req.nextUrl.searchParams.get("nodeIds");
  const targetNodeIds = nodeIdsParam ? nodeIdsParam.split(",") : DEFAULT_NODE_IDS;
  const candidateRadiusM = parseFloat(req.nextUrl.searchParams.get("candidateRadiusM") || "3000");
  const maxCandidates = parseInt(req.nextUrl.searchParams.get("maxCandidates") || "3", 10);

  // ORS-beschikbaarheid vooraf checken -- expliciete melding i.p.v. losse crashes verderop.
  let router: LocalBikeRouter | null = null;
  let orsUnavailableReason: string | null = null;
  try {
    router = new LocalBikeRouter(new OpenRouteServiceAdapter());
  } catch (err) {
    orsUnavailableReason = err instanceof Error ? err.message : String(err);
  }

  try {
    const db = getDb();

    let datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
    if (!datasetVersionId) {
      const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
      if (!activeDatasetSnap.exists) {
        return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
      }
      datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;
    }

    const [logicalNodesSnap, matchedEdgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db.collection("edges").where("datasetVersionId", "==", datasetVersionId).where("matchConfidence", "==", "matched").get(),
    ]);

    type LNode = { id: string; x: number; y: number; displayNumber?: string };
    const nodes: LNode[] = logicalNodesSnap.docs.map((d) => {
      const data = d.data();
      return { id: d.id, x: data.x, y: data.y, displayNumber: data.displayNumber };
    });
    const idToIndex = new Map<string, number>();
    nodes.forEach((n, i) => idToIndex.set(n.id, i));

    const uf = new UnionFind(nodes.length);
    for (const doc of matchedEdgesSnap.docs) {
      const d = doc.data();
      const fromIdx = idToIndex.get(d.fromLogicalNodeId);
      const toIdx = idToIndex.get(d.toLogicalNodeId);
      if (fromIdx !== undefined && toIdx !== undefined) uf.union(fromIdx, toIdx);
    }

    // Componentgrootte per root, om "bridge naar het hoofdnetwerk" te kunnen onderscheiden
    // van "bridge naar een ander klein eilandje".
    const componentSize = new Map<number, number>();
    for (let i = 0; i < nodes.length; i++) {
      const root = uf.find(i);
      componentSize.set(root, (componentSize.get(root) || 0) + 1);
    }

    const results = [];

    for (const targetId of targetNodeIds) {
      const targetIdx = idToIndex.get(targetId);
      if (targetIdx === undefined) {
        results.push({ nodeId: targetId, error: "Knoop niet gevonden in logicalNodes voor deze dataset." });
        continue;
      }
      const target = nodes[targetIdx];
      const targetRoot = uf.find(targetIdx);
      const targetComponentSize = componentSize.get(targetRoot) || 1;

      // Kandidaten: dichtstbijzijnde knopen binnen radius, in een ANDER component,
      // bij voorkeur naar het grootste beschikbare component (het "hoofdnetwerk").
      const candidateRadiusSq = candidateRadiusM * candidateRadiusM;
      const candidates = nodes
        .map((n, i) => {
          if (i === targetIdx) return null;
          const root = uf.find(i);
          if (root === targetRoot) return null; // zelfde component, geen bridge nodig
          const dx = n.x - target.x;
          const dy = n.y - target.y;
          const distSq = dx * dx + dy * dy;
          if (distSq > candidateRadiusSq) return null;
          return { node: n, distanceM: Math.sqrt(distSq), otherComponentSize: componentSize.get(root) || 1 };
        })
        .filter((c): c is { node: LNode; distanceM: number; otherComponentSize: number } => c !== null)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, maxCandidates);

      const targetWgs = rdToWgs84(target.x, target.y);

      const candidateResults = [];
      for (const c of candidates) {
        const candidateWgs = rdToWgs84(c.node.x, c.node.y);

        if (!router) {
          candidateResults.push({
            candidateNodeId: c.node.id,
            candidateDisplayNumber: c.node.displayNumber ?? null,
            geographicDistanceM: Math.round(c.distanceM),
            otherComponentSize: c.otherComponentSize,
            ors: { validated: false, reason: "ors_unavailable", message: orsUnavailableReason },
          });
          continue;
        }

        const orsResult = await router.route(
          { lat: targetWgs.lat, lon: targetWgs.lon },
          { lat: candidateWgs.lat, lon: candidateWgs.lon },
          "cycling"
        );

        if ("reason" in orsResult) {
          candidateResults.push({
            candidateNodeId: c.node.id,
            candidateDisplayNumber: c.node.displayNumber ?? null,
            geographicDistanceM: Math.round(c.distanceM),
            otherComponentSize: c.otherComponentSize,
            ors: { validated: false, reason: orsResult.reason, message: orsResult.message },
          });
        } else {
          const ratio = orsResult.distanceM / c.distanceM;
          candidateResults.push({
            candidateNodeId: c.node.id,
            candidateDisplayNumber: c.node.displayNumber ?? null,
            geographicDistanceM: Math.round(c.distanceM),
            otherComponentSize: c.otherComponentSize,
            ors: {
              validated: true,
              orsDistanceM: Math.round(orsResult.distanceM),
              orsDurationS: Math.round(orsResult.durationS),
              ratioOrsVsGeographic: Number(ratio.toFixed(2)),
              plausible: ratio >= 0.8 && ratio <= 5,
            },
          });
        }
      }

      results.push({
        nodeId: targetId,
        displayNumber: target.displayNumber ?? null,
        componentSize: targetComponentSize,
        candidatesFound: candidates.length,
        candidates: candidateResults,
      });
    }

    return NextResponse.json({
      datasetVersionId,
      orsConfigured: router !== null,
      orsUnavailableReason,
      totalLogicalNodes: nodes.length,
      results,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Bridge-validatie mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
