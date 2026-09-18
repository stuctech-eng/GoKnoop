import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { loadCachedCombinedGraph } from "@/lib/route-engine/cached-nwb-provider";
import { computeConnectedComponents } from "@/lib/nwb-analysis/combined-graph";
import { computeCombinedRoute } from "@/lib/route-engine/combined-route-engine";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * TOEGEVOEGD 18-9-2026 (GO van Te): puur forensisch/read-only. Vervolg op de
 * vaste-paar-vergelijking (graph-forensics), die aantoonde dat graafopbouw +
 * Dijkstra deterministisch zijn voor het bekende Volendam-95/Amsterdam-
 * Centraal-paar. Deze test gaat een laag dieper: niet het bekende vaste paar,
 * maar de DAADWERKELIJKE 5+5 geocoding-kandidaten die de echte adres-flow
 * vandaag opleverde voor "Volendam" -> "Hoorn"/"Amsterdam" (Volendam-kant
 * identiek in alle eerdere tests) en "Amsterdam" -> "Hilversum" (Amsterdam-
 * kant identiek in alle eerdere tests) -- rechtstreeks uit de gekopieerde
 * JSON-uitkomsten van eerder vandaag overgenomen, niet opnieuw gegokt.
 *
 * Bouwt de graaf ÉÉN keer (bypassCache, hetzelfde reconstructiepad als de
 * productie-aanvragen vandaag daadwerkelijk gebruikten), en test daarna alle
 * 25 paren met precies dezelfde functie die de kandidatenlus zelf in Fase 1
 * gebruikt (`computeCombinedRoute`) -- dus dit is geen nieuwe berekening,
 * maar exact dezelfde bouwsteen, nu voor elk paar apart zichtbaar gemaakt.
 *
 * GET /api/debug/candidate-matrix?key=<DEBUG_SECRET>
 */
const VOLENDAM_CANDIDATES = ["4TebNUQu8QVISxRNzj72", "Ftnx3y50A5GLhBNbMlFv", "6UayfCpdiEFTeoS3R1fr", "eJpWsoRSTaxORDta26U1", "9HFYXOYND204Mbw9zDjT"];
const AMSTERDAM_CANDIDATES = ["CJSXBPUMG49vOPmYvhJd", "bvMw2fsQTTyeJMUfX6wX", "FmigRklKKPsXEPrDsrIb", "4dtfleeX25UH7UYrDWqt", "T0bJ8pzXCKuiDlZ39Jcw"];

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("key");
  if (key !== process.env.DEBUG_SECRET) {
    return NextResponse.json({ error: "Ongeldige of ontbrekende sleutel." }, { status: 401 });
  }

  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    const providerLoadPromise = provider.load();
    await providerLoadPromise;
    const { graph } = await loadCachedCombinedGraph(provider, datasetVersionId, providerLoadPromise, { bypassCache: true });

    // Component-lidmaatschap ÉÉN keer berekend, hergebruikt voor alle 25 paren --
    // puur een efficiëntiemaatregel, verandert niets aan wat er gemeten wordt.
    const components = computeConnectedComponents(graph);
    const componentOf = (nodeId: string) => components.componentOfNode.get(nodeId) ?? null;
    const componentSizeCache = new Map<string, number>();
    const componentSize = (root: string | null) => {
      if (!root) return null;
      if (componentSizeCache.has(root)) return componentSizeCache.get(root)!;
      let count = 0;
      for (const r of components.componentOfNode.values()) if (r === root) count++;
      componentSizeCache.set(root, count);
      return count;
    };

    const results: Record<string, unknown>[] = [];
    const matrix: string[][] = [];

    for (let oi = 0; oi < VOLENDAM_CANDIDATES.length; oi++) {
      const fromNodeId = VOLENDAM_CANDIDATES[oi];
      const row: string[] = [];
      for (let di = 0; di < AMSTERDAM_CANDIDATES.length; di++) {
        const toNodeId = AMSTERDAM_CANDIDATES[di];
        const fromComponent = componentOf(fromNodeId);
        const toComponent = componentOf(toNodeId);
        const sameComponent = fromComponent !== null && fromComponent === toComponent;

        const dijkstra = computeCombinedRoute(graph, fromNodeId, toNodeId);

        let symbol: string;
        let reason: string;
        if (dijkstra.ok) {
          symbol = "✅";
          reason = "geaccepteerd";
        } else if (dijkstra.reason === "node_not_found") {
          symbol = "❔";
          reason = "knooppunt niet gevonden in dataset";
        } else if (dijkstra.reason === "disconnected") {
          symbol = "❌";
          reason = "niet verbonden (Dijkstra found:false)";
        } else {
          symbol = "⚠️";
          reason = `verbonden maar afgewezen: ${dijkstra.message}`;
        }
        row.push(symbol);

        results.push({
          originIndex: oi,
          destinationIndex: di,
          fromNodeId,
          toNodeId,
          fromComponent,
          toComponent,
          fromComponentSize: componentSize(fromComponent),
          toComponentSize: componentSize(toComponent),
          sameComponent,
          symbol,
          reason,
          distanceM: dijkstra.ok ? dijkstra.distanceM : undefined,
          deviationFactor: dijkstra.ok ? dijkstra.quality.deviationFactor : undefined,
          quality: dijkstra.ok ? dijkstra.quality : "quality" in dijkstra ? dijkstra.quality : undefined,
        });
      }
      matrix.push(row);
    }

    const succeeded = results.filter((r) => r.symbol === "✅");
    const best = succeeded.length > 0 ? succeeded.reduce((a, b) => ((a.distanceM as number) <= (b.distanceM as number) ? a : b)) : null;

    return NextResponse.json({
      datasetVersionId,
      volendamCandidates: VOLENDAM_CANDIDATES,
      amsterdamCandidates: AMSTERDAM_CANDIDATES,
      matrix, // rij = Volendam-kandidaat (index 0-4), kolom = Amsterdam-kandidaat (index 0-4)
      aantalBruikbaar: succeeded.length,
      aantalTotaal: results.length,
      besteResultaat: best,
      volledigeResultaten: results,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
