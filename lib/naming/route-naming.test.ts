import { describe, it, expect } from "vitest";
import { pickNamingPoints, buildNameFromPlaces, makeNameUnique } from "./route-naming";

describe("pickNamingPoints", () => {
  it("geeft null terug bij een lege geometrie", () => {
    expect(pickNamingPoints([])).toBeNull();
  });

  it("geeft hetzelfde punt tweemaal terug bij een geometrie van 1 punt", () => {
    const result = pickNamingPoints([{ x: 0, y: 0 }]);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 0, y: 0 }]);
  });

  it("kiest het beginpunt en het (hemelsbreed) verste punt", () => {
    const geometry = [
      { x: 0, y: 0 }, // start
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 5000, y: 0 }, // duidelijk het verste punt van start
      { x: 50, y: 50 },
      { x: 0, y: 0 }, // rondje sluit weer bij start
    ];
    const result = pickNamingPoints(geometry);
    expect(result).toEqual([{ x: 0, y: 0 }, { x: 5000, y: 0 }]);
  });

  it("kiest maar TWEE punten, ongeacht hoe lang de geometrie is (nooit systematisch elk punt bevragen)", () => {
    const bigGeometry = Array.from({ length: 500 }, (_, i) => ({ x: i, y: i }));
    const result = pickNamingPoints(bigGeometry);
    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
  });
});

describe("buildNameFromPlaces", () => {
  it("geeft null terug als geen enkele plaats gevonden is", () => {
    expect(buildNameFromPlaces([null, null])).toBeNull();
  });

  it("bouwt 'Rondje X' bij precies één (unieke) gevonden plaats", () => {
    expect(buildNameFromPlaces(["Edam", "Edam"])).toBe("Rondje Edam");
  });

  it("bouwt 'X -- Y' bij twee verschillende plaatsen", () => {
    expect(buildNameFromPlaces(["Edam", "Volendam"])).toBe("Edam -- Volendam");
  });

  it("negeert null-waarden tussen wel-gevonden plaatsen", () => {
    expect(buildNameFromPlaces(["Edam", null])).toBe("Rondje Edam");
  });
});

describe("makeNameUnique", () => {
  it("geeft de naam ongewijzigd terug als die nog niet bestaat", () => {
    expect(makeNameUnique("Rondje Edam -- Volendam", [])).toBe("Rondje Edam -- Volendam");
  });

  it("voegt '(2)' toe als de naam al bestaat", () => {
    expect(makeNameUnique("Rondje Edam -- Volendam", ["Rondje Edam -- Volendam"])).toBe("Rondje Edam -- Volendam (2)");
  });

  it("telt door naar '(3)' als '(2)' ook al bestaat", () => {
    const existing = ["Rondje Edam -- Volendam", "Rondje Edam -- Volendam (2)"];
    expect(makeNameUnique("Rondje Edam -- Volendam", existing)).toBe("Rondje Edam -- Volendam (3)");
  });
});
