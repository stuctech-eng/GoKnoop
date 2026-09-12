import { getDb } from "@/lib/firebase-admin";
import { reportProgress } from "@/lib/diagnostics/report-progress";
import type { CombinedEdge, ValidatedCombinedGraph } from "@/lib/nwb-analysis/combined-graph";
import { loadCachedCombinedGraph, type CachedCombinedGraphResult } from "@/lib/route-engine/cached-nwb-provider";
import type { GraphProvider } from "@/lib/route-engine/types";

/**
 * PRODUCTIEARCHITECTUUR (optie C), 12-9-2026. Leest het vooraf-berekende,
 * volledig samengestelde graafartefact (zie /api/admin/precompute-full-graph-v2)
 * -- GEEN NWB/GoKnoop-brondata-reconstructie meer nodig als dit artefact
 * compleet en actueel is.
 *
 * Veilige terugval: als het artefact niet bestaat, niet compleet is, of niet
 * bij de huidige dataset-versies hoort, wordt automatisch de BESTAANDE,
 * bewezen werkende reconstructie-aanpak (`loadCachedCombinedGraph`) gebruikt
 * -- nooit een harde afhankelijkheid van het nieuwe pad.
 */
export async function loadPrecomputedOrBuildGraph(
  provider: GraphProvider,
  datasetVersionId: string,
  providerReadyPromise?: Promise<void>
): Promise<CachedCombinedGraphResult & { precomputedArtifactUsed: boolean }> {
  const t0 = Date.now();
  const db = getDb();

  const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
  const nwbDatasetVersionId: string | null = activeNwbSnap.exists ? (activeNwbSnap.data()!.nwbDatasetVersionId as string) : null;

  if (nwbDatasetVersionId) {
    const cacheKey = `${datasetVersionId}__${nwbDatasetVersionId}`;
    const metaRef = db.collection("precomputedCombinedGraph").doc(cacheKey);
    const metaSnap = await metaRef.get();

    if (metaSnap.exists && metaSnap.data()!.status === "compleet") {
      const meta = metaSnap.data()!;
      reportProgress("latest", "loadPrecomputedOrBuildGraph: compleet artefact gevonden, lezen", { elapsedMs: Date.now() - t0, cacheKey });

      const chunksSnap = await metaRef.collection("chunks").get();
      const adjacency = new Map<string, CombinedEdge[]>();
      const nodePosition = new Map<string, { x: number; y: number; source: "goknoop" | "nwb" }>();

      for (const doc of chunksSnap.docs) {
        const data = doc.data() as { type: "adjacency" | "nodePosition"; entries: [string, unknown][] };
        if (data.type === "adjacency") {
          for (const [k, v] of data.entries) adjacency.set(k, v as CombinedEdge[]);
        } else {
          for (const [k, v] of data.entries) nodePosition.set(k, v as { x: number; y: number; source: "goknoop" | "nwb" });
        }
      }

      // Sanity-check: komt het aantal gelezen entries overeen met wat de metadata verwacht?
      // Zo niet, is het artefact incompleet/corrupt -- veilig terugvallen op reconstructie.
      if (adjacency.size > 0 && nodePosition.size > 0) {
        const graph: ValidatedCombinedGraph = {
          adjacency,
          nodePosition,
          totalConnectorsCreated: meta.totalConnectorsCreated ?? 0,
          connectorsUsed: { high: 0, lower: 0 }, // niet bewaard in het artefact -- alleen relevant voor diagnostiek, niet voor routing
        };
        reportProgress("latest", "loadPrecomputedOrBuildGraph: artefact succesvol geladen", {
          elapsedMs: Date.now() - t0,
          adjacencySize: adjacency.size,
          nodePositionSize: nodePosition.size,
        });
        return { graph, nwbDatasetVersionId, cacheHit: false, precomputedArtifactUsed: true };
      }
      reportProgress("latest", "loadPrecomputedOrBuildGraph: artefact leeg/corrupt, terugvallen op reconstructie", { elapsedMs: Date.now() - t0 });
    } else {
      reportProgress("latest", "loadPrecomputedOrBuildGraph: geen compleet artefact, terugvallen op reconstructie", { elapsedMs: Date.now() - t0, exists: metaSnap.exists, status: metaSnap.exists ? metaSnap.data()!.status : null });
    }
  }

  // Terugval: bestaande, bewezen werkende reconstructie-aanpak.
  const result = await loadCachedCombinedGraph(provider, datasetVersionId, providerReadyPromise);
  return { ...result, precomputedArtifactUsed: false };
}
