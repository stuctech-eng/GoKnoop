import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";
import type { SlimNwbSegment } from "@/lib/nwb-analysis/combined-graph";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/measure-nwb-bytes?nwbDatasetVersionId=...
 *
 * Performance-audit sectie 3+4, 12-9-2026. Meet EXACT (niet geschat) hoeveel
 * bytes elk veld van SlimNwbSegment in beslag neemt, en hoeveel unieke
 * cluster-ID's er zijn t.o.v. hoe vaak ze herhaald worden. Alleen compacte
 * getallen worden teruggegeven -- nooit de ruwe data zelf.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const nwbDatasetVersionId = req.nextUrl.searchParams.get("nwbDatasetVersionId") ?? "nwb-2026-09-11-v2-gebatcht";

  try {
    const db = getDb();
    const batchesSnap = await db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").get();

    let totaalSegmenten = 0;
    let bytesId = 0;
    let bytesBstCode = 0;
    let bytesWegnummer = 0;
    let bytesStraatnaam = 0;
    let bytesFromTo = 0; // from.x + from.y + to.x + to.y, als getallen (8 bytes elk, IEEE754-schatting via JSON-representatie)
    let bytesLengthM = 0;
    let bytesFromClusterId = 0;
    let bytesToClusterId = 0;
    let bytesTotaalDocument = 0; // volledige JSON.stringify van elk segment, ter controle

    const uniqueClusterIds = new Set<string>();
    let clusterIdOccurrences = 0;
    let maxClusterIdLen = 0;
    let sumClusterIdLen = 0;

    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      for (const s of data.segments) {
        totaalSegmenten++;
        bytesId += Buffer.byteLength(s.id, "utf8");
        bytesBstCode += s.bstCode ? Buffer.byteLength(s.bstCode, "utf8") : 0;
        bytesWegnummer += s.wegnummer ? Buffer.byteLength(s.wegnummer, "utf8") : 0;
        bytesStraatnaam += s.straatnaam ? Buffer.byteLength(s.straatnaam, "utf8") : 0;
        bytesFromTo += JSON.stringify(s.from).length + JSON.stringify(s.to).length;
        bytesLengthM += String(s.lengthM).length;
        if (s.fromClusterId) {
          bytesFromClusterId += Buffer.byteLength(s.fromClusterId, "utf8");
          uniqueClusterIds.add(s.fromClusterId);
          clusterIdOccurrences++;
          maxClusterIdLen = Math.max(maxClusterIdLen, s.fromClusterId.length);
          sumClusterIdLen += s.fromClusterId.length;
        }
        if (s.toClusterId) {
          bytesToClusterId += Buffer.byteLength(s.toClusterId, "utf8");
          uniqueClusterIds.add(s.toClusterId);
          clusterIdOccurrences++;
          maxClusterIdLen = Math.max(maxClusterIdLen, s.toClusterId.length);
          sumClusterIdLen += s.toClusterId.length;
        }
        bytesTotaalDocument += Buffer.byteLength(JSON.stringify(s), "utf8");
      }
    }

    const gemiddeldeClusterIdLengte = clusterIdOccurrences > 0 ? sumClusterIdLen / clusterIdOccurrences : 0;
    // Alternatief: opeenvolgende integer-ID's (1, 2, 3, ...) i.p.v. UUID-achtige strings.
    // Aantal unieke clusters bepaalt hoeveel cijfers een integer-ID nodig heeft.
    const integerIdMaxDigits = String(uniqueClusterIds.size).length;
    const bytesFromClusterIdAlternatief = clusterIdOccurrences > 0 ? Math.round((clusterIdOccurrences / 2) * integerIdMaxDigits) : 0; // ruwe schatting: helft van occurrences is fromClusterId
    const bytesToClusterIdAlternatief = bytesFromClusterIdAlternatief;
    const besparingClusterIds = bytesFromClusterId + bytesToClusterId - bytesFromClusterIdAlternatief - bytesToClusterIdAlternatief;

    function mb(bytes: number) {
      return Math.round((bytes / 1024 / 1024) * 100) / 100;
    }
    function pct(bytes: number) {
      return Math.round((bytes / bytesTotaalDocument) * 10000) / 100;
    }

    return NextResponse.json({
      nwbDatasetVersionId,
      totaalSegmenten,
      totaleOmvang: { bytes: bytesTotaalDocument, MB: mb(bytesTotaalDocument) },
      perVeld: {
        id: { bytes: bytesId, MB: mb(bytesId), percentage: pct(bytesId) },
        bstCode: { bytes: bytesBstCode, MB: mb(bytesBstCode), percentage: pct(bytesBstCode) },
        wegnummer: { bytes: bytesWegnummer, MB: mb(bytesWegnummer), percentage: pct(bytesWegnummer) },
        straatnaam: { bytes: bytesStraatnaam, MB: mb(bytesStraatnaam), percentage: pct(bytesStraatnaam) },
        fromTo: { bytes: bytesFromTo, MB: mb(bytesFromTo), percentage: pct(bytesFromTo) },
        lengthM: { bytes: bytesLengthM, MB: mb(bytesLengthM), percentage: pct(bytesLengthM) },
        fromClusterId: { bytes: bytesFromClusterId, MB: mb(bytesFromClusterId), percentage: pct(bytesFromClusterId) },
        toClusterId: { bytes: bytesToClusterId, MB: mb(bytesToClusterId), percentage: pct(bytesToClusterId) },
      },
      clusterIdAnalyse: {
        aantalUniek: uniqueClusterIds.size,
        aantalOccurrences: clusterIdOccurrences,
        gemiddeldeLengte: Math.round(gemiddeldeClusterIdLengte * 100) / 100,
        maxLengte: maxClusterIdLen,
        huidigeBytesTotaal: bytesFromClusterId + bytesToClusterId,
        alternatiefIntegerIds: {
          maxCijfers: integerIdMaxDigits,
          geschatteBytesTotaal: bytesFromClusterIdAlternatief + bytesToClusterIdAlternatief,
          geschatteBesparingBytes: besparingClusterIds,
          geschatteBesparingMB: mb(besparingClusterIds),
        },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Meting mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
