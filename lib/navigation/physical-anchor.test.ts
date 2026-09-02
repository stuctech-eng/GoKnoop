import { describe, it, expect } from "vitest";
import { isPhysicalAnchor } from "./physical-anchor";
import type { PhysicalAnchor } from "./physical-anchor";

describe("isPhysicalAnchor", () => {
  it("accepteert een geldig PhysicalAnchor-object, met naam", () => {
    const anchor: PhysicalAnchor = { type: "parking", lat: 52.5, lon: 5.1, name: "Parkeerplaats Edam" };
    expect(isPhysicalAnchor(anchor)).toBe(true);
  });

  it("accepteert een geldig PhysicalAnchor-object zonder naam (optioneel veld)", () => {
    const anchor = { type: "parking", lat: 52.5, lon: 5.1 };
    expect(isPhysicalAnchor(anchor)).toBe(true);
  });

  it("wijst null/undefined/primitieven af", () => {
    expect(isPhysicalAnchor(null)).toBe(false);
    expect(isPhysicalAnchor(undefined)).toBe(false);
    expect(isPhysicalAnchor("parking")).toBe(false);
    expect(isPhysicalAnchor(42)).toBe(false);
  });

  it("wijst een verkeerd type af", () => {
    expect(isPhysicalAnchor({ type: "poi", lat: 52.5, lon: 5.1 })).toBe(false);
  });

  it("wijst ontbrekende/foutief-getypeerde lat/lon af", () => {
    expect(isPhysicalAnchor({ type: "parking", lat: "52.5", lon: 5.1 })).toBe(false);
    expect(isPhysicalAnchor({ type: "parking", lon: 5.1 })).toBe(false);
  });

  it("wijst een foutief-getypeerd name-veld af", () => {
    expect(isPhysicalAnchor({ type: "parking", lat: 52.5, lon: 5.1, name: 123 })).toBe(false);
  });
});
