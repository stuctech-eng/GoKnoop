import { describe, it, expect } from "vitest";
import { splitIntoQuadrants, bboxAreaKm2, shouldSplit, childTileId } from "./quad-collector";

describe("quad-collector", () => {
  describe("splitIntoQuadrants", () => {
    it("splitst in exact 4 gelijke kwadranten die samen de oorspronkelijke bbox dekken, zonder gat of overlap", () => {
      const bbox = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
      const [q0, q1, q2, q3] = splitIntoQuadrants(bbox);

      // Elk kwadrant is een kwart van de oppervlakte.
      for (const q of [q0, q1, q2, q3]) {
        expect(bboxAreaKm2(q)).toBeCloseTo(bboxAreaKm2(bbox) / 4, 10);
      }

      // Samen exact de originele bbox dekken (min/max van alle kwadranten samen).
      const combinedMinX = Math.min(q0.minX, q1.minX, q2.minX, q3.minX);
      const combinedMaxX = Math.max(q0.maxX, q1.maxX, q2.maxX, q3.maxX);
      const combinedMinY = Math.min(q0.minY, q1.minY, q2.minY, q3.minY);
      const combinedMaxY = Math.max(q0.maxY, q1.maxY, q2.maxY, q3.maxY);
      expect(combinedMinX).toBe(bbox.minX);
      expect(combinedMaxX).toBe(bbox.maxX);
      expect(combinedMinY).toBe(bbox.minY);
      expect(combinedMaxY).toBe(bbox.maxY);

      // Geen overlap: elk kwadrant se hoekpunten liggen op het midden of de rand.
      expect(q0.maxX).toBe(q1.minX);
      expect(q0.maxY).toBe(q2.minY);
      expect(q3.minX).toBe(q1.minX); // beide = midX
      expect(q3.minX).toBe(q2.maxX); // beide = midX
      expect(q1.maxY).toBe(q3.minY);
      expect(q2.maxX).toBe(q3.minX);
    });

    it("werkt ook voor niet-vierkante (rechthoekige) bboxen", () => {
      const bbox = { minX: 0, minY: 0, maxX: 200, maxY: 50 };
      const quadrants = splitIntoQuadrants(bbox);
      const totalArea = quadrants.reduce((sum, q) => sum + bboxAreaKm2(q), 0);
      expect(totalArea).toBeCloseTo(bboxAreaKm2(bbox), 10);
    });
  });

  describe("shouldSplit", () => {
    it("splitst wanneer de aanvraag was afgekapt, ook als de tegel al klein is (maar boven de ondergrens)", () => {
      const bbox = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 }; // 1km²
      const result = shouldSplit(bbox, true);
      expect(result.split).toBe(true);
    });

    it("splitst NIET wanneer niet afgekapt en binnen het praktische maximum", () => {
      const bbox = { minX: 0, minY: 0, maxX: 3000, maxY: 3000 }; // 9km², onder 30km² default
      const result = shouldSplit(bbox, false);
      expect(result.split).toBe(false);
    });

    it("splitst OOK zonder afkapping als de tegel te groot is (praktisch maximum)", () => {
      const bbox = { minX: 0, minY: 0, maxX: 10000, maxY: 10000 }; // 100km², boven 30km² default
      const result = shouldSplit(bbox, false);
      expect(result.split).toBe(true);
    });

    it("stopt met splitsen bij de ondergrens (200m), zelfs als afgekapt -- voorkomt oneindige recursie", () => {
      const bbox = { minX: 0, minY: 0, maxX: 150, maxY: 150 }; // 150m breed, onder de 200m-ondergrens
      const result = shouldSplit(bbox, true);
      expect(result.split).toBe(false);
      expect(result.reason).toContain("ondergrens");
    });
  });

  describe("childTileId", () => {
    it("bouwt een stabiel, uniek pad op per kwadrant", () => {
      expect(childTileId("root", 0)).toBe("root-0");
      expect(childTileId("root", 3)).toBe("root-3");
      expect(childTileId("root-0", 2)).toBe("root-0-2");
    });

    it("geeft nooit hetzelfde ID voor verschillende kwadranten van dezelfde ouder", () => {
      const ids = [0, 1, 2, 3].map((i) => childTileId("root", i as 0 | 1 | 2 | 3));
      expect(new Set(ids).size).toBe(4);
    });
  });
});
