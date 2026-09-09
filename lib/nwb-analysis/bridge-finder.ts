/**
 * Bridge-finding (Tarjan) -- Fase 5C, landelijke topologie-analyse
 * (9-9-2026). TIJDELIJKE onderzoeksinfrastructuur, geen productiecode.
 *
 * Een "bridge" is een edge waarvan het verwijderen de graaf in twee (of
 * meer) aparte componenten zou splitsen -- de wiskundige formalisering van
 * de "poort"-hypothese: als West-Nederland en de rest van het land maar via
 * één zo'n edge verbonden zijn, is dat een single point of failure.
 *
 * Bewust ITERATIEF geïmplementeerd (niet recursief) -- bij een component
 * van duizenden knopen in een lange, kronkelende keten zou een recursieve
 * DFS de JS-call-stack kunnen overschrijden.
 */

export type SimpleEdge = { id: string; a: string; b: string; distanceM: number };

export type Bridge = { edgeId: string; a: string; b: string; distanceM: number };

/**
 * Vindt alle bridges in een ongerichte graaf, gegeven als edge-lijst.
 * `adjacency` wordt intern opgebouwd; elke edge verschijnt maar één keer in
 * de input (a->b), niet in beide richtingen apart.
 */
export function findBridges(nodeIds: string[], edges: SimpleEdge[]): Bridge[] {
  const adjacency = new Map<string, { to: string; edgeId: string }[]>();
  const distanceByEdgeId = new Map<string, number>();
  for (const id of nodeIds) adjacency.set(id, []);
  for (const e of edges) {
    if (!adjacency.has(e.a)) adjacency.set(e.a, []);
    if (!adjacency.has(e.b)) adjacency.set(e.b, []);
    adjacency.get(e.a)!.push({ to: e.b, edgeId: e.id });
    adjacency.get(e.b)!.push({ to: e.a, edgeId: e.id });
    distanceByEdgeId.set(e.id, e.distanceM);
  }

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const visited = new Set<string>();
  const bridges: Bridge[] = [];
  let timer = 0;

  // Iteratieve DFS met een expliciete stack. Elk frame houdt bij: huidige
  // node, ouder-edge-ID (om niet meteen terug te lopen over dezelfde edge),
  // en de index in de buren-lijst waar we gebleven waren.
  type Frame = { node: string; parentEdgeId: string | null; neighborIndex: number };

  for (const startNode of nodeIds) {
    if (visited.has(startNode)) continue;

    const stack: Frame[] = [{ node: startNode, parentEdgeId: null, neighborIndex: 0 }];
    visited.add(startNode);
    disc.set(startNode, timer);
    low.set(startNode, timer);
    timer++;

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adjacency.get(frame.node) ?? [];

      if (frame.neighborIndex < neighbors.length) {
        const { to, edgeId } = neighbors[frame.neighborIndex];
        frame.neighborIndex++;

        if (edgeId === frame.parentEdgeId) continue; // niet meteen terug over dezelfde edge

        if (visited.has(to)) {
          // Al bezocht (maar niet via de ouder-edge) -- terugverwijzing, low bijwerken.
          low.set(frame.node, Math.min(low.get(frame.node)!, disc.get(to)!));
        } else {
          visited.add(to);
          disc.set(to, timer);
          low.set(to, timer);
          timer++;
          stack.push({ node: to, parentEdgeId: edgeId, neighborIndex: 0 });
        }
      } else {
        // Klaar met alle buren van deze node -- terug naar de ouder, low doorgeven.
        stack.pop();
        if (stack.length > 0) {
          const parentFrame = stack[stack.length - 1];
          low.set(parentFrame.node, Math.min(low.get(parentFrame.node)!, low.get(frame.node)!));
          if (low.get(frame.node)! > disc.get(parentFrame.node)!) {
            bridges.push({ edgeId: frame.parentEdgeId!, a: parentFrame.node, b: frame.node, distanceM: distanceByEdgeId.get(frame.parentEdgeId!) ?? 0 });
          }
        }
      }
    }
  }

  return bridges;
}
