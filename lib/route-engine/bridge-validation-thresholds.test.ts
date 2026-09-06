import { describe, it, expect } from "vitest";
import { classifyBridgeAttempt, MAX_BRIDGE_DISTANCE_M, MIN_CIRCUITY_RATIO, MAX_CIRCUITY_RATIO } from "./bridge-validation-thresholds";

describe("classifyBridgeAttempt", () => {
  it.each([
    // [orsDistanceM, geographicDistanceM, verwachte status, omschrijving]
    [1415, 1181, "valid", "normale circuity, ruim binnen alle grenzen (echte meting, knooppunt 5)"],
    [3064, 2367, "valid", "normale circuity, ruim binnen alle grenzen (echte meting, NDSM->61)"],
    [1000, 1000, "valid", "circuity exact 1.0x -- perfect rechte lijn, geldig"],
    [800, 1000, "valid", "circuity exact 0.8x -- precies op MIN_CIRCUITY_RATIO, nog geldig (inclusief)"],
    [3000, 1000, "valid", "circuity exact 3.0x -- precies op MAX_CIRCUITY_RATIO, nog geldig (inclusief)"],
    [799, 1000, "rejected_circuity", "circuity 0.799x -- net onder MIN_CIRCUITY_RATIO, afgewezen"],
    [3001, 1000, "rejected_circuity", "circuity 3.001x -- net boven MAX_CIRCUITY_RATIO, afgewezen"],
    [10000, 5000, "rejected_distance", "circuity 2.0x maar afstand ruim boven MAX_BRIDGE_DISTANCE_M -- distance-check gaat voor"],
    [5000, 2000, "valid", "afstand exact op MAX_BRIDGE_DISTANCE_M -- grens is exclusief, dus nog geldig"],
    [5001, 2000, "rejected_distance", "afstand net boven MAX_BRIDGE_DISTANCE_M, geldige circuity (2.5x) -- toch afgewezen op afstand"],
  ] as const)("orsDistanceM=%i, geographicDistanceM=%i -> %s (%s)", (orsDistanceM, geographicDistanceM, expectedStatus, _description) => {
    const result = classifyBridgeAttempt(orsDistanceM, geographicDistanceM);
    expect(result.validationStatus).toBe(expectedStatus);
  });

  it("MAX_BRIDGE_DISTANCE_M is exclusief (5000m zelf is nog toegestaan)", () => {
    const result = classifyBridgeAttempt(MAX_BRIDGE_DISTANCE_M, 2000);
    expect(result.validationStatus).toBe("valid");
  });

  it("berekent circuityRatio correct en op 3 decimalen afgerond", () => {
    const result = classifyBridgeAttempt(1415, 1181);
    expect(result.circuityRatio).toBeCloseTo(1.198, 2);
  });

  it("rejectionReason is null bij valid, en bevat het concrete cijfer bij afwijzing (plan §8: audit-trail)", () => {
    const valid = classifyBridgeAttempt(1415, 1181);
    expect(valid.rejectionReason).toBeNull();

    const rejectedCircuity = classifyBridgeAttempt(5000, 1000); // 5.0x
    expect(rejectedCircuity.rejectionReason).toContain("5.00x");
    expect(rejectedCircuity.rejectionReason).toContain(String(MIN_CIRCUITY_RATIO));
    expect(rejectedCircuity.rejectionReason).toContain(String(MAX_CIRCUITY_RATIO));

    const rejectedDistance = classifyBridgeAttempt(6000, 3000); // 2.0x, maar >5000m
    expect(rejectedDistance.rejectionReason).toContain("6000m");
    expect(rejectedDistance.rejectionReason).toContain(String(MAX_BRIDGE_DISTANCE_M));
  });

  it("alle 12 kandidaten uit de empirische bidirectionaliteitstest (5-9-2026) zouden 'valid' zijn geweest", () => {
    // Regressie-anker: de daadwerkelijke 24 metingen uit de bridge-validator-run,
    // zodat een toekomstige drempelwijziging bewust moet breken met dit bewijs,
    // niet per ongeluk.
    const measurements: [number, number][] = [
      [1415, 1181], [1415, 1181], // knpt5<->kandidaat1, symmetrisch
      [2881, 2264], [3193, 2264],
      [2685, 2329], [2671, 2329],
      [3064, 2367], [3068, 2367],
      [2997, 2629], [3012, 2629],
      [1318, 1234], [1312, 1234],
      [1651, 1404], [1476, 1404],
      [2009, 1757], [1870, 1757],
      [1312, 1234], [1318, 1234],
      [2757, 2247], [2794, 2247],
      [2671, 2329], [2685, 2329],
    ];
    for (const [orsDistanceM, geographicDistanceM] of measurements) {
      expect(classifyBridgeAttempt(orsDistanceM, geographicDistanceM).validationStatus).toBe("valid");
    }
  });
});
