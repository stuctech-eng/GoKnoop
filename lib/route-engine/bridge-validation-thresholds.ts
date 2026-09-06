import type { NetworkBridgeValidationStatus } from "./network-bridge-types";

/**
 * Kwaliteitsdrempels voor de Network Bridge Layer (plan §7,
 * docs/network-bridge-layer-plan.md). Losgetrokken als pure functie uit
 * `generate-bridges/route.ts` zodat dit -- de meest risicovolle logica in de
 * hele laag, "fout classificeren = stilzwijgend verkeerde bridges
 * accepteren/afwijzen" -- daadwerkelijk unit-getest kan worden, consistent met
 * hoe `is-traversable.ts` als eigen module bestaat.
 */
export const MAX_BRIDGE_DISTANCE_M = 5000;
export const MIN_CIRCUITY_RATIO = 0.8;
export const MAX_CIRCUITY_RATIO = 3.0;

export type BridgeClassification = {
  validationStatus: NetworkBridgeValidationStatus;
  rejectionReason: string | null;
  circuityRatio: number;
};

/**
 * @param orsDistanceM De door ORS gevonden fietsroute-afstand (moet al gecontroleerd
 *   zijn op "route gevonden" -- deze functie behandelt alleen het geval waarin ORS
 *   wél een route teruggaf; `rejected_no_route` wordt door de caller apart afgehandeld
 *   vóórdat deze functie wordt aangeroepen).
 * @param geographicDistanceM Hemelsbrede afstand tussen source en target (RD).
 */
export function classifyBridgeAttempt(orsDistanceM: number, geographicDistanceM: number): BridgeClassification {
  const circuityRatio = orsDistanceM / geographicDistanceM;

  if (orsDistanceM > MAX_BRIDGE_DISTANCE_M) {
    return {
      validationStatus: "rejected_distance",
      rejectionReason: `ORS-afstand ${Math.round(orsDistanceM)}m boven MAX_BRIDGE_DISTANCE_M ${MAX_BRIDGE_DISTANCE_M}m`,
      circuityRatio: Number(circuityRatio.toFixed(3)),
    };
  }
  if (circuityRatio < MIN_CIRCUITY_RATIO || circuityRatio > MAX_CIRCUITY_RATIO) {
    return {
      validationStatus: "rejected_circuity",
      rejectionReason: `circuity ${circuityRatio.toFixed(2)}x buiten [${MIN_CIRCUITY_RATIO}, ${MAX_CIRCUITY_RATIO}]`,
      circuityRatio: Number(circuityRatio.toFixed(3)),
    };
  }
  return { validationStatus: "valid", rejectionReason: null, circuityRatio: Number(circuityRatio.toFixed(3)) };
}
