import { NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import { rdToWgs84 } from "@/lib/route-engine/coordinate-transform";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/network/overview
 *
 * Levert het VOLLEDIGE, landelijke knooppuntennetwerk voor kaartweergave --
 * op verzoek 7-9-2026 ("GoKnoop kan zelf een kaart van het knooppuntennetwerk
 * opbouwen uit eigen data, i.p.v. afhankelijk te zijn van MapLibre/CARTO
 * daarvoor"). Al voorzien maar bewust uitgesteld, zie GOKNOOP-MASTER.md:
 * "Knooppunten-op-Home bewust NIET gebouwd -- vereist een geheel nieuwe
 * databehoefte, expliciet als apart, later traject afgesproken."
 *
 * BEWUSTE VEREENVOUDIGING: verbindingen worden als RECHTE LIJN tussen de twee
 * knooppunt-eindpunten geleverd, NIET de volledige, gedetailleerde
 * brongeometrie (die kan honderden punten per edge bevatten -- op landelijk
 * zoomniveau visueel niet te onderscheiden van een rechte lijn, wel een
 * veelvoud aan databytes). Dit is uitsluitend voor dit landelijke overzicht;
 * een GEKOZEN route (NavigationScreen.tsx) blijft de volledige,
 * gedetailleerde geometrie gebruiken, dat verandert hier niet.
 *
 * Response is bewust compact (arrays i.p.v. objects met herhaalde keys) --
 * scheelt merkbaar bij ~11.000 knooppunten + ~28.000 verbindingen, ook na
 * gzip. `Cache-Control` staat aan: dit netwerk verandert alleen bij een
 * nieuwe dataset-import, niet per gebruikersactie.
 */
export async function GET() {
  try {
    const db = getDb();
    const activeDatasetSnap = await db.collection("config").doc("activeDataset").get();
    if (!activeDatasetSnap.exists) {
      return NextResponse.json({ error: "Geen actieve dataset geconfigureerd." }, { status: 500 });
    }
    const datasetVersionId = activeDatasetSnap.data()!.datasetVersionId as string;

    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();

    const allNodeIds = provider.getAllNodeIds();

    // Knooppunten: [lat, lon, displayNumber, edgeCount]. edgeCount toegevoegd
    // (7-9-2026, op verzoek: geïsoleerde knopen visueel onderscheiden op de
    // kaart, i.p.v. alleen via een aparte debug-tool zichtbaar).
    const nodes: [number, number, string, number][] = [];
    for (const id of allNodeIds) {
      const n = provider.getNode(id);
      if (!n) continue;
      const { lat, lon } = rdToWgs84(n.x, n.y);
      nodes.push([lat, lon, n.displayNumber ?? "?", provider.getEdgesFrom(id).length]);
    }

    // Verbindingen: [fromLat, fromLon, toLat, toLon] -- gededupliceerd op edge-ID
    // (elke edge komt 2x voor, eenmaal per eindpunt-index in de provider).
    const seenEdgeIds = new Set<string>();
    const edges: [number, number, number, number][] = [];
    for (const id of allNodeIds) {
      for (const edge of provider.getEdgesFrom(id)) {
        if (seenEdgeIds.has(edge.id)) continue;
        seenEdgeIds.add(edge.id);
        const from = provider.getNode(edge.fromLogicalNodeId);
        const to = provider.getNode(edge.toLogicalNodeId);
        if (!from || !to) continue;
        const fromWgs = rdToWgs84(from.x, from.y);
        const toWgs = rdToWgs84(to.x, to.y);
        edges.push([fromWgs.lat, fromWgs.lon, toWgs.lat, toWgs.lon]);
      }
    }

    return NextResponse.json(
      { nodes, edges, datasetVersionId },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Netwerk-overzicht laden mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
