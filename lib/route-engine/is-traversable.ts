import { GraphEdge } from "./types";

/**
 * Routingpolicy-laag (ontwerp sectie 5). De RAW-waarde van `edge.directionality`
 * wordt hier NOOIT overschreven -- deze functie vertaalt 'm alleen naar een
 * praktisch traversal-besluit voor de huidige aanvraag.
 *
 * Huidige policy: 'unknown' wordt behandeld als 'bidirectional' (Phase 1
 * pre-flight besluit -- een edge onterecht als eenrichtingsverkeer behandelen
 * is schadelijker dan onterecht als tweerichtingsverkeer). Zodra de
 * rijrichting-semantiek ooit wordt opgehelderd (Phase 1B sectie 4), is dit de
 * ENIGE functie die aangepast hoeft te worden -- geen wijziging aan Dijkstra zelf.
 *
 * @param edge De edge waarlangs eventueel gereisd wordt.
 * @param fromNodeId De node van waaruit vertrokken wordt (voor toekomstig gebruik
 *   bij forward/reverse-onderscheid -- nu nog niet gebruikt, MVP behandelt alles
 *   als bidirectioneel).
 */
export function isTraversable(edge: GraphEdge, fromNodeId: string): boolean {
  switch (edge.directionality) {
    case "unknown":
    case "bidirectional":
      return true;
    case "forward":
      // Toekomstig: alleen traversable als fromNodeId === edge.fromLogicalNodeId.
      // MVP: nog niet in productie in gebruik (alle edges staan op 'unknown'),
      // maar al correct geïmplementeerd zodra rijrichting wél bekend wordt.
      return fromNodeId === edge.fromLogicalNodeId;
    case "reverse":
      return fromNodeId === edge.toLogicalNodeId;
    default:
      return true;
  }
}
