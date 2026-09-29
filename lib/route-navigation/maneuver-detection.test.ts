import { describe, it, expect } from "vitest";
import { findNextManeuver, classifyManeuverDirection } from "./maneuver-detection";
import { wgs84ToRd, rdToWgs84 } from "@/lib/route-engine/coordinate-transform";
import type { LatLon } from "./types";

const ORIGIN_RD = wgs84ToRd(52.5, 5.0);
function rdOffset(dxM: number, dyM: number): LatLon {
  const p = rdToWgs84(ORIGIN_RD.x + dxM, ORIGIN_RD.y + dyM);
  return { lat: p.lat, lon: p.lon };
}

describe("findNextManeuver — GEEN tekstherkenning, puur geometrische bochthoek", () => {
  it("een rechte route (geen enkele bocht boven de drempel) levert geen manoeuvre op", () => {
    const straight: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(1000, 0), rdOffset(1500, 0)];
    const maneuver = findNextManeuver(straight, [], 0);
    expect(maneuver).toBeNull();
  });

  it("een duidelijke rechtsaf (oost -> zuid, 90°) wordt gevonden en correct als RECHTS geclassificeerd, VOLLEDIG ONAFHANKELIJK van instructietekst (steps leeg)", () => {
    // 0,0 -> 500,0 (oostwaarts, bearing 90°) -> 500,-500 (dan zuidwaarts, bearing 180°) --
    // een draai met de klok mee = rechtsaf.
    const route: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(500, -500)];
    const maneuver = findNextManeuver(route, [], 0); // steps = [] -- geen enkele tekst beschikbaar, moet toch werken
    expect(maneuver).not.toBeNull();
    expect(maneuver!.distanceToManeuverM).toBeCloseTo(500, 0);
    expect(classifyManeuverDirection(maneuver!.turnAngleDeg)).toBe("RECHTS");
  });

  it("een duidelijke linksaf (oost -> noord, 90° tegen de klok in) wordt correct als LINKS geclassificeerd", () => {
    // 0,0 -> 500,0 (oostwaarts, bearing 90°) -> 500,500 (dan noordwaarts, bearing 0°) --
    // een draai tegen de klok in = linksaf.
    const route: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(500, 500)];
    const maneuver = findNextManeuver(route, [], 0);
    expect(classifyManeuverDirection(maneuver!.turnAngleDeg)).toBe("LINKS");
  });

  it("een instructietekst die het TEGENOVERGESTELDE zegt van de werkelijke geometrie wordt genegeerd -- de geometrie wint altijd", () => {
    // Bewuste test van de expliciete aanscherping: zelfs als de (verzonnen, foutieve) tekst
    // "Turn left" zegt terwijl de geometrie een rechtsaf toont, moet de geometrisch bepaalde
    // richting leidend blijven.
    const route: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(500, -500)]; // geometrisch: RECHTS (zie test hierboven)
    const misleadingSteps = [{ name: "Misleidend Pad", instruction: "Turn left onto Misleidend Pad", distanceM: 500 }];
    const maneuver = findNextManeuver(route, misleadingSteps, 0);
    expect(classifyManeuverDirection(maneuver!.turnAngleDeg)).toBe("RECHTS"); // NIET "LINKS", ondanks de tekst
  });

  it("koppelt de dichtstbijzijnde straatnaam op basis van cumulatieve afstand, puur ter aanvulling", () => {
    const route: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(500, -500)];
    // De bocht ligt op ~500m; de eerste stap loopt hier ruim voorbij die grens (600m) om
    // drijvendekomma-afronding van de RD<->WGS84-conversie niet precies op de rand te laten
    // vallen (een test-detail, geen productiegedrag).
    const steps = [
      { name: "Eerste Straat", instruction: "Head east", distanceM: 600 },
      { name: "Tweede Straat", instruction: "Turn right", distanceM: 400 },
    ];
    const maneuver = findNextManeuver(route, steps, 0);
    expect(maneuver!.streetName).toBe("Eerste Straat");
  });

  it("een lichte, onschuldige bocht (ver onder de drempel) wordt NIET als manoeuvre gezien", () => {
    // Bijna rechte lijn met een heel licht knikje (~5-10°).
    const route: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(1000, 40)];
    const maneuver = findNextManeuver(route, [], 0);
    expect(maneuver).toBeNull();
  });

  it("zoekt vanaf de opgegeven huidige positie -- een al gepasseerde bocht wordt niet opnieuw gevonden", () => {
    // Eerste bocht bij 500m: oost(90°)->noord(0°) = LINKS. Tweede bocht bij 1000m:
    // noord(0°)->oost(90°) = RECHTS. Vanaf 600m (na de eerste bocht) moet de TWEEDE
    // gevonden worden, niet de eerste.
    const route: LatLon[] = [rdOffset(0, 0), rdOffset(500, 0), rdOffset(500, 500), rdOffset(1000, 500), rdOffset(1000, 0)];
    const fromStart = findNextManeuver(route, [], 0);
    expect(classifyManeuverDirection(fromStart!.turnAngleDeg)).toBe("LINKS"); // de eerste bocht

    const fromAfterFirst = findNextManeuver(route, [], 600);
    expect(classifyManeuverDirection(fromAfterFirst!.turnAngleDeg)).toBe("RECHTS"); // de tweede bocht
    expect(fromAfterFirst!.distanceToManeuverM).toBeCloseTo(1000 - 600, 0); // bocht op 1000m vanaf start, we zitten op 600m
  });

  it("geeft null terug voor een route met minder dan 3 punten (geen bocht mogelijk)", () => {
    expect(findNextManeuver([rdOffset(0, 0), rdOffset(500, 0)], [], 0)).toBeNull();
  });
});
