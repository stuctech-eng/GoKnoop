import { describe, it, expect } from "vitest";
import { generateConnectorCandidates, type GoKnoopNodeInput, type NwbSegmentInput } from "./connector-candidates";

describe("connector-candidates", () => {
  describe("positief geval: echte T-aansluiting", () => {
    it("herkent een NWB-fietspad dat loodrecht op een GoKnoop-weg aansluit als high confidence", () => {
      // GoKnoop-node op (0,0), edge loopt oost-west (bearing (1,0)).
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      // NWB-fietspad komt van het noorden aanlopen (loodrecht, hoek 90°) en eindigt exact bij de GoKnoop-node.
      const nwbSegments: NwbSegmentInput[] = [{ id: "nwb1", bstCode: "FP", wegnummer: null, from: { x: 0, y: 50 }, to: { x: 1, y: 1 } }];

      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].confidence).toBe("high");
      expect(result.candidates[0].setClassification).toBe("setA");
    });
  });

  describe("negatief geval 1: parallelle infrastructuur (moet worden afgewezen)", () => {
    it("wijst een NWB-fietspad af dat vrijwel parallel aan de GoKnoop-weg loopt", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }]; // oost-west
      // NWB-segment loopt vrijwel dezelfde kant op (hoek ~0°) -- typisch een fietspad NAAST de weg, geen aansluiting.
      const nwbSegments: NwbSegmentInput[] = [{ id: "nwb1", bstCode: "FP", wegnummer: null, from: { x: -1, y: 0.5 }, to: { x: 1, y: 0.5 } }];

      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates.some((c) => c.confidence === "rejected" && c.rejectionReason?.includes("parallel"))).toBe(true);
    });
  });

  describe("negatief geval 2: autosnelweg wordt uitgesloten ongeacht nabijheid", () => {
    it("wijst een NWB-segment met wegnummer A* af, ongeacht BST_CODE of afstand", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [{ id: "nwb1", bstCode: "FP", wegnummer: "A1", from: { x: 0, y: 50 }, to: { x: 0, y: 1 } }];

      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates[0].confidence).toBe("rejected");
      expect(result.candidates[0].setClassification).toBe("excluded");
    });
  });

  describe("Set A vs Set B confidence-onderscheid", () => {
    it("geeft setA (FP) high confidence en setB (RB) lower confidence, bij verder identieke geometrie", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [
        { id: "fp1", bstCode: "FP", wegnummer: null, from: { x: 0, y: 50 }, to: { x: 1, y: 1 } },
        { id: "rb1", bstCode: "RB", wegnummer: null, from: { x: -1, y: -50 }, to: { x: -1, y: -1 } },
      ];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      const fpCandidate = result.candidates.find((c) => c.nwbSegmentId === "fp1")!;
      const rbCandidate = result.candidates.find((c) => c.nwbSegmentId === "rb1")!;
      expect(fpCandidate.confidence).toBe("high");
      expect(rbCandidate.confidence).toBe("lower");
    });
  });

  describe("junction-degree", () => {
    it("telt correct hoeveel NWB-segmenten een eindpunt delen (echte kruising vs doodlopend)", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      // Drie NWB-segmenten die allemaal exact bij (0,1) samenkomen -- een echte kruising.
      const nwbSegments: NwbSegmentInput[] = [
        { id: "a", bstCode: "FP", wegnummer: null, from: { x: 0, y: 1 }, to: { x: 10, y: 1 } },
        { id: "b", bstCode: "FP", wegnummer: null, from: { x: 0, y: 1 }, to: { x: -10, y: 1 } },
        { id: "c", bstCode: "FP", wegnummer: null, from: { x: 0, y: 1 }, to: { x: 0, y: 20 } },
      ];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      // Alle drie candidates op dit punt moeten junctionDegree 3 hebben (3 segmenten delen dit punt).
      for (const c of result.candidates) {
        expect(c.nwbJunctionDegree).toBe(3);
      }
    });

    it("geeft junctionDegree 1 voor een oprecht doodlopend NWB-eindpunt", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [{ id: "solo", bstCode: "FP", wegnummer: null, from: { x: 0, y: 1 }, to: { x: 10, y: 1 } }];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates[0].nwbJunctionDegree).toBe(1);
    });
  });

  describe("zoekstraal is een zoekgebied, geen acceptatiedrempel", () => {
    it("neemt kandidaten op tot exact de opgegeven straal, ongeacht confidence", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [
        { id: "dichtbij", bstCode: "RB", wegnummer: null, from: { x: 0, y: 3 }, to: { x: 1, y: 40 } }, // from ~3m (binnen straal), to ver weg (buiten straal)
      ];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates.length).toBe(1);
      expect(result.candidates[0].confidence).toBe("lower"); // niet "rejected" puur om de afstand
    });

    it("negeert kandidaten buiten de zoekstraal volledig", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [{ id: "ver", bstCode: "FP", wegnummer: null, from: { x: 0, y: 100 }, to: { x: 1, y: 101 } }];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates.length).toBe(0);
    });
  });

  describe("distanceHistogram", () => {
    it("groepeert kandidaten correct per afstandsinterval", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [
        { id: "a", bstCode: "FP", wegnummer: null, from: { x: 0, y: 1 }, to: { x: 1, y: 90 } }, // from ~1m, to ver buiten straal
        { id: "b", bstCode: "FP", wegnummer: null, from: { x: 0, y: 8 }, to: { x: 1, y: 90 } }, // from ~8m, to ver buiten straal
      ];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 20);
      expect(result.summary.distanceHistogram["0-2m"]).toBe(1);
      expect(result.summary.distanceHistogram["5-10m"]).toBe(1);
    });
  });

  describe("directionAssessment", () => {
    it("markeert elke connector altijd als onzeker -- nooit afgeleid uit rijrichtng (Fase 2-bevinding)", () => {
      const goknoopNodes: GoKnoopNodeInput[] = [{ id: "gk1", x: 0, y: 0, edgeBearings: [{ x: 1, y: 0 }] }];
      const nwbSegments: NwbSegmentInput[] = [{ id: "a", bstCode: "FP", wegnummer: null, from: { x: 0, y: 1 }, to: { x: 1, y: 2 } }];
      const result = generateConnectorCandidates(goknoopNodes, nwbSegments, 5);
      expect(result.candidates[0].directionAssessment).toBe("onzeker_tweerichtingen_aangenomen");
    });
  });
});
