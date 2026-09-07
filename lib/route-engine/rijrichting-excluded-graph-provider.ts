import type { GraphProvider, GraphNode, GraphEdge } from "./types";

/**
 * ANALYSE-ONLY decorator (7-9-2026, rijrichting-onderzoek, zie
 * docs/GOKNOOP-MASTER.md sectie 2.1 en docs/phase1b-design.md sectie 4 voor
 * de volledige voorgeschiedenis van dit onderzoek).
 *
 * Filtert edges waarvan het edge-ID voorkomt in de meegegeven
 * `excludedEdgeIds`-set (in de praktijk: edges met rijrichting=2) uit
 * `getEdgesFrom()`. GEEN wijziging aan `isTraversable()`, GEEN wiring in
 * enige productieroute -- uitsluitend gebruikt door
 * /api/debug/rijrichting-impact-analysis, om te SIMULEREN wat er zou
 * gebeuren als deze edges analytisch worden uitgesloten, zonder dat
 * daadwerkelijk in productiecode te doen. Zelfde decorator-patroon als
 * BridgeAugmentedGraphProvider (bridge-augmented-graph-provider.ts).
 */
export class RijrichtingExcludedGraphProvider implements GraphProvider {
  constructor(
    private readonly base: GraphProvider,
    private readonly excludedEdgeIds: ReadonlySet<string>
  ) {}

  async load(): Promise<void> {
    await this.base.load();
  }

  getNode(nodeId: string): GraphNode | undefined {
    return this.base.getNode(nodeId);
  }

  getAllNodeIds(): string[] {
    return this.base.getAllNodeIds();
  }

  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.base.getEdgesFrom(nodeId).filter((e) => !this.excludedEdgeIds.has(e.id));
  }
}
