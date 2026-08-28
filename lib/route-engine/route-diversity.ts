/**
 * Route-diversiteitscontract (GPT-review 26-8-2026): "vier routes" betekent
 * niet automatisch vier verschillende routes. Diversiteit wordt hier bepaald
 * op basis van afwijkende edges/segmenten -- geen voorkeuren, geen AI, dat
 * komt pas later.
 *
 * Overlap = Jaccard-gelijkenis van de twee edge-sets:
 *   |A ∩ B| / |A ∪ B|
 * 1.0 = identieke edge-set (zelfde route), 0.0 = geen enkele gedeelde edge.
 */
export function edgeOverlapRatio(edgesA: string[], edgesB: string[]): number {
  const setA = new Set(edgesA);
  const setB = new Set(edgesB);
  if (setA.size === 0 && setB.size === 0) return 1; // twee lege routes (zelfde node) tellen als identiek

  let intersectionSize = 0;
  for (const id of setA) {
    if (setB.has(id)) intersectionSize++;
  }
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}
