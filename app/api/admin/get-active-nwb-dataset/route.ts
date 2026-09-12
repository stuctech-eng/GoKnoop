import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

/**
 * GET /api/admin/get-active-nwb-dataset
 *
 * Klein, goedkoop eindpunt -- leest alleen `config/activeNwbDataset`, geen
 * segmenten. Bedoeld om UI-standaardwaarden te vullen met de DAADWERKELIJK
 * actieve dataset, i.p.v. te gokken op basis van de huidige datum (die gok
 * bleek fout zodra een precompute een dag na de migratie wordt gedraaid).
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
    const db = getDb();
    const snap = await db.collection("config").doc("activeNwbDataset").get();
    return NextResponse.json({
      nwbDatasetVersionId: snap.exists ? (snap.data()!.nwbDatasetVersionId as string) : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Ophalen mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
