import { describe, it, expect, vi } from "vitest";
import { SimulatedGpsSource } from "./simulated-gps-source";
import type { GpsSample } from "../types";

function sample(overrides: Partial<GpsSample> = {}): GpsSample {
  return {
    lat: 52.0,
    lon: 5.0,
    accuracyM: 5,
    headingDeg: null,
    speedMps: null,
    timestamp: 1000,
    ...overrides,
  };
}

describe("SimulatedGpsSource", () => {
  it("start leeg: getLastKnown is null, isExhausted is true bij een lege track", () => {
    const source = new SimulatedGpsSource([]);
    expect(source.getLastKnown()).toBeNull();
    expect(source.isExhausted()).toBe(true);
    expect(source.remaining()).toBe(0);
  });

  it("emitNext geeft samples in volgorde en retourneert null zodra de track leeg is", () => {
    const track = [sample({ timestamp: 1 }), sample({ timestamp: 2 }), sample({ timestamp: 3 })];
    const source = new SimulatedGpsSource(track);

    expect(source.emitNext()?.timestamp).toBe(1);
    expect(source.emitNext()?.timestamp).toBe(2);
    expect(source.emitNext()?.timestamp).toBe(3);
    expect(source.emitNext()).toBeNull(); // expliciet null, geen stille no-op
    expect(source.isExhausted()).toBe(true);
  });

  it("getLastKnown reflecteert altijd de laatst ge-emitte sample", () => {
    const track = [sample({ timestamp: 1 }), sample({ timestamp: 2 })];
    const source = new SimulatedGpsSource(track);

    expect(source.getLastKnown()).toBeNull();
    source.emitNext();
    expect(source.getLastKnown()?.timestamp).toBe(1);
    source.emitNext();
    expect(source.getLastKnown()?.timestamp).toBe(2);
  });

  it("remaining() telt correct af naarmate er ge-emit wordt", () => {
    const track = [sample(), sample(), sample()];
    const source = new SimulatedGpsSource(track);
    expect(source.remaining()).toBe(3);
    source.emitNext();
    expect(source.remaining()).toBe(2);
    source.emitAll();
    expect(source.remaining()).toBe(0);
  });

  it("emitAll emit de volledige resterende track in volgorde en retourneert die als array", () => {
    const track = [sample({ timestamp: 1 }), sample({ timestamp: 2 }), sample({ timestamp: 3 })];
    const source = new SimulatedGpsSource(track);

    const emitted = source.emitAll();
    expect(emitted.map((s) => s.timestamp)).toEqual([1, 2, 3]);
    expect(source.isExhausted()).toBe(true);
  });

  it("subscribers ontvangen elke ge-emitte sample, in dezelfde volgorde", () => {
    const track = [sample({ timestamp: 1 }), sample({ timestamp: 2 })];
    const source = new SimulatedGpsSource(track);
    const received: number[] = [];

    source.subscribe((s) => received.push(s.timestamp));
    source.emitAll();

    expect(received).toEqual([1, 2]);
  });

  it("meerdere subscribers ontvangen allemaal dezelfde sample", () => {
    const source = new SimulatedGpsSource([sample({ timestamp: 42 })]);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    source.subscribe(cb1);
    source.subscribe(cb2);

    source.emitNext();

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb1.mock.calls[0][0].timestamp).toBe(42);
  });

  it("unsubscribe (de teruggegeven functie) stopt verdere emissies naar die listener", () => {
    const track = [sample({ timestamp: 1 }), sample({ timestamp: 2 })];
    const source = new SimulatedGpsSource(track);
    const cb = vi.fn();

    const unsubscribe = source.subscribe(cb);
    source.emitNext();
    unsubscribe();
    source.emitNext();

    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("reset() zet de cursor en getLastKnown terug, maar behoudt subscribers", () => {
    const track = [sample({ timestamp: 1 }), sample({ timestamp: 2 })];
    const source = new SimulatedGpsSource(track);
    const cb = vi.fn();
    source.subscribe(cb);

    source.emitAll();
    expect(source.isExhausted()).toBe(true);

    source.reset();
    expect(source.isExhausted()).toBe(false);
    expect(source.getLastKnown()).toBeNull();
    expect(source.remaining()).toBe(2);

    source.emitNext();
    expect(cb).toHaveBeenCalledTimes(3); // 2 vóór reset + 1 erna, subscriber bleef geabonneerd
  });

  it("manipuleert de timestamp van samples niet -- device-tijd blijft leidend (ontwerp sectie 13B)", () => {
    const track = [sample({ timestamp: 123456789 })];
    const source = new SimulatedGpsSource(track);
    const emitted = source.emitNext();
    expect(emitted?.timestamp).toBe(123456789);
  });
});
