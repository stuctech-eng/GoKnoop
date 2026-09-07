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
 * Levert UITSLUITEND knooppunten, GEEN verbindingen (7-9-2026, op verzoek:
 * "de rechte lijnen moeten weg, alleen de echte paden" -- de eerdere
 * rechte-lijn-vereenvoudiging bleek op straatniveau te grof/misleidend). De
 * daadwerkelijke, gedetailleerde padgeometrie komt nu uitsluitend van
 * /api/network/detailed-edges, per zichtbaar kaartgebied, zodra ver genoeg is
 * ingezoomd. Een GEKOZEN route (NavigationScreen.tsx) blijft ongewijzigd de
 * volledige geometrie gebruiken.
 *
 * Response is bewust compact (arrays i.p.v. objects met herhaalde keys) --
 * scheelt merkbaar bij ~11.000 knooppunten, ook na gzip. `Cache-Control`
 * staat aan: dit netwerk verandert alleen bij een nieuwe dataset-import,
 * niet per gebruikersactie.
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

    return NextResponse.json(
      { nodes, datasetVersionId },
      { headers: { "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400" } }
    );
  } catch (err) {
    return NextResponse.json(
      { error: "Netwerk-overzicht laden mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
