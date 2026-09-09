import { describe, it, expect } from "vitest";
import { analyzeNwbGraph, analyzeSlimNwbGraph } from "./graph-analysis";
import type { NwbSegment } from "./nwb-client";

describe("graph-analysis", () => {
  describe("analyzeNwbGraph (bestaand, regressie-controle na de bewerking van dit bestand)", () => {
    it("herkent twee segmenten die elkaar raken als één component", () => {
      const segments: NwbSegment[] = [
        { id: "a", bstCode: "FP", wegnummer: null, straatnaam: null, wegbeheerder: null, coordinates: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { id: "b", bstCode: "FP", wegnummer: null, straatnaam: null, wegbeheerder: null, coordinates: [{ x: 100, y: 0 }, { x: 200, y: 0 }] },
      ];
      const result = analyzeNwbGraph(segments, 5);
      expect(result.componentCount).toBe(1);
      expect(result.largestComponentSize).toBe(4); // 4 node-id's (a:from, a:to, b:from, b:to) -- a:to/b:from delen dezelfde positie maar zijn losse ID's
    });

    it("herkent twee segmenten die NIET elkaar raken als twee aparte componenten", () => {
      const segments: NwbSegment[] = [
        { id: "a", bstCode: "FP", wegnummer: null, straatnaam: null, wegbeheerder: null, coordinates: [{ x: 0, y: 0 }, { x: 100, y: 0 }] },
        { id: "b", bstCode: "FP", wegnummer: null, straatnaam: null, wegbeheerder: null, coordinates: [{ x: 500, y: 0 }, { x: 600, y: 0 }] },
      ];
      const result = analyzeNwbGraph(segments, 5);
      expect(result.componentCount).toBe(2);
    });
  });

  describe("analyzeSlimNwbGraph (nieuw, voor het slanke verzamelaar-formaat)", () => {
    it("herkent twee slanke segmenten die elkaar raken als één component", () => {
      const segments = [
        { id: "a", from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, lengthM: 100 },
        { id: "b", from: { x: 100, y: 0 }, to: { x: 200, y: 0 }, lengthM: 100 },
      ];
      const result = analyzeSlimNwbGraph(segments, 5);
      expect(result.componentCount).toBe(1);
      expect(result.largestComponentLengthM).toBe(200);
    });

    it("herkent twee slanke segmenten die NIET elkaar raken als twee aparte componenten", () => {
      const segments = [
        { id: "a", from: { x: 0, y: 0 }, to: { x: 100, y: 0 }, lengthM: 100 },
        { id: "b", from: { x: 500, y: 0 }, to: { x: 600, y: 0 }, lengthM: 100 },
      ];
      const result = analyzeSlimNwbGraph(segments, 5);
      expect(result.componentCount).toBe(2);
    });

    it("geeft hetzelfde componentaantal als analyzeNwbGraph voor equivalente input (consistentie tussen beide functies)", () => {
      const fullSegments: NwbSegment[] = [
        { id: "a", bstCode: "FP", wegnummer: null, straatnaam: null, wegbeheerder: null, coordinates: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }] },
        { id: "b", bstCode: "FP", wegnummer: null, straatnaam: null, wegbeheerder: null, coordinates: [{ x: 100, y: 0 }, { x: 200, y: 0 }] },
      ];
      const slimSegments = fullSegments.map((s) => {
        let lengthM = 0;
        for (let i = 1; i < s.coordinates.length; i++) lengthM += Math.hypot(s.coordinates[i].x - s.coordinates[i - 1].x, s.coordinates[i].y - s.coordinates[i - 1].y);
        return { id: s.id, from: s.coordinates[0], to: s.coordinates[s.coordinates.length - 1], lengthM };
      });

      const fullResult = analyzeNwbGraph(fullSegments, 5);
      const slimResult = analyzeSlimNwbGraph(slimSegments, 5);

      expect(slimResult.componentCount).toBe(fullResult.componentCount);
      expect(slimResult.largestComponentLengthM).toBe(fullResult.largestComponentLengthM);
    });
  });
});
