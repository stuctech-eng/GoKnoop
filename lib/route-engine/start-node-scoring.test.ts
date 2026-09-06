import { describe, it, expect } from "vitest";
import { generateLoopRoutesWithScoring, DEFAULT_START_NODE_SCORE_WEIGHTS } from "./start-node-scoring";
import { InMemoryGraphProvider } from "./fixtures/in-memory-graph-provider";
import type { GraphEdge, GraphNode } from "./types";

/**
 * Twee volledig gescheiden rasternetwerken (geen gedeelde nodes/edges):
 * - "gA": klein rooster (SPACING 100m) rond kandidaat gA_center, DICHTBIJ de
 *   gebruiker (100m) maar te klein om een route van 4000m te leveren --> hoge
 *   afwijking (lage kwaliteit).
 * - "gB": groter rooster (SPACING 1000m) rond kandidaat gB_center, VERDER weg
 *   (2000m) maar wél in staat een route dicht bij 4000m te leveren --> lage
 *   afwijking (hoge kwaliteit).
 *
 * Bewijst het kernverschil met de oude simpele fallback: die zou gewoon gA
 * kiezen (eerste die iets oplevert, dichterbij). De score-functie moet gB
 * kiezen, ondanks de extra afstand, omdat routebeschikbaarheid+kwaliteit
 * zwaarder wegen.
 */
function buildGrid(prefix: string, spacing: number, offsetX: number, offsetY: number): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const id = (row: number, col: number) => `${prefix}_${row}_${col}`;
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      nodes.push({ id: id(row, col), x: offsetX + col * spacing, y: offsetY + row * spacing });
    }
  }
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      if (col < 2) {
        const a = id(row, col), b = id(row, col + 1);
        edges.push({ id: `${a}-${b}`, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: spacing, directionality: "unknown", geometry: [{ x: offsetX + col * spacing, y: offsetY + row * spacing }, { x: offsetX + (col + 1) * spacing, y: offsetY + row * spacing }] });
      }
      if (row < 2) {
        const a = id(row, col), b = id(row + 1, col);
        edges.push({ id: `${a}-${b}`, fromLogicalNodeId: a, toLogicalNodeId: b, distanceM: spacing, directionality: "unknown", geometry: [{ x: offsetX + col * spacing, y: offsetY + row * spacing }, { x: offsetX + col * spacing, y: offsetY + (row + 1) * spacing }] });
      }
    }
  }
  return { nodes, edges };
}

async function buildTwoClusterProvider(): Promise<InMemoryGraphProvider> {
  const gA = buildGrid("gA", 100, 0, 0); // klein, dichtbij, lage kwaliteit voor 4000m-doel
  const gB = buildGrid("gB", 1000, 100000, 100000); // groot, ver weg (andere coördinaten), hoge kwaliteit
  const provider = new InMemoryGraphProvider([...gA.nodes, ...gB.nodes], [...gA.edges, ...gB.edges]);
  await provider.load();
  return provider;
}

const OPTIONS = { circuityFactor: 1.0, radiusTolerance: 0.6, angleBuckets: 8, candidatesPerBucket: 4, count: 4 };

describe("generateLoopRoutesWithScoring — kiest de BESTE kandidaat, niet de eerste die werkt", () => {
  it("kiest de verdere kandidaat (gB) omdat die een veel betere route oplevert dan de dichtstbijzijnde (gA)", async () => {
    const provider = await buildTwoClusterProvider();
    const candidates = [
      { logicalNodeId: "gA_1_1", distanceM: 100 }, // dichtstbijzijnde -- klein rooster, matige kwaliteit
      { logicalNodeId: "gB_1_1", distanceM: 2000 }, // verder -- groot rooster, goede kwaliteit
    ];

    const result = generateLoopRoutesWithScoring(provider, "v-test", candidates, 4000, OPTIONS);

    expect("ok" in result).toBe(false);
    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("gB_1_1"); // NIET de dichtstbijzijnde gA
      expect(result.candidateScores).toHaveLength(2);

      const gAScore = result.candidateScores.find((c) => c.logicalNodeId === "gA_1_1")!;
      const gBScore = result.candidateScores.find((c) => c.logicalNodeId === "gB_1_1")!;
      expect(gBScore.score).toBeLessThan(gAScore.score); // lager = beter
      // Als gA daadwerkelijk routes vond, moet die significant hogere afwijking hebben.
      if (gAScore.bestDeviationPercent !== null && gBScore.bestDeviationPercent !== null) {
        expect(gAScore.bestDeviationPercent).toBeGreaterThan(gBScore.bestDeviationPercent);
      }
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("gebruikt de dichtstbijzijnde kandidaat gewoon als die al de beste is (geen onnodige voorkeur voor 'verder')", async () => {
    const provider = await buildTwoClusterProvider();
    // Nu is gB (goede kwaliteit) ook toevallig de dichtstbijzijnde -- moet gewoon gekozen worden.
    const candidates = [{ logicalNodeId: "gB_1_1", distanceM: 50 }];
    const result = generateLoopRoutesWithScoring(provider, "v-test", candidates, 4000, OPTIONS);
    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("gB_1_1");
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("geeft een duidelijke faal-uitkomst als geen enkele kandidaat een route oplevert", async () => {
    const nodes: GraphNode[] = [{ id: "isolated", x: 0, y: 0 }];
    const provider = new InMemoryGraphProvider(nodes, []);
    await provider.load();
    const result = generateLoopRoutesWithScoring(provider, "v-test", [{ logicalNodeId: "isolated", distanceM: 10 }], 4000, OPTIONS);
    expect("ok" in result && result.ok === false).toBe(true);
    if ("ok" in result) {
      expect(result.reason).toBe("no_usable_candidate");
      expect(result.candidateScores).toHaveLength(1);
      expect(result.candidateScores[0].score).toBe(Infinity);
    }
  });

  it("slaat een onbekend logicalNodeId over zonder te crashen", async () => {
    const provider = await buildTwoClusterProvider();
    const candidates = [
      { logicalNodeId: "bestaat-niet", distanceM: 10 },
      { logicalNodeId: "gB_1_1", distanceM: 2000 },
    ];
    const result = generateLoopRoutesWithScoring(provider, "v-test", candidates, 4000, OPTIONS);
    if ("selectedStartNodeId" in result) {
      expect(result.selectedStartNodeId).toBe("gB_1_1");
    } else {
      throw new Error("verwachtte een succesvol resultaat");
    }
  });

  it("standaardgewichten zijn zoals gedocumenteerd (uitgangspunt, nog niet definitief -- bijgesteld 30-8-2026 na een echte regressie)", () => {
    expect(DEFAULT_START_NODE_SCORE_WEIGHTS).toEqual({
      distancePenaltyPerMeter: 1,
      availabilityBonusPerRoute: 50,
      qualityPenaltyPerPercent: 50,
    });
  });
});
