"use client";

/**
 * Bedieningsscherm voor /api/admin/patch-ferry-edge (sectie 9.63/9.64, 30-8-2026).
 * Eenmalige, gerichte datapatch -- vereist expliciete bevestiging, zelfde discipline als
 * andere ingrijpende acties in de app (bijv. "rit beëindigen").
 */

import { useState } from "react";

export default function PatchFerryEdgePage() {
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function apply() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/patch-ferry-edge", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Onbekende fout.");
        return;
      }
      setResult(data);
    } catch {
      setError("Er ging iets mis.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ padding: 20, fontFamily: "sans-serif" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Pontje-edge patchen</h1>
      <p style={{ fontSize: 14, marginBottom: 16 }}>
        Voegt de ontbrekende verbinding toe tussen knooppunt 61 (Buiksloterweg) en knooppunt 5 (Amsterdam Centraal) --
        vandaag grondig bevestigd als &quot;disconnected&quot; ondanks slechts 1,6 km hemelsbrede afstand.
      </p>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Eenmalige, gerichte actie -- uitsluitend deze twee knooppunten, geen bulkwijziging. Controleert vooraf of de
        edge al bestaat (geen duplicaten bij herhaald indrukken).
      </p>

      {!confirmed ? (
        <button
          onClick={() => setConfirmed(true)}
          style={{ width: "100%", padding: 12, fontSize: 16, background: "#085041", color: "white", border: "none", borderRadius: 8 }}
        >
          Doorgaan
        </button>
      ) : (
        <>
          <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Zeker weten? Dit schrijft direct naar de productiedatabase.</p>
          <button
            onClick={apply}
            disabled={loading}
            style={{ width: "100%", padding: 12, fontSize: 16, background: "#b00020", color: "white", border: "none", borderRadius: 8, marginBottom: 8 }}
          >
            {loading ? "Bezig..." : "Ja, patch toepassen"}
          </button>
          <button
            onClick={() => setConfirmed(false)}
            style={{ width: "100%", padding: 12, fontSize: 16, background: "white", color: "#1A1A1A", border: "1px solid #ccc", borderRadius: 8 }}
          >
            Annuleren
          </button>
        </>
      )}

      {error && <p style={{ color: "red", marginTop: 16 }}>{error}</p>}

      {result && (
        <div style={{ marginTop: 16, padding: 14, border: "1px solid #ccc", borderRadius: 8, fontSize: 14, fontFamily: "monospace" }}>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(result, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
