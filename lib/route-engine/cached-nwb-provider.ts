import { getDb, getLastDbInitBreakdown } from "@/lib/firebase-admin";
import { FieldPath } from "firebase-admin/firestore";
import { buildValidatedCombinedGraph, type CombinedGraph, type SlimNwbSegment, type ValidatedConnectorInput } from "@/lib/nwb-analysis/combined-graph";
import { reportProgress } from "@/lib/diagnostics/report-progress";
import { BridgeAugmentedGraphProvider, selectTopBridgesPerNode } from "./bridge-augmented-graph-provider";
import type { NetworkBridge } from "./network-bridge-types";
import type { GraphProvider } from "./types";

/**
 * Fase K (performance), 9-9-2026 -- HERZIENE VERSIE.
 *
 * EERSTE POGING (verworpen door productiemeting): cachte alleen de RUWE NWB-
 * segmenten/connectoren. Productiedata toonde dat computeTimeMs (gemeten
 * strikt NA het laden van data, rond het bouwen van de graaf + Dijkstra)
 * nauwelijks veranderde tussen cache hit en miss (~5000-5700ms in beide
 * gevallen) -- het cachen van de ruwe data loste dus niet het echte probleem
 * op. Root cause (herzien): de VOLLEDIGE gecombineerde graaf (NWB-clustering
 * via union-find over ~144k segmenten, GoKnoop-edges toevoegen, connectoren
 * verwerken) werd bij ELKE aanvraag opnieuw gebouwd, ook al waren de ruwe
 * data al in het geheugen.
 *
 * DEZE VERSIE cachet de AL-GEBOUWDE CombinedGraph zelf (adjacency +
 * nodePosition -- de daadwerkelijk dure output), niet de ruwe invoer. Een
 * warme aanvraag hoeft nu alleen nog Dijkstra te draaien, geen enkele
 * hernieuwde clustering.
 *
 * FASE M6/M7 (opslagformaat-fix), 10-9-2026: live productiemeting toonde
 * dat het Firestore-uitlezen van de ~144k LOSSE NWB-segment-documenten zelf
 * al ~29s zou kosten (lineair geëxtrapoleerd uit een 2000-documenten-steek-
 * proef, 401ms) -- ruim boven de 10s-limiet, los van alles daarna
 * (bevestigd: een geïsoleerde test van alleen graafopbouw gaf een harde
 * 504 FUNCTION_INVOCATION_TIMEOUT). NWB-segmenten worden nu in GEBATCHTE
 * documenten gelezen (`nwbSegments/{id}/batches/{n}`, ~500 segmenten per
 * document) i.p.v. één document per segment -- ~288 documenten i.p.v.
 * 144.000, dezelfde totale databytes maar drastisch minder per-document-
 * overhead.
 *
 * NETWORK BRIDGE LAYER-INTEGRATIE, 17-9-2026: `provider` wordt nu, ná het
 * afwachten van `providerReadyPromise`, in een `BridgeAugmentedGraphProvider`
 * gewikkeld met de top-`MAX_ACTIVE_BRIDGES_PER_NODE` (=2, gemeten beslissing,
 * zie bridge-augmented-graph-provider.ts) valid bridges per strong-gap-node,
 * VÓÓRDAT `buildValidatedCombinedGraph()` wordt aangeroepen. Geen wijziging
 * aan `combined-graph.ts`, Dijkstra, NWB-verwerking of connector-generatie --
 * de decorator voegt uitsluitend extra `getEdgesFrom()`-resultaten toe, exact
 * zoals die klasse al vanaf 5-9-2026 voor dit doel gebouwd was maar tot nu
 * nooit werd aangeroepen. Bridges-fetch loopt parallel met de bestaande
 * NWB-fetch hieronder (zelfde parallellisatie-principe als de 12-9-timing-
 * audit al elders in dit bestand toepaste).
 *
 * BEKENDE BEPERKING (bewust niet opgelost in deze stap, met opzet geen nieuwe
 * architectuur erbij): `moduleCache` cachet de gebouwde graaf op
 * `datasetVersionId__nwbDatasetVersionId`, zonder een bridge-versie in de
 * sleutel. Een latere wijziging aan de bridge-selectie (nieuwe generatieronde,
 * andere MAX_ACTIVE_BRIDGES_PER_NODE) wordt dus pas zichtbaar na een cache-
 * miss (nieuwe Vercel-instance/deployment) -- geen risico voor deze eerste
 * activering, wel iets om te weten bij een volgende bridge-generatieronde.
 */

type CachedGraphEntry = {
  graph: CombinedGraph;
  nwbDatasetVersionId: string | null;
  loadedAt: number;
};

const moduleCache = new Map<string, CachedGraphEntry>();

// TOEGEVOEGD 18-9-2026 (root-cause-onderzoek, vervolg): `moduleCache` had tot nu toe
// GEEN vervaltijd en GEEN bridge-versie in de sleutel (bekende beperking, al eerder
// genoemd bij de bridge-integratie zelf). Bij >20 deployments op één dag kunnen oude en
// nieuwe Vercel-instances een tijd naast elkaar draaien; een instance die zijn cache
// bouwde vóór een latere wijziging (bridges, volgorde-fixes) blijft die oude graaf
// anders voor onbepaalde tijd hergebruiken. Resultaat: identieke aanvragen, wisselend
// resultaat, afhankelijk van welke instance toevallig bedient -- precies het patroon dat
// vandaag herhaaldelijk is waargenomen bij overigens identieke Volendam->Hoorn- en
// Amsterdam->Hilversum-aanvragen. Een bescheiden vervaltijd dwingt elke instance af en
// toe een verse graaf te bouwen, zodat een verouderde cache nooit onbeperkt blijft
// hangen. Geen architectuurwijziging -- alleen een grens op iets dat voorheen onbegrensd was.
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minuten -- eerste, voorzichtige waarde, niet eerder gemeten

const CONNECTOR_SEARCH_TOLERANCE_M = 20;

export type CachedCombinedGraphResult = { graph: CombinedGraph; nwbDatasetVersionId: string | null; cacheHit: boolean };

export function clearGraphCache(): number {
  const size = moduleCache.size;
  moduleCache.clear();
  return size;
}

export async function loadCachedCombinedGraph(
  provider: GraphProvider,
  datasetVersionId: string,
  providerReadyPromise?: Promise<void>
): Promise<CachedCombinedGraphResult> {
  reportProgress("latest", "loadCachedCombinedGraph: start");
  const db = getDb();
  reportProgress("latest", "loadCachedCombinedGraph: getDb() klaar", getLastDbInitBreakdown());

  const activeNwbSnap = await db.collection("config").doc("activeNwbDataset").get();
  const nwbDatasetVersionId: string | null = activeNwbSnap.exists ? (activeNwbSnap.data()!.nwbDatasetVersionId as string) : null;
  reportProgress("latest", "loadCachedCombinedGraph: activeNwbDataset gelezen", { nwbDatasetVersionId });

  const cacheKey = `${datasetVersionId}__${nwbDatasetVersionId ?? "none"}`;
  const cached = moduleCache.get(cacheKey);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    reportProgress("latest", "loadCachedCombinedGraph: CACHE HIT, klaar", { cacheAgeMs: Date.now() - cached.loadedAt });
    return { graph: cached.graph, nwbDatasetVersionId: cached.nwbDatasetVersionId, cacheHit: true };
  }
  if (cached) {
    reportProgress("latest", "loadCachedCombinedGraph: CACHE VERLOPEN (TTL), opnieuw opbouwen", { cacheAgeMs: Date.now() - cached.loadedAt });
  }
  reportProgress("latest", "loadCachedCombinedGraph: cache miss, ruwe data laden");

  let nwbSegments: SlimNwbSegment[] = [];
  let validatedConnectors: ValidatedConnectorInput[] = [];
  // TOEGEVOEGD 17-9-2026: bridges-fetch start hier, parallel met de NWB-fetch
  // hieronder -- onafhankelijk van elkaar, zelfde parallellisatie-principe als
  // de rest van deze functie al toepast. Alleen valid bridges; scope="strong"
  // is de enige scope die tot nu toe daadwerkelijk gegenereerd/geschreven is
  // (zie generate-bridges-runner-sessie 17-9-2026) -- "weak" levert dus nu
  // gewoon een lege query op, geen foutafhandeling nodig.
  //
  // HERZIEN, zelfde dag (live bevestigd: 504 FUNCTION_INVOCATION_TIMEOUT bij
  // Volendam->Hoorn via de app, cold start): `.select()` gebruikt om de
  // `geometry`-array (20-40+ punten per bridge, x1941 landelijk) NIET mee te
  // lezen. Dijkstra heeft voor het padzoeken zelf alleen `distanceM` nodig,
  // geen geometrie -- exact hetzelfde topologie-eerst-principe dat vandaag al
  // voor gewone GoKnoop-edges is toegepast (route-builder.ts, M6/M7). Gevolg:
  // bridge-edges hebben nu tijdelijk `geometry: []` (zie toGraphEdge() in
  // bridge-augmented-graph-provider.ts) totdat een latere hydratie-stap
  // (zelfde patroon als fetchGoknoopEdgeGeometry, nog niet gebouwd voor
  // bridges) dat voor de uiteindelijk gekozen route aanvult -- bewust een
  // bekende, nu nog openstaande beperking, geen stille aanname.
  // HERZIEN 18-9-2026 (vervolg op het root-cause-onderzoek): deze query miste
  // dezelfde `.orderBy()` die net wel aan de segmenten/connectoren-fetch is
  // toegevoegd -- inconsistent, en precies bridges zijn van vandaag en raken
  // direct de regio waar de wisselvalligheid optreedt. Bij een gelijkspel in
  // circuityRatio tussen twee bridges vanaf dezelfde node bepaalt de
  // aanvoervolgorde (nu pas gegarandeerd stabiel) welke er als "top-2"
  // wordt geselecteerd in selectTopBridgesPerNode -- als die twee bridges
  // niet even goed verbonden zijn, verklaart dat een andere connectiviteit
  // tussen overigens identieke aanvragen.
  const bridgesPromise = db
    .collection("networkBridges")
    .where("datasetVersionId", "==", datasetVersionId)
    .where("validationStatus", "==", "valid")
    .select("sourceNodeId", "targetNodeId", "distanceM", "circuityRatio")
    .orderBy(FieldPath.documentId())
    .get();

  if (nwbDatasetVersionId) {
    // TOEGEVOEGD 12-9-2026, timing-audit: batches- en connectoren-fetch zijn
    // onderling ONAFHANKELIJK (allebei hebben alleen nwbDatasetVersionId
    // nodig) -- nu parallel i.p.v. na elkaar. Bewezen via /api/admin/timing-
    // breakdown: batches-fetch alleen al 4.240ms, was voorheen sequentieel
    // vóór de connectoren-fetch (334ms) -- nu overlappend.
    //
    // HERZIEN 17-9-2026 (root-cause-onderzoek "Volendam->Hoorn soms wel/niet"):
    // `.get()` zonder `.orderBy()` geeft Firestore GEEN garantie op stabiele
    // documentvolgorde tussen aanroepen. Wiskundig gecontroleerd dat de
    // clustering zelf (union-find) ORDE-ONAFHANKELIJK is voor eenzelfde
    // puntenset -- dat verklaart de wisselvalligheid dus NIET. Wel toegevoegd:
    // (1) expliciete `.orderBy(FieldPath.documentId())` zodat elke aanroep
    // gegarandeerd exact dezelfde documenten in dezelfde volgorde binnenkrijgt
    // -- sluit een hele klasse potentiële Firestore-consistentie-varianten uit;
    // (2) een HARDE controle die LUIDRUCHTIG faalt (i.p.v. stilzwijgend door
    // te bouwen) als het aantal opgehaalde batch-documenten niet overeenkomt
    // met wat eerder in DEZELFDE aanvraag als "compleet" is vastgesteld --
    // voorheen kon een onvolledige fetch nergens gezien worden, nu wel.
    const tFetch = Date.now();
    const connectorsKey = `${nwbDatasetVersionId}_${datasetVersionId}`;
    const [batchesSnap, connectorsSnap] = await Promise.all([
      db.collection("nwbSegments").doc(nwbDatasetVersionId).collection("batches").orderBy(FieldPath.documentId()).get(),
      db.collection("nwbConnectors").doc(connectorsKey).collection("connectors").orderBy(FieldPath.documentId()).get(),
    ]);
    reportProgress("latest", "loadCachedCombinedGraph: batches + connectoren parallel opgehaald (fetch)", {
      aantalBatchDocumenten: batchesSnap.docs.length,
      aantalConnectoren: connectorsSnap.docs.length,
      fetchMs: Date.now() - tFetch,
    });

    const tParse = Date.now();
    for (const doc of batchesSnap.docs) {
      const data = doc.data() as { segments: SlimNwbSegment[] };
      nwbSegments.push(...data.segments);
    }
    validatedConnectors = connectorsSnap.docs.map((d) => d.data() as ValidatedConnectorInput);
    reportProgress("latest", "loadCachedCombinedGraph: segmenten + connectoren uitgepakt (deserialisatie)", {
      aantalSegmenten: nwbSegments.length,
      aantalConnectoren: validatedConnectors.length,
      parseMs: Date.now() - tParse,
    });

    // HARDE CONTROLE, 17-9-2026: eerder bekende, stabiele aantallen (131.882
    // segmenten, 3.171 connectoren) zijn hier bewust als ondergrens vastgelegd.
    // Een duidelijk lagere telling wijst op een onvolledige Firestore-fetch --
    // dat mag nooit stilzwijgend een kapotte/onvolledige graaf opleveren.
    // Bewust EXPLICIET falen (foutmelding met de echte aantallen erin) i.p.v.
    // stilzwijgend doorbouwen -- exact het principe dat de rest van dit project
    // al overal toepast bij fouten zichtbaar maken.
    const MIN_VERWACHTE_SEGMENTEN = 130000;
    const MIN_VERWACHTE_CONNECTOREN = 3000;
    if (nwbSegments.length < MIN_VERWACHTE_SEGMENTEN || validatedConnectors.length < MIN_VERWACHTE_CONNECTOREN) {
      throw new Error(
        `Onvolledige NWB-data opgehaald: ${nwbSegments.length} segmenten (verwacht >=${MIN_VERWACHTE_SEGMENTEN}), ` +
          `${validatedConnectors.length} connectoren (verwacht >=${MIN_VERWACHTE_CONNECTOREN}). ` +
          `Batch-documenten: ${batchesSnap.docs.length}. Dit wijst op een onvolledige Firestore-fetch -- ` +
          `bewust geharde stop i.p.v. stilzwijgend een mogelijk kapotte graaf bouwen.`
      );
    }
  }

  // TOEGEVOEGD 12-9-2026, timing-audit: pas HIER wachten op de GoKnoop-
  // provider -- die liep, indien meegegeven, al vanaf het begin van deze
  // functie PARALLEL aan de NWB-fetch hierboven, i.p.v. er sequentieel vóór.
  // Bewezen via /api/admin/timing-breakdown: GoKnoop-laden kostte 2.451ms,
  // was voorheen volledig vóór de NWB-fetch (4.240ms) -- nu overlappend, tot
  // ~2,4s besparing op het totaal.
  if (providerReadyPromise) {
    await providerReadyPromise;
    reportProgress("latest", "loadCachedCombinedGraph: providerReadyPromise afgewacht (liep parallel)");
  }

  const bridgesSnap = await bridgesPromise;
  // `.select()` projecteert alleen expliciet gevraagde velden -- `id` en `geometry` horen daar
  // NIET bij (zie boven), dus hier expliciet aangevuld: `doc.id` (het Firestore-document-ID is
  // altijd gelijk aan het `id`-veld, per constructie in de write-fase) en `geometry: []`
  // (bewust leeg, zie comment bij bridgesPromise hierboven).
  const validBridges: NetworkBridge[] = bridgesSnap.docs.map((d) => {
    const data = d.data() as Omit<NetworkBridge, "id" | "geometry">;
    return { ...data, id: d.id, geometry: [] };
  });
  const selectedBridges = selectTopBridgesPerNode(validBridges);
  reportProgress("latest", "loadCachedCombinedGraph: bridges opgehaald + geselecteerd (top-N per node)", {
    aantalValidBridges: validBridges.length,
    aantalGeselecteerdeBridges: selectedBridges.length,
  });
  const bridgeAugmentedProvider = new BridgeAugmentedGraphProvider(provider, selectedBridges);

  const graph = await buildValidatedCombinedGraph(bridgeAugmentedProvider, nwbSegments, CONNECTOR_SEARCH_TOLERANCE_M, validatedConnectors, (label, extra) =>
    reportProgress("latest", label, extra)
  );
  reportProgress("latest", "loadCachedCombinedGraph: buildValidatedCombinedGraph teruggekeerd -- volledig klaar");
  moduleCache.set(cacheKey, { graph, nwbDatasetVersionId, loadedAt: Date.now() });

  return { graph, nwbDatasetVersionId, cacheHit: false };
}
