import { Big_Shoulders_Display, IBM_Plex_Sans } from "next/font/google";
import "./globals.css";

export const metadata = {
  title: "GoKnoop",
  description: "De simpelste manier om met fietsknooppunten mooie routes te fietsen.",
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
