import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

/**
 * Verbindingstest voor Firebase Admin SDK / Firestore.
 * Schrijft en leest een testdocument in een aparte 'debug'-collectie
 * (niet in de echte GoKnoop-collecties), zodat dit los staat van
 * eventuele latere importer-data.
 *
 * Beveiligd met dezelfde DEBUG_SECRET als de Routedatabank-debugroutes.
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
    const testRef = db.collection("_debug").doc("connection-test");

    const writePayload = {
      testedAt: new Date().toISOString(),
      message: "GoKnoop Firestore-verbinding werkt",
    };

    await testRef.set(writePayload);
    const snapshot = await testRef.get();

    return NextResponse.json({
      status: "ok",
      wrote: writePayload,
      readBack: snapshot.data(),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  } catch (err) {
    return NextResponse.json(
      {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
