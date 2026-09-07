import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { RijrichtingExcludedGraphProvider } from "@/lib/route-engine/rijrichting-excluded-graph-provider";
import { computeRoute } from "@/lib/route-engine/route-engine";
import { generateLoopRoutes } from "@/lib/route-engine/loop-route-generator";
import type { GraphProvider } from "@/lib/route-engine/types";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/rijrichting-impact-analysis
 *
 * Puur analytisch, GEEN wijziging aan isTraversable() of enige
 * productieroute (op uitdrukkelijk verzoek, 7-9-2026). Beantwoordt de 8
 * vragen uit het rijrichting-onderzoek (zie docs/GOKNOOP-MASTER.md sectie 2.1,
 * docs/phase1b-design.md sectie 4) puur op basis van de al-geïmporteerde
 * Firestore-graaf -- geen wijziging, geen Bridge Layer, geen isTraversable().
 *
 * Bekende testknopen (hergebruikt uit eerdere sessies vandaag, niet gegokt):
 * - Hilversum-test: Amsterdam Centraal (CJSXBPUMG49vOPmYvhJd) -> knooppunt 55
 *   Hilversum (ZYuO6ZfzSa2iim0HcUbn).
 * - Lochem-test: dezelfde 5 kandidaat-startpunten + target 20km als de
 *   loop-diagnose-tool vandaag al gebruikte.
 */

const HILVERSUM_FROM = "CJSXBPUMG49vOPmYvhJd"; // Amsterdam Centraal
const HILVERSUM_TO = "ZYuO6ZfzSa2iim0HcUbn"; // knooppunt 55, Hilversum
const LOCHEM_CANDIDATES = [
  "9cdQ8xUK4u2DFybtRTfg",
  "bR0u430Tm1qT6yHBUU4k",
  "CDdOFbRpdb959FzzPLc0",
  "DULwi9RMia4vV4Wbdc2a",
  "3rnbURpA3ImMOs940vR8",
];
const LOCHEM_TARGET_M = 20000;

class UnionFind {
  private parent = new Map<string, string>();
  add(id: string) {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }
  find(id: string): string {
    const p = this.parent.get(id);
    if (p === undefined) return id;
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

function componentStats(nodeIds: string[], edges: { fromLogicalNodeId: string; toLogicalNodeId: string }[]) {
  const uf = new UnionFind();
  for (const id of nodeIds) uf.add(id);
  for (const e of edges) uf.union(e.fromLogicalNodeId, e.toLogicalNodeId);

  const sizeByRoot = new Map<string, number>();
  for (const id of nodeIds) {
    const root = uf.find(id);
    sizeByRoot.set(root, (sizeByRoot.get(root) || 0) + 1);
  }
  const sizes = Array.from(sizeByRoot.values()).sort((a, b) => b - a);
  return {
    componentCount: sizeByRoot.size,
    largestComponentSize: sizes[0] ?? 0,
    largestComponentPercent: nodeIds.length ? (((sizes[0] ?? 0) / nodeIds.length) * 100).toFixed(1) : "0",
    isolatedNodeCount: sizes.filter((s) => s === 1).length,
    sameComponent: (a: string, b: string) => uf.find(a) === uf.find(b),
  };
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    // Graaf laden EN de ruwe rijrichting-waarde per edge-ID apart ophalen (die
    // zit niet in GraphEdge, zie rijrichting-excluded-graph-provider.ts) --
    // parallel, om de 10s-Vercel-limiet niet onnodig te belasten.
    const baseProvider = new CachedGraphProvider(datasetVersionId);
    const [, rijrichtingSnap] = await Promise.all([
      baseProvider.load(),
      db
        .collection("edges")
        .where("datasetVersionId", "==", datasetVersionId)
        .where("matchConfidence", "==", "matched")
        .select("rijrichting")
        .get(),
    ]);

    // Vraag 1: telling per rijrichting-waarde.
    const rijrichtingCounts: Record<string, number> = {};
    const excludedEdgeIds = new Set<string>();
    for (const doc of rijrichtingSnap.docs) {
      const rr = String(doc.data().rijrichting ?? "onbekend");
      rijrichtingCounts[rr] = (rijrichtingCounts[rr] || 0) + 1;
      if (rr === "2") excludedEdgeIds.add(doc.id);
    }

    const allNodeIds = baseProvider.getAllNodeIds();
    const allEdges = allNodeIds.flatMap((id) => baseProvider.getEdgesFrom(id));
    // Elke edge komt 2x voor (eenmaal per eindpunt-index) -- dedupliceren op ID
    // voor een eerlijke telling/component-analyse.
    const uniqueEdgesById = new Map<string, (typeof allEdges)[number]>();
    for (const e of allEdges) uniqueEdgesById.set(e.id, e);
    const uniqueEdges = Array.from(uniqueEdgesById.values());
    const filteredEdges = uniqueEdges.filter((e) => !excludedEdgeIds.has(e.id));

    // Vraag 6: connected components, baseline vs. analytisch-gefilterd.
    const baselineComponents = componentStats(allNodeIds, uniqueEdges);
    const filteredComponents = componentStats(allNodeIds, filteredEdges);

    // Vraag 7/8: specifieke, al bekende testcases opnieuw draaien op BEIDE
    // grafen (baseline = ongewijzigd, filtered = analytische decorator die
    // rijrichting=2-edges uitsluit -- puur simulatie, geen wijziging aan
    // isTraversable() of enige productieroute).
    const filteredProvider: GraphProvider = new RijrichtingExcludedGraphProvider(baseProvider, excludedEdgeIds);
    await filteredProvider.load();

    const hilversumBaseline = computeRoute(baseProvider, datasetVersionId, HILVERSUM_FROM, HILVERSUM_TO);
    const hilversumFiltered = computeRoute(filteredProvider, datasetVersionId, HILVERSUM_FROM, HILVERSUM_TO);

    const lochemBaseline = generateLoopRoutes(baseProvider, datasetVersionId, LOCHEM_CANDIDATES[3], LOCHEM_TARGET_M, {
      count: 4,
    });
    const lochemFiltered = generateLoopRoutes(filteredProvider, datasetVersionId, LOCHEM_CANDIDATES[3], LOCHEM_TARGET_M, {
      count: 4,
    });

    return NextResponse.json({
      vraag1_telling_per_rijrichting: rijrichtingCounts,
      vraag6_connected_components: {
        baseline: {
          componentCount: baselineComponents.componentCount,
          largestComponentSize: baselineComponents.largestComponentSize,
          largestComponentPercent: baselineComponents.largestComponentPercent,
          isolatedNodeCount: baselineComponents.isolatedNodeCount,
          totalEdges: uniqueEdges.length,
        },
        na_analytisch_uitsluiten_rijrichting2: {
          componentCount: filteredComponents.componentCount,
          largestComponentSize: filteredComponents.largestComponentSize,
          largestComponentPercent: filteredComponents.largestComponentPercent,
          isolatedNodeCount: filteredComponents.isolatedNodeCount,
          totalEdges: filteredEdges.length,
        },
        hilversumNodesZelfdeComponent: {
          baseline: baselineComponents.sameComponent(HILVERSUM_FROM, HILVERSUM_TO),
          filtered: filteredComponents.sameComponent(HILVERSUM_FROM, HILVERSUM_TO),
        },
      },
      vraag7_8_specifieke_routetests: {
        hilversum: {
          baseline: "distanceM" in hilversumBaseline ? { distanceM: hilversumBaseline.distanceM } : { fout: hilversumBaseline.reason },
          na_analytisch_uitsluiten_rijrichting2:
            "distanceM" in hilversumFiltered ? { distanceM: hilversumFiltered.distanceM } : { fout: hilversumFiltered.reason },
        },
        lochemRondje20km: {
          baseline: { foundCount: lochemBaseline.foundCount, diagnostics: lochemBaseline.diagnostics },
          na_analytisch_uitsluiten_rijrichting2: { foundCount: lochemFiltered.foundCount, diagnostics: lochemFiltered.diagnostics },
        },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Analyse mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
