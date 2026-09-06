import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from "maplibre-gl";

export type PatchedStyleResult = {
  style: StyleSpecification | string;
  patched: boolean;
  patchedLayerCount: number;
  fallbackReason: string | null;
};

/**
 * Laadt de Liberty-stijl en wrapt elke text-field-expressie in to-string()
 * (6-9-2026, n.a.v. het "i.codePointAt is not a function"-onderzoek).
 *
 * BELANGRIJK: dit is een goed-onderbouwde, laag-risico POGING, GEEN bevestigde
 * fix. De A/B-test in de tile-inspector (labels aan/uit) toonde overtuigend
 * aan dat de labelweergave de trigger is; de eerste 10->0-simulatietest leek
 * de fix te bevestigen, maar productielogs (6-9-2026, 15:13-15:27, dus NA het
 * live gaan van deze patch) tonen de crash nog steeds op dezelfde Lochem-
 * locatie. Vandaar deze uitbreiding: expliciet, zichtbaar loggen OF de patch
 * daadwerkelijk is toegepast, i.p.v. stil terug te vallen -- dat was tot nu
 * toe niet te zien, dus we konden niet uitsluiten dat de patch in productie
 * om een onbekende reden helemaal niet actief was.
 *
 * Bij een netwerkfout (fetch mislukt, JSON ongeldig) valt dit terug op de
 * kale style-URL -- MapLibre haalt en verwerkt die dan zelf, zoals voorheen.
 * De app mag nooit breken doordat deze patchpoging zelf faalt.
 */
export async function loadPatchedLibertyStyle(styleUrl: string): Promise<PatchedStyleResult> {
  try {
    const res = await fetch(styleUrl);
    if (!res.ok) {
      return { style: styleUrl, patched: false, patchedLayerCount: 0, fallbackReason: `HTTP ${res.status} bij ophalen stijl` };
    }
    const style = (await res.json()) as StyleSpecification;
    const patchedLayerCount = patchTextFieldsWithToString(style);
    return { style, patched: true, patchedLayerCount, fallbackReason: null };
  } catch (err) {
    return { style: styleUrl, patched: false, patchedLayerCount: 0, fallbackReason: err instanceof Error ? err.message : String(err) };
  }
}

/** Retourneert het aantal layers dat daadwerkelijk gepatcht is (voor zichtbaarheid/logging). */
function patchTextFieldsWithToString(style: StyleSpecification): number {
  let count = 0;
  for (const layer of (style.layers as LayerSpecification[]) || []) {
    if (layer.type !== "symbol") continue;
    const layout = (layer as { layout?: Record<string, unknown> }).layout;
    const textField = layout?.["text-field"];
    if (Array.isArray(textField) && textField[0] !== "to-string") {
      (layout as Record<string, unknown>)["text-field"] = ["to-string", textField] as unknown as ExpressionSpecification;
      count++;
    }
  }
  return count;
}
