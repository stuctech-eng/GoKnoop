import { Big_Shoulders_Display, IBM_Plex_Sans } from "next/font/google";
import type { Viewport } from "next";
import "./globals.css";

export const metadata = {
  title: "GoKnoop",
  description: "De simpelste manier om met fietsknooppunten mooie routes te fietsen.",
};

/**
 * Bugfix (30-8-2026, "vastgelopen zoom, kruisje/Stop-knop buiten beeld"): zonder een
 * expliciete viewport-instelling staat Next.js standaard gewoon knijp-zoomen op de HELE
 * pagina toe. Als een gebruiker per ongeluk inzoomt en niet meer terug kan (bevestigd
 * gedrag, iOS Safari), verdwijnen vast-gepositioneerde knoppen (kruisje/Stop/Pauze) buiten
 * het zichtbare scherm -- geen codefout in de app zelf, wel op te lossen door pagina-brede
 * pinch-zoom uit te schakelen. De kaart zelf (MapLibre) heeft haar EIGEN, onafhankelijke
 * zoomknoppen/-gebaren -- die blijven hierdoor gewoon werken, dit raakt alleen de browser-
 * pagina zelf.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

const display = Big_Shoulders_Display({
  subsets: ["latin"],
  weight: ["600", "700", "800"],
  variable: "--font-display",
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
