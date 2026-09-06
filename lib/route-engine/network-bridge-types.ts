/**
 * Network Bridge Layer — types (implementatieplan `network-bridge-layer-plan.md`,
 * §1/§2, GPT-review 5-9-2026). Bewust gescheiden van `lib/route-engine/types.ts`
 * -- zelfde modulaire patroon als `lib/local-bike-router/types.ts`: een aparte
 * laag, geen wijziging aan de bestaande Route Engine-types.
 */

/** Alleen tijdens de compute-fase in memory -- nooit persistent opgeslagen (plan §1). */
export type BridgeCandidate = {
  sourceNodeId: string;
  sourceComponentSize: number;
  targetNodeId: string;
  targetComponentSize: number;
  geographicDistanceM: number;
};

export type NetworkBridgeValidationStatus =
  | "valid"
  | "rejected_no_route" // ORS gaf expliciet aan: geen fietsroute mogelijk (echte afwijzing)
  | "rejected_circuity"
  | "rejected_distance"
  | "rejected_component"
  | "rejected_provider_error"; // 429/HTTP-fout/onverwachte respons NA uitgeputte retries -- GEEN uitspraak over of er een route bestaat, alleen dat de validatie zelf mislukte (5-9-2026, n.a.v. ORS-rate-limit-incident)

/**
 * Persistent, in Firestore-collectie `networkBridges` (plan §2/§3). Directioneel:
 * sourceNodeId -> targetNodeId is EEN richting; de omgekeerde richting is een
 * apart document met omgewisselde source/target (plan-correctie GPT 5-9-2026,
 * n.a.v. de 24-richtingentest -- zie docs/network-bridge-layer-plan.md §3-bis).
 */
export type NetworkBridge = {
  id: string; // `${datasetVersionId}_${sourceNodeId}_${targetNodeId}` -- NIET gesorteerd (plan §8, gecorrigeerd)
  datasetVersionId: string;
  /** Welk gap-signaal deze bridge opleverde ("strong"=edgeCount===0, "weak"=edgeCount===1+kleine component). Puur provenance/reset-doeleinden, geen invloed op routing. */
  scope: "strong" | "weak";
  sourceNodeId: string;
  targetNodeId: string;
  distanceM: number;
  durationS: number;
  /** WGS84 (lat/lon), zoals `LocalBikeRouteResult.geometry` het aanlevert -- RD-conversie gebeurt pas bij `toGraphEdge()`. */
  geometry: { lat: number; lon: number }[];
  routingProvider: "openrouteservice";
  routingProfile: "cycling";
  circuityRatio: number;
  validationStatus: NetworkBridgeValidationStatus;
  rejectionReason: string | null;
  sourceComponentSizeAtCreation: number;
  targetComponentSizeAtCreation: number;
  createdAt: string; // ISO
};
