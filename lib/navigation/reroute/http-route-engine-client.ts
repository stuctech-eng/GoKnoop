import { Route, RouteErrorReason } from "../../route-engine/types";
import type { RouteEngineClient, RouteEngineRequest, RouteEngineFailure } from "./route-engine-client";

/**
 * Echte HTTP-implementatie van `RouteEngineClient` (ontwerp sectie 18) --
 * ontbrak tot nu toe volledig in productiecode. `route-engine-client.ts`
 * beschrijft het contract al exact (`POST /api/route`, zie de comments
 * daar voor de bekende dataset-versie-kloof); dit bestand voert die
 * aanroep daadwerkelijk uit, verzint geen nieuw contract.
 *
 * TOEGEVOEGD 13-9-2026 (Fase 2A-vervolg, reroute-koppeling): eerste en
 * enige productie-implementatie. Client-side (`"use client"`-componenten
 * zoals NavigationScreen), dus een gewone relatieve `fetch()`.
 */
export class HttpRouteEngineClient implements RouteEngineClient {
  async computeRoute(request: RouteEngineRequest): Promise<Route | RouteEngineFailure> {
    const res = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // Vercel-timeout of andere niet-JSON-respons -- geen RouteEngineFailure (die is
      // getypeerd op de drie bekende, betekenisvolle route-redenen), gewoon THROWEN.
      // `RerouteExecutor.execute()` vangt dit al af als "network_error" (bestaande,
      // geteste foutafhandeling -- geen nieuwe categorie verzinnen).
      throw new Error(`Herberekening gaf geen geldige respons (status ${res.status}).`);
    }

    if (!res.ok) {
      const failure = data as { error?: string; reason?: string };
      const knownReason: RouteErrorReason[] = ["disconnected", "no_traversable_edges", "all_paths_blocked_by_constraints"];
      if (failure.reason && (knownReason as string[]).includes(failure.reason)) {
        return { reason: failure.reason as RouteErrorReason, message: failure.error ?? "Herberekening mislukt." };
      }
      // Onbekende/ontbrekende reason (bijv. een 500/502-serverfout zonder route-specifieke
      // betekenis) -- ook hier THROWEN, zelfde reden als hierboven.
      throw new Error(failure.error ?? `Herberekening mislukt (status ${res.status}).`);
    }

    return data as Route;
  }
}
