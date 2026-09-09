import { describe, it, expect } from "vitest";
import { findBridges } from "./bridge-finder";

describe("findBridges", () => {
  it("herkent een enkele verbindende edge tussen twee driehoeken als DE bridge", () => {
    // Twee driehoeken (1-2-3 en 4-5-6), verbonden door precies één edge (3-4).
    // Die ene edge moet de enige bridge zijn -- alle driehoek-edges niet,
    // want die zitten in een cykel (verwijderen splitst niets).
    const nodeIds = ["1", "2", "3", "4", "5", "6"];
    const edges = [
      { id: "e12", a: "1", b: "2", distanceM: 10 },
      { id: "e23", a: "2", b: "3", distanceM: 10 },
      { id: "e13", a: "1", b: "3", distanceM: 10 },
      { id: "e34", a: "3", b: "4", distanceM: 100 }, // DE bridge
      { id: "e45", a: "4", b: "5", distanceM: 10 },
      { id: "e56", a: "5", b: "6", distanceM: 10 },
      { id: "e46", a: "4", b: "6", distanceM: 10 },
    ];
    const bridges = findBridges(nodeIds, edges);
    expect(bridges.length).toBe(1);
    expect(bridges[0].edgeId).toBe("e34");
    expect(bridges[0].distanceM).toBe(100);
  });

  it("vindt GEEN bridges in een enkele grote cykel (elke edge heeft een alternatieve route)", () => {
    const nodeIds = ["1", "2", "3", "4", "5"];
    const edges = [
      { id: "e12", a: "1", b: "2", distanceM: 10 },
      { id: "e23", a: "2", b: "3", distanceM: 10 },
      { id: "e34", a: "3", b: "4", distanceM: 10 },
      { id: "e45", a: "4", b: "5", distanceM: 10 },
      { id: "e51", a: "5", b: "1", distanceM: 10 },
    ];
    const bridges = findBridges(nodeIds, edges);
    expect(bridges.length).toBe(0);
  });

  it("herkent ELKE edge in een simpele keten (lijn) als bridge -- er is nergens een alternatief", () => {
    const nodeIds = ["1", "2", "3", "4"];
    const edges = [
      { id: "e12", a: "1", b: "2", distanceM: 10 },
      { id: "e23", a: "2", b: "3", distanceM: 10 },
      { id: "e34", a: "3", b: "4", distanceM: 10 },
    ];
    const bridges = findBridges(nodeIds, edges);
    expect(bridges.length).toBe(3);
  });

  it("werkt correct bij een grotere keten (schaal-controle voor de iteratieve implementatie, geen recursie-overflow)", () => {
    const CHAIN_LENGTH = 5000;
    const nodeIds = Array.from({ length: CHAIN_LENGTH }, (_, i) => String(i));
    const edges = Array.from({ length: CHAIN_LENGTH - 1 }, (_, i) => ({ id: `e${i}`, a: String(i), b: String(i + 1), distanceM: 10 }));
    const bridges = findBridges(nodeIds, edges);
    expect(bridges.length).toBe(CHAIN_LENGTH - 1); // elke edge in een keten is een bridge
  });

  it("herkent twee bridges bij twee losse verbindingen tussen drie clusters (keten van driehoeken)", () => {
    const nodeIds = ["a1", "a2", "a3", "b1", "b2", "b3", "c1", "c2", "c3"];
    const edges = [
      { id: "ta1", a: "a1", b: "a2", distanceM: 1 },
      { id: "ta2", a: "a2", b: "a3", distanceM: 1 },
      { id: "ta3", a: "a3", b: "a1", distanceM: 1 },
      { id: "bridge1", a: "a2", b: "b1", distanceM: 50 },
      { id: "tb1", a: "b1", b: "b2", distanceM: 1 },
      { id: "tb2", a: "b2", b: "b3", distanceM: 1 },
      { id: "tb3", a: "b3", b: "b1", distanceM: 1 },
      { id: "bridge2", a: "b2", b: "c1", distanceM: 60 },
      { id: "tc1", a: "c1", b: "c2", distanceM: 1 },
      { id: "tc2", a: "c2", b: "c3", distanceM: 1 },
      { id: "tc3", a: "c3", b: "c1", distanceM: 1 },
    ];
    const bridges = findBridges(nodeIds, edges);
    const bridgeIds = bridges.map((b) => b.edgeId).sort();
    expect(bridgeIds).toEqual(["bridge1", "bridge2"]);
  });
});
