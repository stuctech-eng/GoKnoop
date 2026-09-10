import { describe, it, expect } from "vitest";
import { evaluateRouteQuality } from "./route-quality";

describe("evaluateRouteQuality -- empirische toets tegen echte, vandaag gemeten routes", () => {
  describe("MOET AFGEWEZEN WORDEN: de 337km-anomalie (Volendam-regio, Fase 5C)", () => {
    it("v1 (3Sx24A->AG9myG, F=1.1): deviationFactor 20,14 -- twee gescheiden NWB-componenten overbrugd via GoKnoop", () => {
      const result = evaluateRouteQuality({ distanceM: 337390, straightLineDistanceM: 16753, switchCount: 2 });
      expect(result.verdict).not.toBe("geaccepteerd");
      expect(result.deviationFactor).toBeCloseTo(20.14, 1);
    });

    it("v7 (AG9myG->nKfPyX, F=1.1): deviationFactor 18,21 -- zelfde mechanisme, ander eindpunt", () => {
      const result = evaluateRouteQuality({ distanceM: 336284, straightLineDistanceM: 18471, switchCount: 2 });
      expect(result.verdict).not.toBe("geaccepteerd");
    });

    it("de oorspronkelijke Amsterdam-Hilversum-smalle-corridor-route (Fase 1, deviationFactor 14,39) moet ook worden afgewezen", () => {
      const result = evaluateRouteQuality({ distanceM: 366900, straightLineDistanceM: 25500, switchCount: 0 });
      expect(result.verdict).toBe("afgewezen_hard");
    });
  });

  describe("MOET GEACCEPTEERD WORDEN: Hilversum/Volendam-kernroutes (Fase 4)", () => {
    it("Amsterdam->Hilversum, F=1 (NWB-dominant): deviationFactor 1,09", () => {
      const result = evaluateRouteQuality({ distanceM: 27748, straightLineDistanceM: 25461, switchCount: 2 });
      expect(result.verdict).toBe("geaccepteerd");
    });
    it("Amsterdam->Hilversum, F=1.15 (omslagpunt): deviationFactor 1,18", () => {
      const result = evaluateRouteQuality({ distanceM: 29962, straightLineDistanceM: 25461, switchCount: 6 });
      expect(result.verdict).toBe("geaccepteerd");
    });
    it("Amsterdam->Hilversum, F=20 (extreem hoge voorkeur): deviationFactor 1,61 -- zelfs hier nog gezond", () => {
      const result = evaluateRouteQuality({ distanceM: 41106, straightLineDistanceM: 25461, switchCount: 2 });
      expect(result.verdict).toBe("geaccepteerd");
    });
    it("Volendam->Amsterdam, F=1: deviationFactor 1,11", () => {
      const result = evaluateRouteQuality({ distanceM: 19456, straightLineDistanceM: 17592, switchCount: 2 });
      expect(result.verdict).toBe("geaccepteerd");
    });
    it("Volendam->Amsterdam, F=1.5 (volledig GoKnoop): deviationFactor 1,43", () => {
      const result = evaluateRouteQuality({ distanceM: 25240, straightLineDistanceM: 17592, switchCount: 0 });
      expect(result.verdict).toBe("geaccepteerd");
    });
  });

  describe("MOET GEACCEPTEERD WORDEN: alle 22 'schone' Fase 5B-paren bij F=1,1 (Hilversum/Lochem/Volendam, exclusief de anomalie)", () => {
    const cleanPairs: { naam: string; distanceM: number; straightLineDistanceM: number; switchCount: number }[] = [
      { naam: "h1", distanceM: 8786, straightLineDistanceM: 7682, switchCount: 4 },
      { naam: "h2", distanceM: 4, straightLineDistanceM: 51, switchCount: 2 },
      { naam: "h3", distanceM: 18561, straightLineDistanceM: 15041, switchCount: 4 },
      { naam: "h4", distanceM: 20533, straightLineDistanceM: 15059, switchCount: 6 },
      { naam: "h5", distanceM: 25604, straightLineDistanceM: 22537, switchCount: 10 },
      { naam: "h6", distanceM: 11168, straightLineDistanceM: 8350, switchCount: 2 },
      { naam: "h7", distanceM: 14626, straightLineDistanceM: 11500, switchCount: 2 },
      { naam: "h8", distanceM: 6202, straightLineDistanceM: 5228, switchCount: 2 },
      { naam: "l1", distanceM: 10502, straightLineDistanceM: 9024, switchCount: 4 },
      { naam: "l2", distanceM: 6726, straightLineDistanceM: 5670, switchCount: 2 },
      { naam: "l3", distanceM: 12719, straightLineDistanceM: 11323, switchCount: 2 },
      { naam: "l4", distanceM: 12120, straightLineDistanceM: 9758, switchCount: 2 },
      { naam: "l5", distanceM: 12903, straightLineDistanceM: 10657, switchCount: 4 },
      { naam: "l6", distanceM: 8236, straightLineDistanceM: 7138, switchCount: 2 },
      { naam: "l7 (F=1.1, hoogste legitieme deviation vandaag)", distanceM: 25766, straightLineDistanceM: 13038, switchCount: 4 },
      { naam: "l7 (F=1.3, nog hoger)", distanceM: 26655, straightLineDistanceM: 13038, switchCount: 4 },
      { naam: "l8", distanceM: 13265, straightLineDistanceM: 10463, switchCount: 2 },
      { naam: "v2", distanceM: 15069, straightLineDistanceM: 12419, switchCount: 2 },
      { naam: "v3", distanceM: 774, straightLineDistanceM: 912, switchCount: 2 },
      { naam: "v4", distanceM: 15984, straightLineDistanceM: 12986, switchCount: 4 },
      { naam: "v5", distanceM: 14900, straightLineDistanceM: 12219, switchCount: 0 },
      { naam: "v6", distanceM: 7854, straightLineDistanceM: 6687, switchCount: 4 },
      { naam: "v8", distanceM: 2671, straightLineDistanceM: 2230, switchCount: 2 },
    ];

    it.each(cleanPairs)("$naam wordt geaccepteerd", ({ distanceM, straightLineDistanceM, switchCount }) => {
      const result = evaluateRouteQuality({ distanceM, straightLineDistanceM, switchCount });
      expect(result.verdict).toBe("geaccepteerd");
    });
  });

  describe("Grensgedrag (synthetisch, ter aanvulling op de echte data)", () => {
    it("net onder de harde grens (deviationFactor 3.4) zonder hoge switch-rate: geaccepteerd", () => {
      const result = evaluateRouteQuality({ distanceM: 3400, straightLineDistanceM: 1000, switchCount: 0 });
      expect(result.verdict).toBe("geaccepteerd");
    });
    it("net boven de harde grens (deviationFactor 3.6): afgewezen, ongeacht switches", () => {
      const result = evaluateRouteQuality({ distanceM: 3600, straightLineDistanceM: 1000, switchCount: 0 });
      expect(result.verdict).toBe("afgewezen_hard");
    });
    it("twijfelachtig gebied (deviationFactor 3.0) MET veel overgangen: zacht afgewezen", () => {
      const result = evaluateRouteQuality({ distanceM: 3000, straightLineDistanceM: 1000, switchCount: 5 }); // 5 switches / 3km = 1.67/km
      expect(result.verdict).toBe("afgewezen_zacht");
    });
    it("twijfelachtig gebied (deviationFactor 3.0) MET weinig overgangen: geaccepteerd", () => {
      const result = evaluateRouteQuality({ distanceM: 3000, straightLineDistanceM: 1000, switchCount: 0 });
      expect(result.verdict).toBe("geaccepteerd");
    });
  });
});
