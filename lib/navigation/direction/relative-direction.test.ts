import { describe, it, expect } from "vitest";
import {
  normalizeAngleDeg,
  relativeAngleDeg,
  classifyDirection,
  smoothHeadingDeg,
  selectHeadingDeg,
  hasArrivedAtNode,
  DEFAULT_DIRECTION_THRESHOLDS,
} from "./relative-direction";

describe("normalizeAngleDeg", () => {
  it("laat hoeken binnen (-180,180] ongewijzigd", () => {
    expect(normalizeAngleDeg(0)).toBe(0);
    expect(normalizeAngleDeg(90)).toBe(90);
    expect(normalizeAngleDeg(-90)).toBe(-90);
    expect(normalizeAngleDeg(180)).toBe(180);
  });
  it("wikkelt hoeken boven 180 correct terug", () => {
    expect(normalizeAngleDeg(270)).toBe(-90);
    expect(normalizeAngleDeg(360)).toBe(0);
    expect(normalizeAngleDeg(400)).toBe(40);
  });
  it("wikkelt hoeken onder -180 correct terug", () => {
    expect(normalizeAngleDeg(-270)).toBe(90);
    expect(normalizeAngleDeg(-400)).toBe(-40);
  });
});

describe("relativeAngleDeg — AC2/AC3/AC4: links/rechts/rechtdoor correct t.o.v. de rijrichting", () => {
  it("bearing gelijk aan heading -> 0 (rechtdoor)", () => {
    expect(relativeAngleDeg(90, 90)).toBe(0);
  });
  it("bearing 90° rechts van de heading -> positief (rechts, per de gekozen conventie)", () => {
    expect(relativeAngleDeg(180, 90)).toBe(90);
  });
  it("bearing 90° links van de heading -> negatief (links)", () => {
    expect(relativeAngleDeg(0, 90)).toBe(-90);
  });
  it("bearing recht achter de heading -> ±180", () => {
    expect(Math.abs(relativeAngleDeg(270, 90))).toBe(180);
  });
  it("werkt correct over de 0°/360°-grens heen", () => {
    expect(relativeAngleDeg(10, 350)).toBe(20);
  });
});

describe("classifyDirection — AC2/AC3/AC4", () => {
  it("classificeert kleine afwijkingen als RECHTDOOR", () => {
    expect(classifyDirection(0)).toBe("RECHTDOOR");
    expect(classifyDirection(10)).toBe("RECHTDOOR");
    expect(classifyDirection(-15)).toBe("RECHTDOOR");
  });
  it("classificeert matige afwijkingen als LICHT_LINKS/LICHT_RECHTS", () => {
    expect(classifyDirection(30)).toBe("LICHT_RECHTS");
    expect(classifyDirection(-30)).toBe("LICHT_LINKS");
    expect(classifyDirection(45)).toBe("LICHT_RECHTS");
  });
  it("classificeert grotere afwijkingen als LINKS/RECHTS (AC2/AC3)", () => {
    expect(classifyDirection(90)).toBe("RECHTS");
    expect(classifyDirection(-90)).toBe("LINKS");
    expect(classifyDirection(135)).toBe("RECHTS");
  });
  it("classificeert grote afwijkingen als ACHTERUIT", () => {
    expect(classifyDirection(170)).toBe("ACHTERUIT");
    expect(classifyDirection(-170)).toBe("ACHTERUIT");
    expect(classifyDirection(180)).toBe("ACHTERUIT");
  });
  it("accepteert aangepaste, niet-standaard drempels (kalibratie, nog niet definitief)", () => {
    const looseThresholds = { straightMaxAbsDeg: 30, slightMaxAbsDeg: 60, turnMaxAbsDeg: 150 };
    expect(classifyDirection(25, looseThresholds)).toBe("RECHTDOOR");
  });
  it("standaarddrempels zijn precies zoals in de spec gespecificeerd", () => {
    expect(DEFAULT_DIRECTION_THRESHOLDS).toEqual({ straightMaxAbsDeg: 15, slightMaxAbsDeg: 45, turnMaxAbsDeg: 135 });
  });
});

describe("smoothHeadingDeg — AC7: geen nerveuze rotatie", () => {
  it("geeft de ruwe waarde terug bij de eerste meting (geen vorige waarde)", () => {
    expect(smoothHeadingDeg(null, 90, 0.3)).toBe(90);
  });
  it("beweegt slechts een fractie richting de nieuwe meting (alpha < 1 dempt de sprong)", () => {
    const result = smoothHeadingDeg(0, 90, 0.5);
    expect(result).toBe(45);
  });
  it("alpha = 1 geeft direct de ruwe waarde (geen smoothing)", () => {
    expect(smoothHeadingDeg(0, 90, 1)).toBe(90);
  });
  it("alpha = 0 houdt de vorige waarde volledig vast (maximale demping)", () => {
    expect(smoothHeadingDeg(45, 200, 0)).toBe(45);
  });
  it("doorkruist de 0°/360°-grens via de KORTSTE weg, niet de lange omweg", () => {
    const result = smoothHeadingDeg(350, 10, 0.5);
    expect(result).toBeCloseTo(0, 6);
  });
});

describe("selectHeadingDeg — AC8: stabiele heading bij lage snelheid", () => {
  const options = { speedThresholdMps: 1.0 };

  it("gebruikt de GPS-bewegingsrichting tijdens voldoende snelheid", () => {
    const result = selectHeadingDeg({ gpsHeadingDeg: 120, speedMps: 3, previousStableHeadingDeg: 90 }, options);
    expect(result).toBe(120);
  });
  it("houdt de vorige stabiele richting vast bij lage snelheid (AC8)", () => {
    const result = selectHeadingDeg({ gpsHeadingDeg: 200, speedMps: 0.2, previousStableHeadingDeg: 90 }, options);
    expect(result).toBe(90);
  });
  it("houdt de vorige stabiele richting vast als GPS-heading ontbreekt, ook bij hoge snelheid", () => {
    const result = selectHeadingDeg({ gpsHeadingDeg: null, speedMps: 5, previousStableHeadingDeg: 90 }, options);
    expect(result).toBe(90);
  });
  it("geeft null terug als er nog nooit een stabiele richting was en de huidige meting niet bruikbaar is", () => {
    const result = selectHeadingDeg({ gpsHeadingDeg: null, speedMps: 0, previousStableHeadingDeg: null }, options);
    expect(result).toBeNull();
  });
  it("de snelheidsdrempel is exclusief (exact op de grens telt nog als 'niet snel genoeg')", () => {
    const result = selectHeadingDeg({ gpsHeadingDeg: 120, speedMps: 1.0, previousStableHeadingDeg: 90 }, options);
    expect(result).toBe(90);
  });
});

describe("hasArrivedAtNode", () => {
  it("true binnen de aankomstradius", () => {
    expect(hasArrivedAtNode(10, 25)).toBe(true);
    expect(hasArrivedAtNode(25, 25)).toBe(true);
  });
  it("false buiten de aankomstradius", () => {
    expect(hasArrivedAtNode(30, 25)).toBe(false);
  });
});
