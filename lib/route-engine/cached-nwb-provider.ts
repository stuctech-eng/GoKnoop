import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment, ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

/**
 * Fase K (performance), 9-9-2026. Exact hetzelfde patroon als
 * cached-graph-provider.ts voor GoKnoop -- module-niveau in-memory cache,
 * hergebruikt zolang de serverless-instance warm blijft.
 *
 * WAAROM DIT NODIG WAS: Fase J-productiemetingen toonden computeTimeMs van
 * 5.047-5.867ms per aanvraag. Oorzaak: /api/route/combined las de ~144.000
 * NWB-segment-documenten bij ELKE aanvraag opnieuw uit Firestore, zonder
 * enige caching -- in schril contrast met GoKnoop, dat al sinds Phase 2
 * gecached wordt. Dit lost exact dat verschil op, geen ander gedrag.
 */

type CachedNwbData = {
  nwbDatasetVersionId: string;
  segments: SlimNwbSegment[];
  connectors: ValidatedConnectorInput[];
  loadedAt: number;
};

const moduleCache = new Map<string, CachedNwbData>();

export type NwbDataLoadResult = { nwbDatasetVersionId: string | null; segments: SlimNwbSegment[]; connectors: ValidatedConnectorInput[]; cacheHit: boolean };

export async function loadCachedNwbData(datasetVersionId: string): Promise<NwbDataLoadResult> {
  const db = getDb();

  const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
  if (!activeNwbSnap.exists) {
    return { nwbDatasetVersionId: null, segments: [], connectors: [], cacheHit: false };
  }
  const nwbDatasetVersionId = activeNwbSnap.data()!.nwbDatasetVersionId as string;
  const cacheKey = `${nwbDatasetVersionId}_${datasetVersionId}`;

  const cached = moduleCache.get(cacheKey);
  if (cached) {
    return { nwbDatasetVersionId, segments: cached.segments, connectors: cached.connectors, cacheHit: true };
  }

  const segmentsSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("segments").get();
  const segments = segmentsSnap.docs.map((d) => d.data() as SlimNwbSegment);

  const connectorsSnap = await db.collection("nwbConnectors").doc(cacheKey).collection("connectors").get();
  const connectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);

  moduleCache.set(cacheKey, { nwbDatasetVersionId, segments, connectors, loadedAt: Date.now() });

  return { nwbDatasetVersionId, segments, connectors, cacheHit: false };
}
