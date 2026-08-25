import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/firebase-admin";

export const maxDuration = 60;

/**
 * Phase 1C, stap 13 — importer, deel 3: composite-node-resolutie.
 *
 * Werkt uitsluitend op sourceNodes (al volledig geïmporteerd) — heeft
 * Routedatabank niet nodig. Implementeert de in Phase 1B/1C empirisch
 * vastgestelde regel (docs/phase1b-design.md sectie 6):
 *
 *   - Ruimtelijke clustering op 50m (natuurlijke knik, threshold sensitivity)
 *   - soort_knooppunt is het primaire semantische signaal:
 *     - samengesteld_only cluster -> merge-kandidaat
 *     - enkelvoudig_only cluster  -> standaard NIET samenvoegen,
 *       BEHALVE als de max. onderlinge afstand < 20m (grensgeval-uitzondering,
 *       empirisch gevonden bij Cluster 1 van de handmatige inspectie)
 *     - mixed cluster              -> exception_review, NIET automatisch
 *       samengevoegd (nog niet bewezen voor alle gevallen)
 *   - Topologische validatie (edge-attachment) gebeurt in een latere,
 *     aparte validatiestap zodra edges volledig geïmporteerd zijn — dit
 *     is de fase waar spatial+semantisch al genoeg is om te clusteren.
 *
 * Grid-index (celgrootte 50m) i.p.v. paarsgewijze O(n²)-vergelijking over
 * 13.152 nodes, om binnen de Vercel-tijdslimiet te blijven.
 *
 * Resumable in de schrijffase: de clustering zelf wordt elke aanroep
 * herberekend (snel dankzij de grid-index), alleen het wegschrijven
 * gebeurt gepagineerd via offset — zelfde patroon als nodes/edges-import.
 */

type SourceNode = {
  id: string;
  sourceObjectId: string;
  knooppuntnr: string;
  regio: string;
  provincie: string;
  soortKnooppunt: string;
  x: number;
  y: number;
};

const CLUSTER_THRESHOLD_M = 50;
const ENKELVOUDIG_EXCEPTION_THRESHOLD_M = 20;
const GRID_CELL_SIZE_M = 50; // gelijk aan clusterdrempel: buren zitten altijd in aangrenzende cellen

class UnionFind {
  parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

function gridKey(x: number, y: number): string {
  return `${Math.floor(x / GRID_CELL_SIZE_M)}_${Math.floor(y / GRID_CELL_SIZE_M)}`;
}

function clusterNodes(nodes: SourceNode[], thresholdM: number): number[][] {
  const grid: Record<string, number[]> = {};
  nodes.forEach((n, i) => {
    const key = gridKey(n.x, n.y);
    (grid[key] ||= []).push(i);
  });

  const uf = new UnionFind(nodes.length);
  const neighborOffsets = [-1, 0, 1];

  nodes.forEach((n, i) => {
    const cellX = Math.floor(n.x / GRID_CELL_SIZE_M);
    const cellY = Math.floor(n.y / GRID_CELL_SIZE_M);
    for (const dx of neighborOffsets) {
      for (const dy of neighborOffsets) {
        const key = `${cellX + dx}_${cellY + dy}`;
        const candidates = grid[key];
        if (!candidates) continue;
        for (const j of candidates) {
          if (j <= i) continue; // elk paar maar één keer
          if (dist(n, nodes[j]) <= thresholdM) {
            uf.union(i, j);
          }
        }
      }
    }
  });

  const groups: Record<number, number[]> = {};
  nodes.forEach((_, i) => {
    const root = uf.find(i);
    (groups[root] ||= []).push(i);
  });
  return Object.values(groups);
}

function isSamengesteld(soort: string): boolean {
  return soort.startsWith("Samengesteld");
}

type LogicalNodeResult = {
  displayNumber: string;
  displayRegio: string;
  x: number;
  y: number;
  clusterMethod: "single" | "spatial_cluster";
  clusterThresholdM: number | null;
  sourceNodeMappings: { sourceNodeId: string; mergeDecision: string }[];
};

function resolveClusters(nodes: SourceNode[]): LogicalNodeResult[] {
  const clusters50 = clusterNodes(nodes, CLUSTER_THRESHOLD_M);
  const results: LogicalNodeResult[] = [];

  for (const cluster of clusters50) {
    if (cluster.length === 1) {
      const n = nodes[cluster[0]];
      results.push({
        displayNumber: n.knooppuntnr,
        displayRegio: n.regio,
        x: n.x,
        y: n.y,
        clusterMethod: "single",
        clusterThresholdM: null,
        sourceNodeMappings: [{ sourceNodeId: n.id, mergeDecision: "protected_single" }],
      });
      continue;
    }

    const points = cluster.map((i) => nodes[i]);
    const allSamengesteld = points.every((p) => isSamengesteld(p.soortKnooppunt));
    const allEnkelvoudig = points.every((p) => !isSamengesteld(p.soortKnooppunt));

    if (allSamengesteld) {
      const centroidX = points.reduce((s, p) => s + p.x, 0) / points.length;
      const centroidY = points.reduce((s, p) => s + p.y, 0) / points.length;
      results.push({
        displayNumber: points[0].knooppuntnr,
        displayRegio: points[0].regio,
        x: centroidX,
        y: centroidY,
        clusterMethod: "spatial_cluster",
        clusterThresholdM: CLUSTER_THRESHOLD_M,
        sourceNodeMappings: points.map((p) => ({ sourceNodeId: p.id, mergeDecision: "merged" })),
      });
    } else if (allEnkelvoudig) {
      // Uitzondering: her-clusteren op 20m binnen deze groep — extreem
      // dichtbij gelegen Enkelvoudig-punten zijn waarschijnlijk toch
      // duplicaten (zie Cluster 1, handmatige inspectie 25-8-2026).
      const subClusters = clusterNodes(points, ENKELVOUDIG_EXCEPTION_THRESHOLD_M);
      for (const sub of subClusters) {
        const subPoints = sub.map((i) => points[i]);
        if (subPoints.length === 1) {
          const n = subPoints[0];
          results.push({
            displayNumber: n.knooppuntnr,
            displayRegio: n.regio,
            x: n.x,
            y: n.y,
            clusterMethod: "single",
            clusterThresholdM: null,
            sourceNodeMappings: [{ sourceNodeId: n.id, mergeDecision: "protected_single" }],
          });
        } else {
          const centroidX = subPoints.reduce((s, p) => s + p.x, 0) / subPoints.length;
          const centroidY = subPoints.reduce((s, p) => s + p.y, 0) / subPoints.length;
          results.push({
            displayNumber: subPoints[0].knooppuntnr,
            displayRegio: subPoints[0].regio,
            x: centroidX,
            y: centroidY,
            clusterMethod: "spatial_cluster",
            clusterThresholdM: ENKELVOUDIG_EXCEPTION_THRESHOLD_M,
            sourceNodeMappings: subPoints.map((p) => ({ sourceNodeId: p.id, mergeDecision: "merged" })),
          });
        }
      }
    } else {
      // Mixed: geen bewezen regel, niet automatisch samenvoegen.
      // Elk punt blijft zijn eigen logical node, gemarkeerd voor review.
      for (const p of points) {
        results.push({
          displayNumber: p.knooppuntnr,
          displayRegio: p.regio,
          x: p.x,
          y: p.y,
          clusterMethod: "single",
          clusterThresholdM: null,
          sourceNodeMappings: [{ sourceNodeId: p.id, mergeDecision: "exception_review" }],
        });
      }
    }
  }

  return results;
}

const FIRESTORE_BATCH_LIMIT = 500;

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
  const writeOffset = parseInt(req.nextUrl.searchParams.get("writeOffset") || "0", 10);
  const writeBatchSize = parseInt(req.nextUrl.searchParams.get("writeBatchSize") || "300", 10);

  try {
    const db = getDb();

    const snapshot = await db
      .collection("sourceNodes")
      .where("datasetVersionId", "==", datasetVersionId)
      .get();

    const nodes: SourceNode[] = snapshot.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        sourceObjectId: d.sourceObjectId,
        knooppuntnr: d.knooppuntnr,
        regio: d.regio,
        provincie: d.provincie,
        soortKnooppunt: d.soortKnooppunt,
        x: d.x,
        y: d.y,
      };
    });

    if (nodes.length === 0) {
      return NextResponse.json({ error: "Geen sourceNodes gevonden voor deze datasetVersionId." }, { status: 404 });
    }

    const logicalNodesToWrite = resolveClusters(nodes);

    const slice = logicalNodesToWrite.slice(writeOffset, writeOffset + writeBatchSize);

    for (let i = 0; i < slice.length; i += FIRESTORE_BATCH_LIMIT) {
      const chunk = slice.slice(i, i + FIRESTORE_BATCH_LIMIT);
      const batch = db.batch();
      for (const ln of chunk) {
        const logicalRef = db.collection("logicalNodes").doc();
        batch.set(logicalRef, {
          datasetVersionId,
          displayNumber: ln.displayNumber,
          displayRegio: ln.displayRegio,
          networkType: "fiets",
          x: ln.x,
          y: ln.y,
          clusterMethod: ln.clusterMethod,
          clusterThresholdM: ln.clusterThresholdM,
          sourceNodeMappings: ln.sourceNodeMappings,
          createdAt: new Date().toISOString(),
        });
        for (const mapping of ln.sourceNodeMappings) {
          const sourceRef = db.collection("sourceNodes").doc(mapping.sourceNodeId);
          batch.update(sourceRef, { logicalNodeId: logicalRef.id });
        }
      }
      await batch.commit();
    }

    const newWriteOffset = writeOffset + slice.length;
    const done = newWriteOffset >= logicalNodesToWrite.length;

    return NextResponse.json({
      datasetVersionId,
      totalSourceNodes: nodes.length,
      totalLogicalNodes: logicalNodesToWrite.length,
      writeOffset,
      written: slice.length,
      newWriteOffset,
      done,
      summary: done
        ? {
            merged: logicalNodesToWrite.filter((l) => l.clusterMethod === "spatial_cluster").length,
            single: logicalNodesToWrite.filter(
              (l) => l.clusterMethod === "single" && l.sourceNodeMappings[0].mergeDecision === "protected_single"
            ).length,
            exceptionReview: logicalNodesToWrite.filter(
              (l) => l.sourceNodeMappings[0].mergeDecision === "exception_review"
            ).length,
          }
        : null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Node-clustering mislukt.", details: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}
