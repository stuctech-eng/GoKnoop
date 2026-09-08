import { describe, it, expect } from "vitest";
import { decodePolyline } from "./polyline";

describe("decodePolyline", () => {
  it("decodeert het officiële Google-referentievoorbeeld correct (precisie 5)", () => {
    // Bekend, gepubliceerd voorbeeld uit Google's encoded-polyline-documentatie --
    // valideert de kernalgoritme-logica, los van de Valhalla-specifieke precisie.
    const result = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@", 5);
    expect(result).toEqual([
      { lat: 38.5, lon: -120.2 },
      { lat: 40.7, lon: -120.95 },
      { lat: 43.252, lon: -126.453 },
    ]);
  });

  it("precisie 6 geeft kleinere coördinaatwaarden dan precisie 5 voor dezelfde string (10x-factor klopt)", () => {
    // Zelfde encoded string, andere precisie -- moet exact een factor 10
    // schelen (bevestigt dat de `factor`-parameter daadwerkelijk wordt
    // toegepast, niet genegeerd).
    const encoded = "_p~iF~ps|U";
    const [p5] = decodePolyline(encoded, 5);
    const [p6] = decodePolyline(encoded, 6);
    expect(p5.lat / p6.lat).toBeCloseTo(10, 5);
    expect(p5.lon / p6.lon).toBeCloseTo(10, 5);
  });

  it("geeft een lege lijst terug voor een lege string", () => {
    expect(decodePolyline("", 6)).toEqual([]);
  });
});
