type Point = { x: number; y: number };

/**
 * Tekent een route als lichte SVG-lijn, direct uit route.geometry.
 * Bewust geen kaart-library (Leaflet/Mapbox) — past bij Master Plan sectie 39:
 * "kaart is ondersteunend, niet de hoofdinterface" en houdt de app licht.
 */
export function RoutePreview({
  geometry,
  height = 160,
  startLabel,
}: {
  geometry: Point[];
  height?: number;
  startLabel?: string;
}) {
  if (geometry.length < 2) {
    return (
      <div
        style={{
          height,
          background: "var(--color-sand)",
          borderRadius: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--color-ink)",
          opacity: 0.5,
          fontSize: 13,
        }}
      >
        Geen voorbeeld beschikbaar
      </div>
    );
  }

  const xs = geometry.map((p) => p.x);
  const ys = geometry.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = 320;
  const padding = 16;

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);

  // Y-as omdraaien: RD New heeft y omhoog, SVG heeft y omlaag.
  const project = (p: Point) => ({
    x: padding + (p.x - minX) * scale,
    y: height - padding - (p.y - minY) * scale,
  });

  const projected = geometry.map(project);
  const pathD = projected.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const start = projected[0];
  const end = projected[projected.length - 1];

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      style={{ display: "block", background: "var(--color-sand)", borderRadius: 12 }}
      role="img"
      aria-label={startLabel ? `Routekaartje vanaf knooppunt ${startLabel}` : "Routekaartje"}
    >
      <path d={pathD} fill="none" stroke="var(--color-canal-blue)" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      {/* Startpunt: gevulde knooppunt-badge */}
      <circle cx={start.x} cy={start.y} r={7} fill="var(--color-knoop-green)" stroke="white" strokeWidth={2} />
      {/* Eindpunt: holle marker (bij een rondje valt dit samen met het startpunt) */}
      <circle cx={end.x} cy={end.y} r={5} fill="var(--color-paper)" stroke="var(--color-knoop-green)" strokeWidth={2.5} />
    </svg>
  );
}
