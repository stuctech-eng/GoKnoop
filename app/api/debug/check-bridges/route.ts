import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

/**
 * GET /api/debug/check-bridges — gerichte verificatie (5-9-2026): staan de
 * bekende Amsterdam-gap-knopen (NDSM + 2 andere 0-edge-nodes bij De
 * Ruijterkade) na de landelijke strong-scope-run als "valid" in
 * networkBridges? Context: 76/4002 (1,9%) valid landelijk -- dit checkt of
 * de bekende, eerder 100% ORS-gevalideerde gevallen daar wél tussen zitten,
 * voordat het lage landelijke percentage als een probleem wordt behandeld.
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const nodeIdsParam = req.nextUrl.searchParams.get("nodeIds");
  const nodeIds = nodeIdsParam
    ? nodeIdsParam.split(",")
    : ["pR2n6KWgtHLRPwvkUmZ8", "MlD0oYfflMtqblDgqoaf", "sPSiwXQwlcY7dacptKvS"];

  try {
    const db = getDb();
    const results: Record<string, { asSource: unknown[]; asTarget: unknown[] }> = {};

    for (const nodeId of nodeIds) {
      const [asSourceSnap, asTargetSnap] = await Promise.all([
        db.collection("networkBridges").where("sourceNodeId", "==", nodeId).get(),
        db.collection("networkBridges").where("targetNodeId", "==", nodeId).get(),
      ]);
      results[nodeId] = {
        asSource: asSourceSnap.docs.map((d) => {
          const data = d.data();
          return { targetNodeId: data.targetNodeId, validationStatus: data.validationStatus, distanceM: data.distanceM, circuityRatio: data.circuityRatio, rejectionReason: data.rejectionReason };
        }),
        asTarget: asTargetSnap.docs.map((d) => {
          const data = d.data();
          return { sourceNodeId: data.sourceNodeId, validationStatus: data.validationStatus, distanceM: data.distanceM, circuityRatio: data.circuityRatio, rejectionReason: data.rejectionReason };
        }),
      };
    }

    return NextResponse.json({ nodeIds, results });
  } catch (err) {
    return NextResponse.json(
      { error: "Check mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
