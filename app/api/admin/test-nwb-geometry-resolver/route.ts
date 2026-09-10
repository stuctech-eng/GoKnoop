import { NextRequest, NextResponse } from "next/server";
import { resolveNwbGeometry } from "@/lib/nwb-analysis/nwb-geometry-resolver";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

// Bekende, al-in-productie-gebruikte segment-ID's (uit de 337km-trace,
// eerder vandaag) -- een echte, kleine, representatieve steekproef.
const KNOWN_TEST_SEGMENT_IDS = [
  "wegvakken.c77ea6a6-8203-4732-9fb8-c254e331f6ee",
  "wegvakken.ec2ba43c-bfa1-48ac-a2ad-c114c3241099",
  "wegvakken.cc13c2f7-f9dc-486a-96c0-9e8c988dcbdf",
  "wegvakken.cf517ac6-62d6-4e17-a5fe-18efdf82e7dc",
];

/**
 * GET /api/admin/test-nwb-geometry-resolver
 *
 * Fase M, 9-9-2026. GEÏSOLEERDE test van uitsluitend de geometrie-resolver
 * -- niet gekoppeld aan route-berekening, kaart, of enige andere flow.
 * Draai dit EERST, vóór verdere integratie -- de resolver zelf is nog
 * nooit tegen de levende PDOK-dienst getest (sandbox-netwerkbeperking).
 */
export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  try {
    const t0 = Date.now();
    const result = await resolveNwbGeometry(KNOWN_TEST_SEGMENT_IDS);
    const durationMs = Date.now() - t0;

    return NextResponse.json({
      durationMs,
      gevraagd: KNOWN_TEST_SEGMENT_IDS.length,
      opgelost: result.resolved.size,
      mislukt: result.failed,
      resultaten: Array.from(result.resolved.entries()).map(([id, coords]) => ({
        id,
        aantalPunten: coords.length,
        eerstePunt: coords[0],
        laatstePunt: coords[coords.length - 1],
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Geometrie-resolver-test mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
