/**
 * Classificatie van NWB-wegvakken naar fietsrelevantie -- TIJDELIJK, alleen
 * voor de validatietest (8-9-2026). Gebaseerd op de officiële BST_CODE-
 * waardelijst (NWB-Aanleverspecificatie Bijlage A, geverifieerd via
 * webzoekopdracht 8-9-2026):
 *
 *   FP=Fietspad, HR=Hoofdrijbaan, VP=Voetpad, BU=Busbaan, RB=Rijbaan
 *   (default sinds de verplichte-vulling-update), plus een reeks
 *   verbindingsweg/oprit/afrit/rotonde-varianten die primair voor
 *   gemotoriseerd verkeer bedoeld zijn.
 *
 * SET A (conservatief): uitsluitend BST_CODE = 'FP' -- ondubbelzinnig een
 * fietspad, geen interpretatie nodig.
 *
 * SET B (ruim): FP + HR + RB, MINUS rijksautosnelwegen (wegnummer begint met
 * 'A' -- dit is exact hoe RWS zelf autosnelwegen afleidt, bevestigd via
 * dezelfde bron) EN MINUS BU (busbaan, doorgaans niet voor fietsers).
 * Rationale: in Nederland is fietsen op een gewone rijbaan/hoofdrijbaan in
 * de regel toegestaan tenzij expliciet verboden (zoals op autosnelwegen/
 * autowegen) -- maar dit is een AANNAME over toegankelijkheid die de
 * NWB-attributen zelf niet met zekerheid bevestigen (vandaar "ruim", niet
 * "zeker").
 */

export type NwbClassification = "setA" | "setB" | "excluded";

export function classifySegment(bstCode: string | null, wegnummer: string | null): NwbClassification {
  const isRijksautosnelweg = !!wegnummer && /^A\d/i.test(wegnummer.trim());
  if (isRijksautosnelweg) return "excluded";

  if (bstCode === "FP") return "setA";
  if (bstCode === "HR" || bstCode === "RB") return "setB";
  return "excluded";
}

export const SET_A_BST_CODES = ["FP"];
export const SET_B_BST_CODES = ["FP", "HR", "RB"];
