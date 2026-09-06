import { describe, it, expect } from "vitest";
import { encodeRouteShareCode, decodeRouteShareCode, buildShareUrl } from "./route-share-link";
import type { RouteShareCodePayload } from "./route-share-link";

const BASE: RouteShareCodePayload = {
  n: ["n1", "n2", "n3", "n1"],
  e: ["e1", "e2", "e3"],
  d: "v-2026-08-01",
  nm: null,
};

describe("route-share-link", () => {
  it("codeert en decodeert een route zonder verlies (round-trip)", () => {
    const code = encodeRouteShareCode(BASE);
    const decoded = decodeRouteShareCode(code);
    expect(decoded).toEqual(BASE);
  });

  it("bewaart een naam met niet-ASCII-tekens correct (Nederlandse plaatsnamen)", () => {
    const withName: RouteShareCodePayload = { ...BASE, nm: "Rondje Edam – Volendam" };
    const code = encodeRouteShareCode(withName);
    const decoded = decodeRouteShareCode(code);
    expect(decoded?.nm).toBe("Rondje Edam – Volendam");
  });

  it("de code bevat geen tekens die in een URL geëscaped zouden moeten worden (+, /, =)", () => {
    // Genoeg data om vrijwel zeker +//= in gewone base64 te produceren, om de URL-veilige
    // vervanging daadwerkelijk te toetsen, niet toevallig een code zonder die tekens.
    const bigPayload: RouteShareCodePayload = {
      n: Array.from({ length: 30 }, (_, i) => `node-${i}-abcdefgh`),
      e: Array.from({ length: 29 }, (_, i) => `edge-${i}-ijklmnop`),
      d: "v-test",
      nm: "Grote testroute",
    };
    const code = encodeRouteShareCode(bigPayload);
    expect(code).not.toMatch(/[+/=]/);
    expect(decodeRouteShareCode(code)).toEqual(bigPayload);
  });

  it("geeft null terug bij een ongeldige/corrupte code, geen crash", () => {
    expect(decodeRouteShareCode("dit-is-geen-geldige-code!!!")).toBeNull();
    expect(decodeRouteShareCode("")).toBeNull();
  });

  it("geeft null terug als verplichte velden ontbreken in de gedecodeerde data", () => {
    const incomplete = encodeRouteShareCode({ n: ["n1"], e: [], d: "v1", nm: null });
    // Simuleer corruptie: knip de code halverwege af (zoals een berichten-app zou kunnen doen).
    const truncated = incomplete.slice(0, Math.floor(incomplete.length / 2));
    expect(decodeRouteShareCode(truncated)).toBeNull();
  });

  it("bouwt de volledige deelbare URL correct op", () => {
    const url = buildShareUrl(BASE, "https://go-knoop.vercel.app");
    expect(url.startsWith("https://go-knoop.vercel.app/?share=")).toBe(true);
    const code = url.split("?share=")[1];
    expect(decodeRouteShareCode(code)).toEqual(BASE);
  });
});
