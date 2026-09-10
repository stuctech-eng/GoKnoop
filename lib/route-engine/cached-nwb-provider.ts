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
 *
 * FASE M6/M7 (opslagformaat-fix), 10-9-2026: live productiemeting toonde
 * dat het Firestore-uitlezen van de ~144k LOSSE NWB-segment-documenten zelf
 * al ~29s zou kosten (lineair geëxtrapoleerd uit een 2000-documenten-steek-
 * proef, 401ms) -- ruim boven de 10s-limiet, los van alles daarna
 * (bevestigd: een geïsoleerde test van alleen graafopbouw gaf een harde
 * 504 FUNCTION_INVOCATION_TIMEOUT). NWB-segmenten worden nu in GEBATCHTE
 * documenten gelezen (`nwbSegments/{id}/batches/{n}`, ~500 segmenten per
 * document) i.p.v. één document per segment -- ~288 documenten i.p.v.
 * 144.000, dezelfde totale databytes maar drastisch minder per-document-
 * overhead.
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
    // Gebatchte documenten: elk document bevat een ARRAY van ~500 segmenten,
    // niet één document per segment (zie module-commentaar hierboven).
    const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      nwbSegments.push(...data.segments);
    }

    const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
    const connectorsSnap = await db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").get();
    validatedConnectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);
  }

  const graph = buildValidatedCombinedGraph(provider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors);
  moduleCache.set(cacheKey, { graph, nwbDatasetVersionId, loadedAt: Date.now() });

  return { graph, nwbDatasetVersionId, cacheHit: false };
}
