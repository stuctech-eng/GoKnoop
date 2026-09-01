"use client";

/**
 * TabBar — onderste navigatiebalk (GOKNOOP-MASTER.md, app-navigatiestructuur-
 * herontwerp, 29-8-2026). Bewust vastgelegde, eerder uitgestelde beslissing
 * (sectie 5.9) nu bewust teruggedraaid op expliciet verzoek.
 *
 * Vier tabs: Kaart (home, live positie), Zoeken (bestaande plaatsnaam-
 * zoekfunctie), Mijn routes (nog leeg/placeholder, komt in een latere stap),
 * Profiel (placeholder).
 */

export type TabId = "kaart" | "zoeken" | "mijnroutes" | "profiel";

const TABS: { id: TabId; label: string; icon: string }[] = [
  { id: "kaart", label: "Kaart", icon: "🗺️" },
  { id: "zoeken", label: "Zoeken", icon: "🔍" },
  { id: "mijnroutes", label: "Mijn routes", icon: "🚴" },
  { id: "profiel", label: "Profiel", icon: "👤" },
];

export default function TabBar({ active, onChange }: { active: TabId; onChange: (tab: TabId) => void }) {
  return (
    <nav
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        display: "flex",
        background: "white",
        borderTop: "1px solid #e5e5e0",
        paddingBottom: "env(safe-area-inset-bottom)",
        zIndex: 40,
      }}
    >
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            onClick={() => onChange(tab.id)}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 2,
              padding: "8px 0 6px",
              border: "none",
              background: "transparent",
              color: isActive ? "#085041" : "#8A8A85",
            }}
          >
            <span style={{ fontSize: 20 }}>{tab.icon}</span>
            <span style={{ fontSize: 11, fontWeight: isActive ? 700 : 500 }}>{tab.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
