import type { Point } from "./types";

/**
 * "Plus lusje" -- extra kilometers toevoegen aan "route naar een adres"
 * (sectie 9.49, 30-8-2026). Op verzoek: keuzemenu met een aantal extra km,
 * voorlopig ALLEEN voor deze functie (nog niet voor Back to Start).
 *
 * Kernidee: in plaats van de kortste weg (origin → bestemming), een
 * TUSSENPUNT kiezen dat opzij van de directe lijn ligt, zodat
 * origin → tussenpunt → bestemming ongeveer de gevraagde extra afstand
 * toevoegt. Reken-technisch een ellips-eigenschap: voor een punt P met
 * |origin-P| + |P-bestemming| = L + extra (L = directe afstand), ligt P op
 * een ellips met brandpunten origin/bestemming. Het punt loodrecht op het
 * midden van de lijn (de "breedste" plek van de ellips) heeft een simpele,
 * exacte formule.
 */

/**
 * Berekent het perpendiculaire aanbodpunt (RD-coördinaten) voor een gevraagde
 * extra afstand. `side` bepaalt aan welke kant van de directe lijn (er zijn
 * altijd twee symmetrische opties). `circuityFactor` compenseert dat een
 * ECHTE route via het knooppuntennetwerk nooit zo recht is als een rechte
 * lijn (zelfde soort correctie als bij de rondje-generator, sectie 6B) --
 * zonder deze correctie zou de uiteindelijke, echte omweg vaak flink meer
 * extra afstand toevoegen dan gevraagd.
 */
export function computeDetourOffsetPoint(
  origin: Point,
  destination: Point,
  extraM: number,
  side: "left" | "right",
  circuityFactor: number = 1.4
): Point {
  const dx = destination.x - origin.x;
  const dy = destination.y - origin.y;
  const directDistanceM = Math.hypot(dx, dy);

  // Loodrechte afstand h vanaf het midden van de lijn, zodat een DRIEHOEK
  // origin-P-bestemming (twee rechte zijden) exact `extraM` méér oplevert
  // dan de directe lijn: 2*sqrt((L/2)^2 + h^2) = L + extraM.
  const adjustedExtraM = extraM / circuityFactor; // circuity-correctie
  const hSquared = (2 * directDistanceM * adjustedExtraM + adjustedExtraM ** 2) / 4;
  const h = Math.sqrt(Math.max(0, hSquared));

  const midX = (origin.x + destination.x) / 2;
  const midY = (origin.y + destination.y) / 2;

  if (directDistanceM === 0) {
    // Origin en bestemming vallen samen (zeldzaam randgeval) -- kies een willekeurige richting.
    return { x: midX + h, y: midY };
  }

  // Eenheidsvector loodrecht op de origin->bestemming-lijn.
  const perpX = -dy / directDistanceM;
  const perpY = dx / directDistanceM;
  const sign = side === "left" ? 1 : -1;

  return { x: midX + sign * perpX * h, y: midY + sign * perpY * h };
}
