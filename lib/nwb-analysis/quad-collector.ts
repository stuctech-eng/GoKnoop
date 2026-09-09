/**
 * Quad-tree-opsplitsingslogica -- TIJDELIJKE onderzoeksinfrastructuur
 * (8-9-2026, "achtergrond-verzamelaar"). Geen productiefeature. Puur,
 * test bare functies, los van Firestore/netwerk, zodat de kernlogica
 * (vooral: wanneer splitsen, hoe splitsen) onafhankelijk te verifiëren is.
 */

export type Bbox = { minX: number; minY: number; maxX: number; maxY: number };

/** Splitst een bbox in 4 gelijke kwadranten (linksonder, rechtsonder, linksboven, rechtsboven). */
export function splitIntoQuadrants(bbox: Bbox): [Bbox, Bbox, Bbox, Bbox] {
  const midX = (bbox.minX + bbox.maxX) / 2;
  const midY = (bbox.minY + bbox.maxY) / 2;
  return [
    { minX: bbox.minX, minY: bbox.minY, maxX: midX, maxY: midY }, // linksonder
    { minX: midX, minY: bbox.minY, maxX: bbox.maxX, maxY: midY }, // rechtsonder
    { minX: bbox.minX, minY: midY, maxX: midX, maxY: bbox.maxY }, // linksboven
    { minX: midX, minY: midY, maxX: bbox.maxX, maxY: bbox.maxY }, // rechtsboven
  ];
}

/** Oppervlakte van een bbox in km^2 (RD-coördinaten zijn in meters). */
export function bboxAreaKm2(bbox: Bbox): number {
  return ((bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY)) / 1_000_000;
}

/**
 * Bepaalt of een tegel verder gesplitst moet worden. Twee onafhankelijke
 * redenen: (a) de NWB-aanvraag zelf werd afgekapt (te veel segmenten voor de
 * paginalimiet), of (b) de tegel is nog groter dan een praktisch maximum
 * (voorkomt dat we op basis van toeval nooit afkapping tegenkomen bij een
 * dun-bewoond gebied, maar de tegel toch onhandig groot blijft voor de
 * latere graafopbouw). Een harde ondergrens (MIN_TILE_SIZE_M) voorkomt
 * oneindig doorsplitsen als een gebied structureel > paginalimiet blijft
 * (bijvoorbeeld een fout in de telling) -- in dat geval wordt de tegel
 * geaccepteerd zoals-ie is, met een waarschuwing, in plaats van eindeloos
 * te blijven splitsen.
 */
export function shouldSplit(bbox: Bbox, wasTruncated: boolean, maxAreaKm2 = 30): { split: boolean; reason: string } {
  const widthM = bbox.maxX - bbox.minX;
  const MIN_TILE_SIZE_M = 200; // ondergrens: bij twijfel niet eindeloos doorsplitsen
  if (widthM <= MIN_TILE_SIZE_M) {
    return { split: false, reason: "ondergrens bereikt (200m) -- geaccepteerd ondanks eventuele afkapping" };
  }
  if (wasTruncated) {
    return { split: true, reason: "NWB-aanvraag was afgekapt" };
  }
  if (bboxAreaKm2(bbox) > maxAreaKm2) {
    return { split: true, reason: `tegel groter dan praktisch maximum (${maxAreaKm2}km²)` };
  }
  return { split: false, reason: "compleet en binnen praktische grootte" };
}

/** Genereert een stabiel, leesbaar tegel-ID op basis van pad in de boom (bv. "0" -> "0-2" -> "0-2-1"). */
export function childTileId(parentId: string, quadrantIndex: 0 | 1 | 2 | 3): string {
  return `${parentId}-${quadrantIndex}`;
}
