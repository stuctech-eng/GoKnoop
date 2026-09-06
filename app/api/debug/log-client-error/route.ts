import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const dynamic = "force-dynamic";

/**
 * POST /api/debug/log-client-error
 *
 * Vangt client-side kaartfouten met rijke context op (6-9-2026, n.a.v. een
 * "i.codePointAt is not a function"-crash in Lochem die met alleen
 * `e?.error?.message` niet te herleiden was tot een oorzaak). Geen
 * authenticatie nodig -- dit is fire-and-forget diagnostiek vanuit de
 * live app, geen gevoelige actie.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const db = getDb();
    await db.collection("clientErrorLogs").add({
      message: typeof body.message === "string" ? body.message : String(body.message ?? "onbekend"),
      stack: typeof body.stack === "string" ? body.stack : null,
      context: body.context ?? null,
      userAgent: req.headers.get("user-agent") ?? null,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    // Bewust geen 500 teruggeven voor een falende logger -- dat mag de app zelf niet breken.
    console.error("log-client-error mislukt:", err);
    return NextResponse.json({ ok: false });
  }
}
