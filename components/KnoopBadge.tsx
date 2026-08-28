export function KnoopBadge({
  label,
  size = 56,
  selected = false,
  outline = false,
}: {
  label: string | number;
  size?: number;
  selected?: boolean;
  outline?: boolean;
}) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "var(--radius-badge)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: outline ? "transparent" : "var(--color-knoop-green)",
        border: `3px solid ${selected ? "var(--color-canal-blue)" : "var(--color-knoop-green)"}`,
        color: outline ? "var(--color-knoop-green)" : "var(--color-white)",
        fontFamily: "var(--font-display)",
        fontWeight: 700,
        fontSize: size * 0.36,
        lineHeight: 1,
        flexShrink: 0,
        transition: "border-color 120ms ease",
      }}
    >
      {label}
    </div>
  );
}
