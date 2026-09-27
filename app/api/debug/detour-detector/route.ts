import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * GET /api/debug/detour-detector
 *
 * "Alles controleren en checken" (19-9-2026, GO van Te), stap 2 van 2 -- vervolg op
 * `/api/import/graph-connectivity` (stap 1, telt losse componenten). DIT instrument
 * zoekt een ANDER, subtieler patroon: het Volendam-Hoorn-geval dat we handmatig vonden
 * zat namelijk NIET in een apart, geïsoleerd componentje (dat zou stap 1 al tonen) --
 * beide kanten zaten gewoon in het grote "vasteland" (76,1%), alleen met geen enkele
 * korte verbinding ertussen, waardoor Dijkstra een enorme omweg moest nemen.
 *
 * Werkwijze: bouwt een simpel ruimtelijk rooster (cellen van 1500m) over alle
 * knooppunten. Voor elk knooppunt: zoek het dichtstbijzijnde ANDERE knooppunt binnen
 * `radiusM` dat er NIET rechtstreeks mee verbonden is. Als zo'n nabij paar bestaat,
 * check met een gebonden (diepte-gelimiteerde) breedte-eerst-zoekopdracht of ze
 * binnen `maxHops` matched-edge-stappen van elkaar bereikbaar zijn. Zo niet: gemeld
 * als verdachte omweg (ze zitten dus WEL in dezelfde component, dus geen totale
 * blokkade, maar wel geforceerd tot een veel langere route dan de geografische
 * afstand zou doen vermoeden).
 *
 * Bewust een gebonden BFS i.p.v. volledige Dijkstra per paar -- dat zou bij duizenden
 * kandidaatparen te traag worden voor één HTTP-verzoek (60s-limiet).
 */

type NodeRow = { id: string; x: number; y: number; displayNumber: string | null; displayRegio: string | null };

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function GET(req: NextRequest) {
  const debugSecret = process.env.DEBUG_SECRET;
  if (debugSecret) {
    const key = req.nextUrl.searchParams.get("key");
    if (key !== debugSecret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const datasetVersionId = req.nextUrl.searchParams.get("datasetVersionId");
  if (!datasetVersionId) {
    return NextResponse.json({ error: "datasetVersionId is verplicht." }, { status: 400 });
  }
  const radiusM = parseFloat(req.nextUrl.searchParams.get("radiusM") || "1500");
  const maxHops = parseInt(req.nextUrl.searchParams.get("maxHops") || "6", 10);
  const limit = parseInt(req.nextUrl.searchParams.get("limit") || "200", 10);

  try {
    const db = getDb();
    const [logicalNodesSnap, edgesSnap] = await Promise.all([
      db.collection("logicalNodes").where("datasetVersionId", "==", datasetVersionId).get(),
      db.collection("edges").where("datasetVersionId", "==", datasetVersionId).where("matchConfidence", "==", "matched").get(),
    ]);

    const nodes: NodeRow[] = logicalNodesSnap.docs.map((d) => {
      const data = d.data();
      return { id: d.id, x: data.x, y: data.y, displayNumber: data.displayNumber ?? null, displayRegio: data.displayRegio ?? null };
    });
    const idToIndex = new Map<string, number>();
    nodes.forEach((n, i) => idToIndex.set(n.id, i));

    // Adjacency (alleen matched edges, zelfde definitie als de routing-graph/graph-connectivity).
    const adjacency: number[][] = nodes.map(() => []);
    const directNeighborSet: Set<string>[] = nodes.map(() => new Set());
    for (const doc of edgesSnap.docs) {
      const d = doc.data();
      const fromIdx = idToIndex.get(d.fromLogicalNodeId);
      const toIdx = idToIndex.get(d.toLogicalNodeId);
      if (fromIdx === undefined || toIdx === undefined) continue;
      adjacency[fromIdx].push(toIdx);
      adjacency[toIdx].push(fromIdx);
      directNeighborSet[fromIdx].add(d.toLogicalNodeId);
      directNeighborSet[toIdx].add(d.fromLogicalNodeId);
    }

    // Ruimtelijk rooster: cellen van radiusM groot, key = "cx,cy".
    const cellSize = radiusM;
    const grid = new Map<string, number[]>();
    function cellKey(x: number, y: number): string {
      return `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    }
    nodes.forEach((n, i) => {
      const key = cellKey(n.x, n.y);
      const arr = grid.get(key);
      if (arr) arr.push(i);
      else grid.set(key, [i]);
    });

    function nearbyIndices(n: NodeRow): number[] {
      const cx = Math.floor(n.x / cellSize);
      const cy = Math.floor(n.y / cellSize);
      const result: number[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(`${cx + dx},${cy + dy}`);
          if (arr) result.push(...arr);
        }
      }
      return result;
    }

    // Gebonden BFS: is target binnen maxHops stappen bereikbaar vanaf start (matched edges)?
    function reachableWithinHops(startIdx: number, targetIdx: number, maxHops: number): boolean {
      if (startIdx === targetIdx) return true;
      let frontier = [startIdx];
      const visited = new Set<number>([startIdx]);
      for (let hop = 0; hop < maxHops; hop++) {
        const next: number[] = [];
        for (const cur of frontier) {
          for (const nb of adjacency[cur]) {
            if (nb === targetIdx) return true;
            if (!visited.has(nb)) {
              visited.add(nb);
              next.push(nb);
            }
          }
        }
        if (next.length === 0) break;
        frontier = next;
      }
      return false;
    }

    const findings: {
      nodeAId: string;
      nodeADisplayNumber: string | null;
      nodeARegio: string | null;
      nodeBId: string;
      nodeBDisplayNumber: string | null;
      nodeBRegio: string | null;
      straightLineDistanceM: number;
    }[] = [];

    const checkedPairs = new Set<string>();
    let candidatePairsChecked = 0;

    for (let i = 0; i < nodes.length; i++) {
      if (findings.length >= limit) break;
      const n = nodes[i];
      let nearestIdx = -1;
      let nearestDist = Infinity;
      for (const j of nearbyIndices(n)) {
        if (j === i) continue;
        if (directNeighborSet[i].has(nodes[j].id)) continue; // al rechtstreeks verbonden, geen probleem
        const d = distance(n, nodes[j]);
        if (d <= radiusM && d < nearestDist) {
          nearestDist = d;
          nearestIdx = j;
        }
      }
      if (nearestIdx === -1) continue;

      const pairKey = i < nearestIdx ? `${i}_${nearestIdx}` : `${nearestIdx}_${i}`;
      if (checkedPairs.has(pairKey)) continue;
      checkedPairs.add(pairKey);
      candidatePairsChecked++;

      if (!reachableWithinHops(i, nearestIdx, maxHops)) {
        findings.push({
          nodeAId: n.id,
          nodeADisplayNumber: n.displayNumber,
          nodeARegio: n.displayRegio,
          nodeBId: nodes[nearestIdx].id,
          nodeBDisplayNumber: nodes[nearestIdx].displayNumber,
          nodeBRegio: nodes[nearestIdx].displayRegio,
          straightLineDistanceM: Number(nearestDist.toFixed(1)),
        });
      }
    }

    findings.sort((a, b) => a.straightLineDistanceM - b.straightLineDistanceM);

    return NextResponse.json({
      datasetVersionId,
      totalNodes: nodes.length,
      radiusM,
      maxHops,
      candidatePairsChecked,
      findingsCount: findings.length,
      findingsCapped: findings.length >= limit,
      note:
        "Elke vondst hieronder is een nabij-liggend knooppuntpaar (binnen radiusM) dat niet rechtstreeks verbonden is EN niet binnen maxHops matched-edge-stappen bereikbaar bleek -- ze kunnen wel via een veel langere weg elders in de graaf verbonden zijn (anders had graph-connectivity ze al als apart component getoond), maar dat maakt Dijkstra vatbaar voor een grote, onnodige omweg (het Volendam-Hoorn-patroon).",
      findings,
    });
  } catch (err) {
    return NextResponse.json({ error: "Detour-detectie mislukt.", details: err instanceof Error ? err.message : String(err) }, { status: 502 });
  }
}
