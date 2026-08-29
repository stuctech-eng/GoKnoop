import { Route, RouteConstraints, RouteErrorReason } from "../../route-engine/types";

/**
 * Route Engine-koppeling (ontwerp sectie 18) -- implementatiestap 8.
 *
 * Dit is een INTERFACE, geen implementatie van de echte HTTP-aanroep. De
 * request/response-vorm is exact het bestaande contract van
 * `POST /api/route` (app/api/route/route.ts, Phase 2-ontwerp sectie 7):
 * `{ fromLogicalNodeId, toLogicalNodeId, constraints?: { avoidNodeIds?,
 * avoidEdgeIds? } }` → `Route` (200) of een fout met machineleesbare
 * `reason` (422). Geen velden verzonnen die de bestaande API niet kent.
 *
 * BEKENDE, NIET-OPGELOSTE KLOOF (ontwerp sectie 19, dataset-versie-pinning):
 * de bestaande `POST /api/route`-implementatie accepteert GEEN
 * `datasetVersionId` in de request -- hij leest altijd `config/
 * activeDataset` vers uit Firestore. Dat betekent dat een reroute via de
 * huidige API in theorie een ANDERE dataset-versie kan opleveren dan
 * waarmee de oorspronkelijke Route berekend is, als de actieve dataset
 * ondertussen gewijzigd is. Dit bestand voegt geen ongevraagd
 * `datasetVersionId`-veld toe aan de request (dat zou een verzonnen
 * API-parameter zijn) -- in plaats daarvan bewaakt `RerouteExecutor`
 * (reroute-executor.ts) dit ACHTERAF: een reroute-resultaat met een
 * afwijkende `datasetVersionId` wordt geweigerd, niet stilzwijgend
 * geaccepteerd. Een echte oplossing (de API zelf een `datasetVersionId`-
 * parameter laten accepteren en tegen die specifieke versie laten
 * rekenen) is een aparte, server-side wijziging buiten de scope van dit
 * navigatiepakket -- te bespreken bij de volgende architectuurreview.
 */

export type RouteEngineRequest = {
  fromLogicalNodeId: string;
  toLogicalNodeId: string;
  constraints?: RouteConstraints;
};

export type RouteEngineFailure = {
  reason: RouteErrorReason;
  message: string;
};

export interface RouteEngineClient {
  computeRoute(request: RouteEngineRequest): Promise<Route | RouteEngineFailure>;
}
