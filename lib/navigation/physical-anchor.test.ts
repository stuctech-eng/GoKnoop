import { describe, it, expect } from "vitest";
import { isPhysicalAnchor, resolvePhysicalStart } from "./physical-anchor";
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

describe("resolvePhysicalStart — cruciale regel: nooit overschrijven na de eerste keer (Fase 4, sectie 9.7/9.12)", () => {
  it("legt het fysieke vertrekpunt vast bij de eerste sample (current === null)", () => {
    const result = resolvePhysicalStart(null, { lat: 52.5, lon: 5.1 });
    expect(result).toEqual({ type: "parking", lat: 52.5, lon: 5.1 });
  });

  it("[verplichte test 6] blijft ONVERANDERD bij een tweede aanroep, ook met een andere positie", () => {
    const first = resolvePhysicalStart(null, { lat: 52.5, lon: 5.1 });
    const second = resolvePhysicalStart(first, { lat: 52.9, lon: 5.9 });
    expect(second).toBe(first);
    expect(second).toEqual({ type: "parking", lat: 52.5, lon: 5.1 });
  });

  it("[verplichte test 4] GPS-ruis beïnvloedt het vastgelegde punt niet, zolang het de EERSTE sample was die telde", () => {
    let physicalStart: ReturnType<typeof resolvePhysicalStart> | null = null;
    const noisySamples = [
      { lat: 52.50001, lon: 5.10002 },
      { lat: 52.49998, lon: 5.09997 },
      { lat: 52.50003, lon: 5.10001 },
    ];
    for (const sample of noisySamples) {
      physicalStart = resolvePhysicalStart(physicalStart, sample);
    }
    expect(physicalStart).toEqual({ type: "parking", lat: 52.50001, lon: 5.10002 });
  });
});
