"use client";

import { useState, useEffect } from "react";

export default function DebugInstellingenPage() {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState(false);
  const [currentlyStored, setCurrentlyStored] = useState<string | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem("goknoop_debug_secret");
    setCurrentlyStored(stored);
    if (stored) setValue(stored);
  }, []);

  function save() {
    window.localStorage.setItem("goknoop_debug_secret", value.trim());
    setCurrentlyStored(value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function clear() {
    window.localStorage.removeItem("goknoop_debug_secret");
    setValue("");
    setCurrentlyStored(null);
  }

  return (
    <div style={{ padding: 16, fontFamily: "sans-serif", maxWidth: 500, margin: "0 auto" }}>
      <h1 style={{ fontSize: 20, marginBottom: 8 }}>Debug-instellingen</h1>
      <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 16 }}>
        Vul hier de DEBUG_SECRET in (Vercel → project → Settings → Environment Variables). Wordt opgeslagen in deze browser, gebruikt door alle debug-/admin-pagina's.
      </p>

      <p style={{ fontSize: 12, marginBottom: 8 }}>
        Huidige status: {currentlyStored ? <strong style={{ color: "#085041" }}>ingesteld ({currentlyStored.length} tekens)</strong> : <strong style={{ color: "#c00" }}>niet ingesteld</strong>}
      </p>

      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="DEBUG_SECRET-waarde"
        style={{ width: "100%", padding: 12, fontSize: 15, border: "1px solid #ccc", borderRadius: 8, marginBottom: 12 }}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />

      <button onClick={save} style={{ width: "100%", padding: 12, fontSize: 16, background: saved ? "#085041" : "#333", color: "white", border: "none", borderRadius: 8, marginBottom: 12 }}>
        {saved ? "Opgeslagen ✓" : "Opslaan"}
      </button>

      <button onClick={clear} style={{ width: "100%", padding: 10, fontSize: 14, background: "transparent", color: "#c00", border: "1px solid #c00", borderRadius: 8 }}>
        Wissen
      </button>
    </div>
  );
}
