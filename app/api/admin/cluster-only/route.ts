import { NextRequest, NextResponse } from "next/server";
import { computeNwbClusterAssignments, type SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

type StoredSegment = SlimNwbSegment & { fromClusterId?: string; toClusterId?: string };

/**
 * POST /api/admin/cluster-only
 * Body: { segments: StoredSegment[] } -- MET hun opgeslagen fromClusterId/toClusterId.
 *
 * Fase 1+2 van het uitvoeringsplan, 11-9-2026, HERZIEN: eerste versie stuurde
 * de volledige, verse toewijzingenlijst (114k entries) terug als JSON --
 * dat serialiseren bovenop de clustering zelf overschreed de 10s-limiet
 * (live bevestigd). Nu VOLLEDIG SERVER-SIDE: berekent vers, vergelijkt
 * INTERN tegen de MEEGEGEVEN opgeslagen cluster-ID's (bijectie-check, niet
 * letterlijke labels -- die zijn willekeurig tussen twee onafhankelijke
 * union-find-runs), en stuurt alleen de COMPACTE SAMENVATTING terug.
 */
export async function POST(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: { segments?: StoredSegment[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ongeldige JSON-body." }, { status: 400 });
  }
  const storedSegments = body.segments;
  if (!storedSegments || !Array.isArray(storedSegments)) {
    return NextResponse.json({ error: "segments (array) is verplicht." }, { status: 400 });
  }

  const t0 = Date.now();
  try {
    // Vers clusteren -- de MEEGEGEVEN fromClusterId/toClusterId worden hier NIET gebruikt
    // (computeNwbClusterAssignments kijkt alleen naar id/from/to/lengthM/bstCode/wegnummer).
    const computed = await computeNwbClusterAssignments(storedSegments, CONNECTOR_SEARCH_TOLERANCE_M);
    const computeTimeMs = Date.now() - t0;

    const computedUniqueClusters = new Set<string>();
    for (const a of computed.values()) {
      computedUniqueClusters.add(a.fromClusterId);
      computedUniqueClusters.add(a.toClusterId);
    }

    // Bijectie-check: elke opgeslagen cluster-ID moet naar PRECIES ÉÉN berekende
    // cluster-ID wijzen, en vice versa. Zo niet, is de groepering daadwerkelijk anders.
    const storedToComputedFrom = new Map<string, Set<string>>();
    const computedToStoredFrom = new Map<string, Set<string>>();
    const storedToComputedTo = new Map<string, Set<string>>();
    const computedToStoredTo = new Map<string, Set<string>>();

    let totalCompared = 0;
    let missingComputed = 0;
    const storedUniqueClusters = new Set<string>();

    for (const seg of storedSegments) {
      const comp = computed.get(seg.id);
      if (!comp) {
        missingComputed++;
        continue;
      }
      if (!seg.fromClusterId || !seg.toClusterId) continue;
      totalCompared++;
      storedUniqueClusters.add(seg.fromClusterId);
      storedUniqueClusters.add(seg.toClusterId);

      if (!storedToComputedFrom.has(seg.fromClusterId)) storedToComputedFrom.set(seg.fromClusterId, new Set());
      storedToComputedFrom.get(seg.fromClusterId)!.add(comp.fromClusterId);
      if (!computedToStoredFrom.has(comp.fromClusterId)) computedToStoredFrom.set(comp.fromClusterId, new Set());
      computedToStoredFrom.get(comp.fromClusterId)!.add(seg.fromClusterId);

      if (!storedToComputedTo.has(seg.toClusterId)) storedToComputedTo.set(seg.toClusterId, new Set());
      storedToComputedTo.get(seg.toClusterId)!.add(comp.toClusterId);
      if (!computedToStoredTo.has(comp.toClusterId)) computedToStoredTo.set(comp.toClusterId, new Set());
      computedToStoredTo.get(comp.toClusterId)!.add(seg.toClusterId);
    }

    function countNonBijective(map: Map<string, Set<string>>): number {
      let count = 0;
      for (const set of map.values()) if (set.size > 1) count++;
      return count;
    }
    function firstExamples(map: Map<string, Set<string>>, limit: number): { key: string; values: string[] }[] {
      const out: { key: string; values: string[] }[] = [];
      for (const [k, set] of map) {
        if (set.size > 1) {
          out.push({ key: k, values: Array.from(set) });
          if (out.length >= limit) break;
        }
      }
      return out;
    }

    const storedFromSplits = countNonBijective(storedToComputedFrom);
    const computedFromSplits = countNonBijective(computedToStoredFrom);
    const storedToSplits = countNonBijective(storedToComputedTo);
    const computedToSplits = countNonBijective(computedToStoredTo);

    const isEquivalent = storedFromSplits === 0 && computedFromSplits === 0 && storedToSplits === 0 && computedToSplits === 0;

    return NextResponse.json({
      segmentCount: storedSegments.length,
      pointCount: computed.size * 2,
      computeTimeMs,
      totalCompared,
      missingComputed,
      storedUniqueClusterCount: storedUniqueClusters.size,
      computedUniqueClusterCount: computedUniqueClusters.size,
      bijectieCheck: {
        isEquivalent,
        storedFromSplitsIntoMultipleComputed: storedFromSplits,
        computedFromSplitsIntoMultipleStored: computedFromSplits,
        storedToSplitsIntoMultipleComputed: storedToSplits,
        computedToSplitsIntoMultipleStored: computedToSplits,
      },
      exactMatchPercentage: totalCompared > 0 ? Math.round(((totalCompared - storedFromSplits - storedToSplits) / totalCompared) * 10000) / 100 : null,
      differenceExamples: {
        storedFromSplitsIntoMultipleComputed: firstExamples(storedToComputedFrom, 10),
        computedFromSplitsIntoMultipleStored: firstExamples(computedToStoredFrom, 10),
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Clustering-vergelijking mislukt.", details: err instanceof Error ? err.message : String(err), computeTimeMs: Date.now() - t0 },
      { status: 502 }
    );
  }
}
