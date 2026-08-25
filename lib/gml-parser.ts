/**
 * GML-parsers voor de Routedatabank-lagen. Regex-gebaseerd (geen volledige
 * XML-parser nodig) — dezelfde aanpak die de Phase 1C-diagnostiek al bewees.
 */

export type ParsedSourceNode = {
  sourceObjectId: string;
  knooppuntnr: string;
  regio: string;
  provincie: string;
  soortKnooppunt: string;
  x: number;
  y: number;
};

export function parseFietsknooppuntenVrij(xml: string): ParsedSourceNode[] {
  const nodes: ParsedSourceNode[] = [];
  const memberRegex =
    /<routedatabank:fietsknooppunten_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsknooppunten_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const field = (name: string) => {
      const fm = new RegExp(`<routedatabank:${name}>([^<]*)</routedatabank:${name}>`).exec(block);
      return fm ? fm[1] : "";
    };
    const posMatch = /<gml:pos>([^<]*)<\/gml:pos>/.exec(block);
    if (posMatch) {
      const [x, y] = posMatch[1].trim().split(/\s+/).map(Number);
      nodes.push({
        sourceObjectId: field("objectid"),
        knooppuntnr: field("knooppuntnr"),
        regio: field("regio"),
        provincie: field("provincie"),
        soortKnooppunt: field("soort_knooppunt"),
        x,
        y,
      });
    }
  }
  return nodes;
}

export type ParsedEdge = {
  sourceObjectId: string;
  regio: string;
  provincie: string;
  rijrichting: string;
  distanceM: number;
  coords: { x: number; y: number }[];
};

export function parseFietsnetwerkenVrij(xml: string): ParsedEdge[] {
  const edges: ParsedEdge[] = [];
  const memberRegex =
    /<routedatabank:fietsnetwerken_vrij[^>]*>([\s\S]*?)<\/routedatabank:fietsnetwerken_vrij>/g;
  let m: RegExpExecArray | null;
  while ((m = memberRegex.exec(xml))) {
    const block = m[1];
    const field = (name: string) => {
      const fm = new RegExp(`<routedatabank:${name}>([^<]*)</routedatabank:${name}>`).exec(block);
      return fm ? fm[1] : "";
    };
    const posListMatch = /<gml:posList>([^<]*)<\/gml:posList>/.exec(block);
    if (posListMatch) {
      const flat = posListMatch[1].trim().split(/\s+/).map(Number);
      const coords: { x: number; y: number }[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        coords.push({ x: flat[i], y: flat[i + 1] });
      }
      edges.push({
        sourceObjectId: field("objectid"),
        regio: field("regio"),
        provincie: field("provincie"),
        rijrichting: field("rijrichting"),
        distanceM: parseFloat(field("lengte_m") || "0"),
        coords,
      });
    }
  }
  return edges;
}
