export const metadata = {
  title: "GoKnoop",
  description: "Fietsknooppunten-routeplatform — Phase 1: Data Foundation",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="nl">
      <body>{children}</body>
    </html>
  );
}
