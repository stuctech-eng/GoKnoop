"use client";

/**
 * Debug-hub (6-9-2026, op verzoek: "testen moet in de app gebeuren, niet met
 * losse links"). Verzamelt alle bestaande /debug/*-pagina's op één plek,
 * bereikbaar vanuit het Profiel-tabblad. Bouwt geen nieuwe functionaliteit --
 * puur een navigatie-ingang naar wat er al bestaat, plus één gedeeld
 * secret-veld zodat je dat niet op elke sub-pagina opnieuw hoeft in te vullen
 * (zelfde localStorage-sleutel, `goknoop_debug_secret`, als alle sub-pagina's
 * al gebruiken).
 */

import { useEffect, useState } from "react";
import Link from "next/link";

type DebugLink = { href: string; label: string; description: string };
type DebugCategory = { title: string; links: DebugLink[] };

const CATEGORIES: DebugCategory[] = [
  {
    title: "Network Bridge Layer",
    links: [
      { href: "/debug/generate-bridges-runner", label: "Bridge-generator", description: "Draait de volledige generate-bridges-batchreeks automatisch af (prepare → compute-batch → write)." },
      { href: "/debug/bridge-validator", label: "Bridge-validator", description: "ORS-valideert kandidaat-bridges voor de bekende gap-knopen, incl. heen/terug-vergelijking." },
    ],
  },
  {
    title: "Netwerkgat-onderzoek",
    links: [
      { href: "/debug/precompute-clustering-runner", label: "NWB-clustering vooraf berekenen", description: "Structurele fix voor de laatste 10s-bottleneck -- eenmalig draaien na elke migratie." },
      { href: "/debug/migrate-goknoop-batched-runner", label: "GoKnoop → gebatcht formaat migreren", description: "Fixt de 11,2s-trage GoKnoop-basisgraaf-lading." },
      { href: "/debug/instellingen", label: "Debug-instellingen (sleutel invullen)", description: "Vul hier de DEBUG_SECRET in, zonder browserconsole." },
      { href: "/debug/test-to-destination-live", label: "Live test: /api/route/to-destination", description: "Reproduceert de foutmelding uit de app direct, met exacte fout + timing." },
      { href: "/debug/test-nwb-geometry-resolver", label: "Geometrie-resolver debuggen", description: "Probeert drie resourceId-varianten, toont de ruwe PDOK-respons per variant." },
      { href: "/debug/trace-337km-cause", label: "Gerichte trace: 337km-anomalie", description: "Waarom reproduceerde de anomalie niet in productie? Echte productie-connectoren, geen nieuwe generatie." },
      { href: "/debug/production-regression-runner", label: "Fase J: Productieregressies (echte /api/route/combined)", description: "Draait bekende testgevallen tegen het echte, live productie-eindpunt." },
      { href: "/debug/generate-nwb-connectors-runner", label: "NWB-connectoren genereren (productie)", description: "Genereert en slaat gevalideerde connectoren op. Vereist actieve NWB-dataset." },
      { href: "/debug/migrate-nwb-runner", label: "NWB → Productie migreren", description: "Migreert de al-verzamelde onderzoeksdata naar het productieschema. Schrijft naar echte productie-Firestore." },
      { href: "/debug/fase5c-nwb-component-check", label: "Fase 5C: NWB-component-check", description: "Zitten de twee connector-clusters in dezelfde NWB-only-component? Laatste, gerichte test." },
      { href: "/debug/fase5c-vqd-interaction", label: "Fase 5C: GoKnoop\u2194NWB-interactie bij VQd...", description: "Component-analyse, padtrace, connector-cluster-spreidingscheck, vergelijking met normale route." },
      { href: "/debug/fase5c-national-topology", label: "Fase 5C: Landelijke topologie West/Oost", description: "Components, bridges (single points of failure), multi-route-test. Puur GoKnoop-only topologie." },
      { href: "/debug/fase5c-node-diagnosis", label: "Fase 5C: Knoop-diagnose (Volendam-anomalie)", description: "Onderzoekt waarom knoop AG9myG... een 337km-omweg veroorzaakt. Geen F/kosten aangeraakt." },
      { href: "/debug/fase5b-calibration", label: "Fase 5B: Kalibratieronde (24 paren)", description: "Verfijnde F-reeks over 24 echte routeparen -- toetst of de 1,15-1,30-zone stabiel blijft." },
      { href: "/debug/fase5-cost-model-research", label: "Fase 5: Empirisch kostenmodel", description: "Brede F-sweep + connector-kostenvarianten, zoekt omslagpunten leeg, kiest niets vooraf." },
      { href: "/debug/fase4-combined-topology", label: "Fase 4: Gecombineerde-graaf-topologie", description: "GoKnoop + NWB + gevalideerde connectoren samengevoegd, topologie gemeten, geen kostenmodel." },
      { href: "/debug/nwb-visual-sample", label: "Visuele-validatiesteekproef", description: "90 representatieve connector-kandidaten met WGS84-coördinaten en geometrisch voor-oordeel." },
      { href: "/debug/nwb-connector-candidates", label: "Fase 3: Connectorkandidaten", description: "Genereert en beoordeelt GoKnoop<->NWB-connectorkandidaten, met parallel-detectie en confidence-niveaus." },
      { href: "/debug/nwb-collector-runner", label: "NWB-verzamelaar (achtergrond)", description: "Verzamelt systematisch, gegarandeerd-compleet NWB per regio, dan de definitieve analyse." },
      { href: "/debug/nwb-combined-route-test", label: "Beslissende gecombineerde routetest", description: "Verzamelt de corridor, bouwt GoKnoop+NWB samen, test of Dijkstra een realistische route vindt." },
      { href: "/debug/nwb-gap-pinpoint", label: "NWB-breukpunt-test", description: "Vindt het exacte breukpunt in een omweg-route en onderzoekt daar een klein, compleet NWB-gebied." },
      { href: "/debug/nwb-validation-test", label: "NWB ruimtelijke validatietest", description: "Bevat het Nationaal Wegenbestand bruikbare fietsverbindingen die de bekende gaten dichten?" },
      { href: "/debug/wfs-schema", label: "WFS-laagschema bekijken", description: "Checkt of een onbekende laag (bv. fietsnetwerken_nlfietsland) directe knooppunt-verwijzingen heeft." },
      { href: "/debug/wfs-layers", label: "Routedatabank — alle WFS-lagen", description: "Welke lagen biedt de bron in totaal aan, gebruiken we wel de beste?" },
      { href: "/debug/rijrichting-impact", label: "Rijrichting — impactanalyse", description: "8-vragen-analyse: wat verandert er (analytisch, niets gewijzigd) als rijrichting=2 wordt uitgesloten?" },
      { href: "/debug/region-audit", label: "Regio-audit", description: "Match% en edge-verdeling per gebied vergelijken." },
      { href: "/debug/nearest-nodes", label: "Dichtstbijzijnde knopen", description: "Toont knopen rond een punt mét edge-count." },
      { href: "/debug/node-geometry-inspector", label: "Node-geometrie-inspector", description: "Legt brongeometrie naast een knooppunt: tolerantie- of structureel gat?" },
      { href: "/debug/network-gap-scan", label: "Netwerkgat-scan", description: "Vaste testroutes (pontjes, bekende gaten) automatisch afvuren." },
    ],
  },
  {
    title: "Route & graph",
    links: [
      { href: "/debug/loop-diagnose", label: "Loop-route-diagnose", description: "Doorloopt locatie → kandidaten → rondje-generatie, met volledige interne diagnostiek." },
      { href: "/debug/direct-route", label: "Directe route", description: "Route tussen twee specifieke knopen berekenen." },
      { href: "/debug/batch-diagnose", label: "Batch-diagnose", description: "Meerdere routes tegelijk testen." },
      { href: "/debug/component-size", label: "Component-grootte", description: "Hoeveel knopen zijn vanaf hier bereikbaar." },
      { href: "/debug/island-test", label: "Eiland-test", description: "Check op geïsoleerde/onbereikbare knopen." },
      { href: "/debug/location-candidates", label: "Locatie-kandidaten", description: "Kandidaat-knopen bij een adres/coördinaat." },
      { href: "/debug/route-geometry-inspector", label: "Route-geometrie-inspector", description: "Geometrie van een berekende route inspecteren." },
    ],
  },
  {
    title: "Kaart",
    links: [
      { href: "/debug/client-error-log", label: "Kaartfout-log", description: "Live-app-fouten met context (centrum/zoom/stijl) die de app zelf heeft vastgelegd." },
      { href: "/debug/lochem-tile-inspector", label: "Lochem tile-inspector", description: "Inspecteert gerenderde features + A/B-test labels aan/uit op de exacte crash-locatie." },
      { href: "/debug/map", label: "Kaart (basis)", description: "Losse MapLibre-kaart, geen app-logica." },
      { href: "/debug/map-live", label: "Kaart (live positie)", description: "Losse test van live-locatieweergave." },
      { href: "/debug/map-route", label: "Kaart (route)", description: "Losse test van routeweergave op de kaart." },
      { href: "/debug/map-styles", label: "Kaartstijlen", description: "Vergelijkt beschikbare MapLibre-stijlen." },
      { href: "/debug/navigation", label: "Navigatie (los)", description: "Navigatiescherm los van de rest van de app." },
    ],
  },
  {
    title: "Data-patch (voorzichtig!)",
    links: [{ href: "/debug/patch-ferry-edge", label: "Pontje-edge patchen", description: "Voegt handmatig een edge toe -- schrijft naar de live dataset." }],
  },
];

export default function DebugHubPage() {
  const [debugKey, setDebugKey] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem("goknoop_debug_secret") || "";
    setDebugKey(stored);
  }, []);

  function saveKey(value: string) {
    setDebugKey(value);
    window.localStorage.setItem("goknoop_debug_secret", value);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div style={{ padding: "1.25rem 1.25rem 4.5rem", maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
        <Link href="/" style={{ fontSize: 15, color: "#085041", textDecoration: "none" }}>
          ← Terug
        </Link>
      </div>
      <h1 style={{ fontSize: 22, margin: "8px 0 4px" }}>Debug</h1>
      <p style={{ fontSize: 13, opacity: 0.65, marginBottom: 16 }}>
        Alle diagnose- en beheertools op één plek, bereikbaar vanuit Profiel.
      </p>

      <div style={{ marginBottom: 24, padding: 14, background: "#f5f5f0", borderRadius: 10 }}>
        <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>DEBUG_SECRET (eenmalig, geldt voor alle tools hieronder)</label>
        <input
          type="password"
          value={debugKey}
          onChange={(e) => saveKey(e.target.value)}
          placeholder="Vul hier je secret in"
          style={{ width: "100%", padding: 10, fontSize: 14, border: "1px solid #ccc", borderRadius: 8, boxSizing: "border-box" }}
        />
        {saved && <div style={{ fontSize: 12, color: "#085041", marginTop: 4 }}>Opgeslagen ✓</div>}
      </div>

      {CATEGORIES.map((cat) => (
        <div key={cat.title} style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: "#085041" }}>{cat.title}</h2>
          {cat.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                display: "block",
                padding: "12px 14px",
                marginBottom: 8,
                background: "white",
                border: "1px solid #e5e5e0",
                borderRadius: 10,
                textDecoration: "none",
                color: "inherit",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>{link.label}</div>
              <div style={{ fontSize: 12.5, opacity: 0.65 }}>{link.description}</div>
            </Link>
          ))}
        </div>
      ))}
    </div>
  );
}
