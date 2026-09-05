import { describe, it, expect, vi } from "vitest";
import { BridgeAugmentedGraphProvider } from "./bridge-augmented-graph-provider";
import type { GraphProvider, GraphNode, GraphEdge } from "./types";
import type { NetworkBridge } from "./network-bridge-types";

/** Minimale fake GraphProvider, puur voor deze tests -- geen Firestore/fixtures nodig. */
class FakeGraphProvider implements GraphProvider {
  constructor(
    private readonly nodes: Map<string, GraphNode>,
    private readonly edgesByNode: Map<string, GraphEdge[]>
  ) {}
  async load(): Promise<void> {}
  getNode(nodeId: string): GraphNode | undefined {
    return this.nodes.get(nodeId);
  }
  getAllNodeIds(): string[] {
    return [...this.nodes.keys()];
  }
  getEdgesFrom(nodeId: string): GraphEdge[] {
    return this.edgesByNode.get(nodeId) || [];
  }
}

function makeBridge(overrides: Partial<NetworkBridge> = {}): NetworkBridge {
  return {
    id: "ds1_A_B",
    datasetVersionId: "ds1",
    sourceNodeId: "A",
    targetNodeId: "B",
    distanceM: 1500,
    durationS: 300,
    geometry: [
      { lat: 52.0, lon: 4.9 },
      { lat: 52.01, lon: 4.91 },
    ],
    routingProvider: "openrouteservice",
    routingProfile: "cycling",
    circuityRatio: 1.2,
    validationStatus: "valid",
    rejectionReason: null,
    sourceComponentSizeAtCreation: 1,
    targetComponentSizeAtCreation: 8372,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("BridgeAugmentedGraphProvider", () => {
  it("voegt geen bridge-edges toe aan een node zonder bridges (regressie-garantie)", () => {
    const base = new FakeGraphProvider(
      new Map([["X", { id: "X", x: 0, y: 0 }]]),
      new Map([["X", [{ id: "e1", fromLogicalNodeId: "X", toLogicalNodeId: "Y", distanceM: 100, directionality: "unknown", geometry: [] }]]])
    );
    const provider = new BridgeAugmentedGraphProvider(base, []);
    expect(provider.getEdgesFrom("X")).toEqual(base.getEdgesFrom("X"));
  });

  it("voegt een bridge-edge toe als uitgaande edge vanaf sourceNodeId", () => {
    const base = new FakeGraphProvider(
      new Map([
        ["A", { id: "A", x: 0, y: 0 }],
        ["B", { id: "B", x: 1000, y: 1000 }],
      ]),
      new Map()
    );
    const bridge = makeBridge();
    const provider = new BridgeAugmentedGraphProvider(base, [bridge]);

    const edgesFromA = provider.getEdgesFrom("A");
    expect(edgesFromA).toHaveLength(1);
    expect(edgesFromA[0].fromLogicalNodeId).toBe("A");
    expect(edgesFromA[0].toLogicalNodeId).toBe("B");
    expect(edgesFromA[0].directionality).toBe("forward");
    expect(edgesFromA[0].distanceM).toBe(1500);
  });

  it("voegt de bridge-edge NIET toe als uitgaande edge vanaf targetNodeId (directioneel, geen bidirectional)", () => {
    const base = new FakeGraphProvider(
      new Map([
        ["A", { id: "A", x: 0, y: 0 }],
        ["B", { id: "B", x: 1000, y: 1000 }],
      ]),
      new Map()
    );
    const bridge = makeBridge();
    const provider = new BridgeAugmentedGraphProvider(base, [bridge]);

    const edgesFromB = provider.getEdgesFrom("B");
    expect(edgesFromB).toHaveLength(0);
  });

  it("behoudt bestaande edges van een node en voegt bridge-edges ernaast toe (additief, geen verlies)", () => {
    const existingEdge: GraphEdge = { id: "e1", fromLogicalNodeId: "A", toLogicalNodeId: "C", distanceM: 500, directionality: "unknown", geometry: [] };
    const base = new FakeGraphProvider(
      new Map([
        ["A", { id: "A", x: 0, y: 0 }],
        ["B", { id: "B", x: 1000, y: 1000 }],
      ]),
      new Map([["A", [existingEdge]]])
    );
    const bridge = makeBridge();
    const provider = new BridgeAugmentedGraphProvider(base, [bridge]);

    const edgesFromA = provider.getEdgesFrom("A");
    expect(edgesFromA).toHaveLength(2);
    expect(edgesFromA).toContainEqual(existingEdge);
  });

  it("ondersteunt meerdere bridges vanaf dezelfde node (MAX_ACTIVE_BRIDGES_PER_NODE wordt door de caller bepaald, niet hier)", () => {
    const base = new FakeGraphProvider(
      new Map([
        ["A", { id: "A", x: 0, y: 0 }],
        ["B", { id: "B", x: 1000, y: 1000 }],
        ["C", { id: "C", x: 2000, y: 2000 }],
      ]),
      new Map()
    );
    const bridgeAB = makeBridge({ id: "ds1_A_B", targetNodeId: "B" });
    const bridgeAC = makeBridge({ id: "ds1_A_C", targetNodeId: "C" });
    const provider = new BridgeAugmentedGraphProvider(base, [bridgeAB, bridgeAC]);

    expect(provider.getEdgesFrom("A")).toHaveLength(2);
  });

  it("twee tegengestelde bridges (A->B en B->A) leveren elk hun eigen, onafhankelijke edge op", () => {
    const base = new FakeGraphProvider(
      new Map([
        ["A", { id: "A", x: 0, y: 0 }],
        ["B", { id: "B", x: 1000, y: 1000 }],
      ]),
      new Map()
    );
    const forward = makeBridge({ id: "ds1_A_B", sourceNodeId: "A", targetNodeId: "B", distanceM: 1500 });
    const backward = makeBridge({ id: "ds1_B_A", sourceNodeId: "B", targetNodeId: "A", distanceM: 1800 });
    const provider = new BridgeAugmentedGraphProvider(base, [forward, backward]);

    const edgesFromA = provider.getEdgesFrom("A");
    const edgesFromB = provider.getEdgesFrom("B");
    expect(edgesFromA).toHaveLength(1);
    expect(edgesFromA[0].distanceM).toBe(1500);
    expect(edgesFromB).toHaveLength(1);
    expect(edgesFromB[0].distanceM).toBe(1800);
  });

  it("getNode en getAllNodeIds delegeren onveranderd naar de base-provider", () => {
    const base = new FakeGraphProvider(new Map([["A", { id: "A", x: 5, y: 5 }]]), new Map());
    const provider = new BridgeAugmentedGraphProvider(base, [makeBridge()]);
    expect(provider.getNode("A")).toEqual({ id: "A", x: 5, y: 5 });
    expect(provider.getNode("nonexistent")).toBeUndefined();
    expect(provider.getAllNodeIds()).toEqual(["A"]);
  });

  it("load() delegeert naar de base-provider", async () => {
    const base = new FakeGraphProvider(new Map(), new Map());
    const loadSpy = vi.spyOn(base, "load");
    const provider = new BridgeAugmentedGraphProvider(base, []);
    await provider.load();
    expect(loadSpy).toHaveBeenCalledOnce();
  });

  it("converteert bridge-geometrie (WGS84) naar RD, consistent met reguliere edge-geometrie", () => {
    const base = new FakeGraphProvider(
      new Map([
        ["A", { id: "A", x: 0, y: 0 }],
        ["B", { id: "B", x: 1000, y: 1000 }],
      ]),
      new Map()
    );
    const provider = new BridgeAugmentedGraphProvider(base, [makeBridge()]);
    const edge = provider.getEdgesFrom("A")[0];
    // RD-coördinaten liggen typisch in de honderdduizenden (x) / miljoenen (y) --
    // duidelijk te onderscheiden van WGS84 lat/lon (tientallen/enkelen).
    expect(edge.geometry[0].x).toBeGreaterThan(1000);
    expect(edge.geometry[0].y).toBeGreaterThan(100000);
  });
});
