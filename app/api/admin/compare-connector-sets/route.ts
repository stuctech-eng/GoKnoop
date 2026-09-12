import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import { CachedGraphProvider } from "@/lib/route-engine/cached-graph-provider";
import type { ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/compare-connector-sets?datasetVersionId=...&oldNwbId=...&newNwbId=...
 *
 * Performance-audit sectie 7, 12-9-2026. Valideert de nieuwe 3171-
 * connectorenset ONAFHANKELIJK van de dure graafopbouw -- leest alleen de
 * (kleine) connector-documenten zelf, GEEN NWB-segmenten, GEEN GoKnoop-
 * edges, GEEN buildValidatedCombinedGraph. Dit blijft ruim binnen budget
 * omdat connector-documenten zelf klein zijn (goknoopNodeId, nwbSegmentId,
 * nwbEndpoint, distanceM, confidence -- geen geometrie).
 *
 * Controleert:
 * - duplicate connectoren (zelfde goknoopNodeId+nwbSegmentId+nwbEndpoint)
 * - endpoint-geldigheid (nwbEndpoint is "from" of "to", niets anders)
 * - referenties naar bestaande GoKnoop-nodes (via provider.getNode(), GEEN
 *   edges nodig, dus goedkoop)
 * - directe vergelijking: is de oude 1178-set een deelverzameling van de
 *   nieuwe 3171-set (op goknoopNodeId+nwbSegmentId+nwbEndpoint)?
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId") ?? "uINZ3y2QsgBdEyky3duq";
  const oldNwbId = req.nextUrl.searchParams.get("oldNwbId") ?? "nwb-2026-09-10-v2-gebatcht";
  const newNwbId = req.nextUrl.searchParams.get("newNwbId") ?? "nwb-2026-09-11-v2-gebatcht";

  try {
    const db = getDb();

    const [oldSnap, newSnap] = await Promise.all([
      db.collection("nwbConnectors").doc(`${oldNwbId}_${datasetVersionId}`).collection("connectors").get(),
      db.collection("nwbConnectors").doc(`${newNwbId}_${datasetVersionId}`).collection("connectors").get(),
    ]);

    const oldConnectors = oldSnap.docs.map((d) => d.data() as ValidatedConnectorInput);
    const newConnectors = newSnap.docs.map((d) => d.data() as ValidatedConnectorInput);

    function tripleKey(c: ValidatedConnectorInput): string {
      return `${c.goknoopNodeId}|${c.nwbSegmentId}|${c.nwbEndpoint}`;
    }

    // Duplicaten binnen de nieuwe set.
    const newKeySeen = new Map<string, number>();
    for (const c of newConnectors) {
      const k = tripleKey(c);
      newKeySeen.set(k, (newKeySeen.get(k) ?? 0) + 1);
    }
    const duplicateKeys = Array.from(newKeySeen.entries()).filter(([, count]) => count > 1);

    // Endpoint-geldigheid.
    const invalidEndpoints = newConnectors.filter((c) => c.nwbEndpoint !== "from" && c.nwbEndpoint !== "to");

    // GoKnoop-node-referenties bestaan (goedkoop: alleen node-lookup, geen edges/geometrie).
    const provider = new CachedGraphProvider(datasetVersionId);
    await provider.load();
    const uniqueGoknoopNodeIds = new Set(newConnectors.map((c) => c.goknoopNodeId));
    const missingGoknoopNodes = Array.from(uniqueGoknoopNodeIds).filter((id) => !provider.getNode(id));

    // Directe vergelijking: is de oude (bewezen) set een deelverzameling van de nieuwe?
    const newKeySet = new Set(newConnectors.map(tripleKey));
    const oldNotInNew = oldConnectors.filter((c) => !newKeySet.has(tripleKey(c)));
    const oldInNewCount = oldConnectors.length - oldNotInNew.length;

    // Confidence- en afstandsverdeling van de NIEUWE, extra connectoren (die niet in de oude set zaten).
    const oldKeySet = new Set(oldConnectors.map(tripleKey));
    const newOnly = newConnectors.filter((c) => !oldKeySet.has(tripleKey(c)));
    const newOnlyByConfidence = { high: newOnly.filter((c) => c.confidence === "high").length, lower: newOnly.filter((c) => c.confidence === "lower").length };
    const newOnlyDistances = newOnly.map((c) => c.distanceM);
    const newOnlyDistanceStats = newOnlyDistances.length
      ? {
          min: Math.min(...newOnlyDistances),
          max: Math.max(...newOnlyDistances),
          gemiddeld: Math.round((newOnlyDistances.reduce((a, b) => a + b, 0) / newOnlyDistances.length) * 100) / 100,
        }
      : null;

    return NextResponse.json({
      oude: { nwbDatasetVersionId: oldNwbId, aantal: oldConnectors.length },
      nieuwe: { nwbDatasetVersionId: newNwbId, aantal: newConnectors.length },
      structuurControles: {
        duplicateKeysInNieuw: duplicateKeys.length,
        duplicateVoorbeelden: duplicateKeys.slice(0, 5).map(([k, count]) => ({ key: k, count })),
        ongeldigeEndpoints: invalidEndpoints.length,
        ontbrekendeGoknoopNodes: missingGoknoopNodes.length,
        ontbrekendeGoknoopNodeVoorbeelden: missingGoknoopNodes.slice(0, 10),
      },
      vergelijkingMetBewezenSet: {
        oudeConnectorenNogAanwezigInNieuwe: oldInNewCount,
        oudeConnectorenNietMeerAanwezig: oldNotInNew.length,
        oudeSetIsVolledigeDeelverzameling: oldNotInNew.length === 0,
        voorbeeldenOntbrekend: oldNotInNew.slice(0, 10).map((c) => ({ goknoopNodeId: c.goknoopNodeId, nwbSegmentId: c.nwbSegmentId, nwbEndpoint: c.nwbEndpoint })),
      },
      nieuweConnectorenAnalyse: {
        aantal: newOnly.length,
        perConfidence: newOnlyByConfidence,
        afstandsverdeling: newOnlyDistanceStats,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Vergelijking mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
