import { describe, it, expect } from "vitest";
import { ProgressTracker } from "./progress-tracker";

describe("ProgressTracker", () => {
  it("rapporteert de eerste observatie direct, ongeacht de waarde", () => {
    const tracker = new ProgressTracker(5);
    const result = tracker.update(42, 1000);
    expect(result.distanceAlongRouteM).toBe(42);
  });

  it("monotoon stijgende waarden worden altijd direct doorgegeven", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(10, 1000);
    tracker.update(20, 1000);
    const result = tracker.update(35, 1000);
    expect(result.distanceAlongRouteM).toBe(35);
  });

  it("een kleine terugval binnen de tolerantie wordt genegeerd -- gerapporteerde waarde blijft ongewijzigd", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(100, 1000);
    const result = tracker.update(97, 1000); // terugval van 3m, binnen tolerantie van 5m
    expect(result.distanceAlongRouteM).toBe(100); // ongewijzigd, ruis genegeerd
  });

  it("een terugval exact op de tolerantiegrens wordt nog genegeerd (grens is inclusief)", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(100, 1000);
    const result = tracker.update(95, 1000); // terugval van exact 5m
    expect(result.distanceAlongRouteM).toBe(100);
  });

  it("een terugval groter dan de tolerantie wordt geaccepteerd (geen permanente blokkade van correcties)", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(100, 1000);
    const result = tracker.update(80, 1000); // terugval van 20m, ruim boven de tolerantie
    expect(result.distanceAlongRouteM).toBe(80);
  });

  it("na een geaccepteerde grote terugval geldt de nieuwe waarde als nieuwe basis voor verdere ruisfiltering", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(100, 1000);
    tracker.update(80, 1000); // geaccepteerde terugval
    const result = tracker.update(78, 1000); // kleine ruis t.o.v. de NIEUWE basis (80), binnen tolerantie
    expect(result.distanceAlongRouteM).toBe(80); // niet 100 -- de basis is nu 80
  });

  it("meerdere kleine ruis-dips na elkaar leiden niet tot een geleidelijke, ongemerkte teruggang", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(100, 1000);
    tracker.update(97, 1000); // ruis, genegeerd
    tracker.update(96, 1000); // ruis t.o.v. 100, nog steeds binnen tolerantie (4m), genegeerd
    const result = tracker.update(98, 1000);
    expect(result.distanceAlongRouteM).toBe(100); // de basis is nooit verlaagd door de kleine dips
  });

  it("berekent remainingDistanceM en progressRatio consistent met de gerapporteerde afstand", () => {
    const tracker = new ProgressTracker(5);
    const result = tracker.update(250, 1000);
    expect(result.remainingDistanceM).toBe(750);
    expect(result.progressRatio).toBeCloseTo(0.25, 6);
  });

  it("getCurrentDistanceM() is null vóór de eerste update, en reflecteert daarna de laatst gerapporteerde waarde", () => {
    const tracker = new ProgressTracker(5);
    expect(tracker.getCurrentDistanceM()).toBeNull();
    tracker.update(30, 1000);
    expect(tracker.getCurrentDistanceM()).toBe(30);
  });

  it("reset() zet de tracker terug naar de beginstaat (nodig bij een reroute, ontwerp sectie 3)", () => {
    const tracker = new ProgressTracker(5);
    tracker.update(500, 1000);
    tracker.reset();
    expect(tracker.getCurrentDistanceM()).toBeNull();
    const result = tracker.update(0, 400); // nieuwe route, nieuwe totale afstand
    expect(result.distanceAlongRouteM).toBe(0);
    expect(result.remainingDistanceM).toBe(400);
  });

  it("gooit een fout bij een negatieve noiseToleranceM (geen zinvolle configuratie)", () => {
    expect(() => new ProgressTracker(-1)).toThrow();
  });

  it("totalDistanceM van 0 geeft progressRatio 0, geen NaN/crash door deling door nul", () => {
    const tracker = new ProgressTracker(5);
    const result = tracker.update(0, 0);
    expect(result.progressRatio).toBe(0);
    expect(Number.isNaN(result.progressRatio)).toBe(false);
  });
});
