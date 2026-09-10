import { getDb } from "@/lib/firebase-admin";
import { buildValidatedCombinedGraph, type CombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";
import type { GraphProvider } from "./types";

/**
 * Fase K (performance), 9-9-2026 -- HERZIENE VERSIE.
 *
 * EERSTE POGING (verworpen door productiemeting): cachte alleen de RUWE NWB-
 * segmenten/connectoren. Productiedata toonde dat computeTimeMs (gemeten
 * strikt NA het laden van data, rond het bouwen van de graaf + Dijkstra)
 * nauwelijks veranderde tussen cache hit en miss (~5000-5700ms in beide
 * gevallen) -- het cachen van de ruwe data loste dus niet het echte probleem
 * op. Root cause (herzien): de VOLLEDIGE gecombineerde graaf (NWB-clustering
 * via union-find over ~144k segmenten, GoKnoop-edges toevoegen, connectoren
 * verwerken) werd bij ELKE aanvraag opnieuw gebouwd, ook al waren de ruwe
 * data al in het geheugen.
 *
 * DEZE VERSIE cachet de AL-GEBOUWDE CombinedGraph zelf (adjacency +
 * nodePosition -- de daadwerkelijk dure output), niet de ruwe invoer. Een
 * warme aanvraag hoeft nu alleen nog Dijkstra te draaien, geen enkele
 * hernieuwde clustering.
 */

type CachedGraphEntry = {
  graph: CombinedGraph;
  nwbDatasetVersionId: string | null;
  loadedAt: number;
};

const moduleCache = new Map<string, CachedGraphEntry>();

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

export type CachedCombinedGraphResult = { graph: CombinedGraph; nwbDatasetVersionId: string | null; cacheHit: boolean };

export function clearGraphCache(): number {
  const size = moduleCache.size;
  moduleCache.clear();
  return size;
}

export async function loadCachedCombinedGraph(provider: GraphProvider, datasetVersionId: string): Promise<CachedCombinedGraphResult> {
  const db = getDb();

  const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
  const nwbDatasetVersionId: string | null = activeNwbSnap.exists ? (activeNwbSnap.data()!.nwbDatasetVersionId as string) : null;

  const cacheKey = `${datasetVersionId}__${nwbDatasetVersionId ?? "none"}`;
  const cached = moduleCache.get(cacheKey);
  if (cached) {
    return { graph: cached.graph, nwbDatasetVersionId: cached.nwbDatasetVersionId, cacheHit: true };
  }

  let nwbSegments: SlimNwbSegment[] = [];
  let validatedConnectors: ValidatedConnectorInput[] = [];
  if (nwbDatasetVersionId) {
    const segmentsSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("segments").get();
    nwbSegments = segmentsSnap.docs.map((d) => d.data() as SlimNwbSegment);

    const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
    const connectorsSnap = await db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").get();
    validatedConnectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);
  }

  const graph = buildValidatedCombinedGraph(provider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors);
  moduleCache.set(cacheKey, { graph, nwbDatasetVersionId, loadedAt: Date.now() });

  return { graph, nwbDatasetVersionId, cacheHit: false };
}
