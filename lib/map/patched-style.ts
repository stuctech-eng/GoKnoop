import type { StyleSpecification, LayerSpecification, ExpressionSpecification } from "maplibre-gl";

/**
 * Laadt de Liberty-stijl en wrapt elke text-field-expressie in to-string()
 * (6-9-2026, n.a.v. het "i.codePointAt is not a function"-onderzoek).
 *
 * BELANGRIJK: dit is een goed-onderbouwde, laag-risico POGING, GEEN bevestigde
 * fix. De A/B-test in de tile-inspector (labels aan/uit) toonde overtuigend
 * aan dat de labelweergave de trigger is, maar een sluitende, herhaalde
 * bevestiging dat to-string() de crash daadwerkelijk voorkomt is er nooit
 * gekomen (de diagnostische sessie liep vast op een apart laadprobleem in de
 * debug-tool zelf, vóórdat die test kon worden afgerond). Behandel dit dus
 * als "kan geen kwaad, mogelijk helpt het", niet als bewezen opgelost.
 *
 * Bij een netwerkfout (fetch mislukt, JSON ongeldig) valt dit terug op de
 * kale style-URL -- MapLibre haalt en verwerkt die dan zelf, zoals voorheen.
 * De app mag nooit breken doordat deze patchpoging zelf faalt.
 */
export async function loadPatchedLibertyStyle(styleUrl: string): Promise<StyleSpecification | string> {
  try {
    const res = await fetch(styleUrl);
    if (!res.ok) return styleUrl;
    const style = (await res.json()) as StyleSpecification;
    return patchTextFieldsWithToString(style);
  } catch {
    return styleUrl;
  }
}

function patchTextFieldsWithToString(style: StyleSpecification): StyleSpecification {
  for (const layer of (style.layers as LayerSpecification[]) || []) {
    if (layer.type !== "symbol") continue;
    const layout = (layer as { layout?: Record<string, unknown> }).layout;
    const textField = layout?.["text-field"];
    if (Array.isArray(textField) && textField[0] !== "to-string") {
      (layout as Record<string, unknown>)["text-field"] = ["to-string", textField] as unknown as ExpressionSpecification;
    }
  }
  return style;
}
