"use client";

import { useState } from "react";

const NWB_WFS_BASE = "https://service.pdok.nl/rws/nwbwegen/wfs/v1_0";
const NWB_TYPE_NAME = "nwbwegen:wegvakken";

// Zelfde 4 bekende, echte segment-ID's als de eerdere test.
const KNOWN_TEST_SEGMENT_IDS = [
  "wegvakken.c77ea6a6-8203-4732-9fb8-c254e331f6ee",
  "wegvakken.ec2ba43c-bfa1-48ac-a2ad-c114c3241099",
];

// Meerdere varianten van de resourceId-parameter proberen -- we weten nog
// niet welk formaat deze dienst verwacht (met/zonder typeName-prefix, met/
// zonder "nwbwegen:"-namespace-prefix op de ID zelf).
function buildVariants(ids: string[]) {
  return [
    { naam: "resourceId, ID zoals opgeslagen (wegvakken.xxx)", resourceId: ids.join(",") },
    { naam: "resourceId, met typeName-prefix (nwbwegen:wegvakken.xxx)", resourceId: ids.map((id) => `${NWB_TYPE_NAME}.${id.split(".")[1]}`).join(",") },
    { naam: "featureID i.p.v. resourceId (oudere WFS-conventie)", paramName: "featureID", resourceId: ids.join(",") },
  ];
}

function CopyAllButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }
  return (
    <button onClick={handleCopy} style={{ width: "100%", padding: 12, fontSize: 15, background: copied ? "#085041" : "#333", color: "white", border: "none", borderRadius: 8, marginBottom: 16 }}>
      {copied ? "Alles gekopieerd ✓" : "Kopieer ALLES (voor Claude)"}
    </button>
  );
}

export default function TestNwbGeometryResolverPage() {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, unknown> | null>(null);

  function getKey() {
    return window.localStorage.getItem("goknoop_debug_secret") || "";
  }

  async function run() {
    setRunning(true);
    setResults(null);
    const key = getKey();

    const variants = buildVariants(KNOWN_TEST_SEGMENT_IDS);
    const allResults: Record<string, unknown> = {};

    for (const variant of variants) {
      const params = new URLSearchParams({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeNames: NWB_TYPE_NAME,
        outputFormat: "application/json",
        srsName: "EPSG:28992",
      });
      params.set(variant.paramName ?? "resourceId", variant.resourceId);
      const url = `${NWB_WFS_BASE}?${params.toString()}`;

      try {
        const proxyParams = new URLSearchParams({ url });
        if (key) proxyParams.set("key", key);
        const res = await fetch(`/api/debug/proxy-fetch?${proxyParams.toString()}`, { cache: "no-store" });
        const json = await res.json();
        allResults[variant.naam] = { aanvraagUrl: url, ...json };
      } catch (err) {
        allResults[variant.naam] = { aanvraagUrl: url, error: err instanceof Error ? err.message : String(err) };
      }
    }

    setResults(allResults);
    setRunning(false);
  }

  const copyText = results ? JSON.stringify(results, null, 2) : "";

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 700, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Geometrie-resolver debuggen</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Probeert drie varianten van de resourceId-parameter, toont de exacte aanvraag-URL en de ruwe PDOK-respons per variant.
      </p>

      <button onClick={run} disabled={running} style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {running ? "Bezig..." : "Test alle varianten"}
      </button>

      {results && (
        <>
          <CopyAllButton text={copyText} />
          <pre style={{ fontSize: 9, background: "#f5f5f0", padding: 8, borderRadius: 6, overflowX: "auto", whiteSpace: "pre-wrap" }}>{copyText}</pre>
        </>
      )}
    </div>
  );
}
