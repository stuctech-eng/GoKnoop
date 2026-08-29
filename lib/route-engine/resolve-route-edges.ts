import { GraphProvider, GraphEdge, Route } from "./types";

/**
 * Vertaalt `Route.edges[]` (ID's) terug naar de volledige `GraphEdge`-
 * objecten, in dezelfde volgorde -- gebouwd voor de Phase 4-UI-integratie
 * (GOKNOOP-MASTER.md sectie 7, stap "Route Engine -> GraphEdge[] ->
 * Navigation Engine -> Map/UI").
 *
 * Bewust GEEN nieuwe `GraphProvider`-methode, GEEN reconstructie vanuit de
 * platte `Route.geometry`, GEEN nieuw parallel edge-datamodel -- uitsluitend
 * de bestaande `getEdgesFrom()` hergebruikt. `Route.nodes[i]` en
 * `Route.edges[i]` corresponderen 1-op-1 (edge i loopt van `nodes[i]` naar
 * `nodes[i+1]`, Phase 2-ontwerp sectie 6) -- deze functie steunt expliciet
 * op die garantie, filtert op het unieke edge-`id` (ondubbelzinnig, ook bij
 * parallelle edges tussen dezelfde twee nodes).
 *
 * Gooit een duidelijke fout als een edge niet resolveerbaar is -- geen
 * stille gaten in de geometrie die pas in de navigatie-engine zouden
 * opduiken.
 */
export function resolveRouteEdges(provider: GraphProvider, route: Route): GraphEdge[] {
  const resolved: GraphEdge[] = [];
  for (let i = 0; i < route.edges.length; i++) {
    const edgeId = route.edges[i];
    const fromNodeId = route.nodes[i];
    const candidates = provider.getEdgesFrom(fromNodeId);
    const edge = candidates.find((e) => e.id === edgeId);
    if (!edge) {
      throw new Error(
        `resolveRouteEdges: edge '${edgeId}' (index ${i}, vanaf node '${fromNodeId}') niet gevonden via GraphProvider.getEdgesFrom(). Route mogelijk inconsistent met de geladen dataset.`
      );
    }
    resolved.push(edge);
  }
  return resolved;
}
