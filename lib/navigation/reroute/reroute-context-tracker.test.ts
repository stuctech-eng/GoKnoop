import { describe, it, expect } from "vitest";
import { RerouteContextTracker } from "./reroute-context-tracker";

describe("RerouteContextTracker", () => {
  it("begint leeg -- geen edges om te vermijden", () => {
    const tracker = new RerouteContextTracker();
    expect(tracker.getTemporaryAvoidEdgeIds(1000, 200)).toEqual([]);
    expect(tracker.getVisitCount()).toBe(0);
  });

  it("registreert opeenvolgende, verschillende edges als aparte bezoeken", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 10);
    tracker.recordPosition("e2", 60);
    tracker.recordPosition("e3", 150);
    expect(tracker.getVisitCount()).toBe(3);
  });

  it("herhaalde registraties op dezelfde edge groeien de geschiedenis niet ongebonden", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 10);
    tracker.recordPosition("e1", 20);
    tracker.recordPosition("e1", 30);
    expect(tracker.getVisitCount()).toBe(1);
  });

  it("geeft alleen edges terug binnen RECENT_ROUTE_MEMORY achter de huidige afstand", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 0); // ver terug
    tracker.recordPosition("e2", 500);
    tracker.recordPosition("e3", 900);

    // Huidige afstand 1000m, geheugen 200m -> cutoff = 800m -> alleen e3 (900) valt binnen bereik.
    expect(tracker.getTemporaryAvoidEdgeIds(1000, 200)).toEqual(["e3"]);
  });

  it("een ruimer geheugen omvat meer recente edges", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 0);
    tracker.recordPosition("e2", 500);
    tracker.recordPosition("e3", 900);

    // cutoff = 1000 - 600 = 400 -> e2 (500) en e3 (900) vallen binnen bereik, e1 (0) niet.
    expect(tracker.getTemporaryAvoidEdgeIds(1000, 600)).toEqual(["e2", "e3"]);
  });

  it("een geheugen van 0 geeft alleen de edge exact op de huidige afstand (geen marge)", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 950);
    tracker.recordPosition("e2", 1000);
    expect(tracker.getTemporaryAvoidEdgeIds(1000, 0)).toEqual(["e2"]);
  });

  it("clear() wist de volledige geschiedenis (ontwerp sectie 10: vervalt bij bevestigd ON_ROUTE)", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 100);
    tracker.recordPosition("e2", 200);
    tracker.clear();
    expect(tracker.getVisitCount()).toBe(0);
    expect(tracker.getTemporaryAvoidEdgeIds(200, 500)).toEqual([]);
  });

  it("na clear() kan de tracker gewoon weer nieuwe bezoeken registreren", () => {
    const tracker = new RerouteContextTracker();
    tracker.recordPosition("e1", 100);
    tracker.clear();
    tracker.recordPosition("e2", 300);
    expect(tracker.getTemporaryAvoidEdgeIds(300, 500)).toEqual(["e2"]);
  });

  it("blokkeert niet blind het hele traject: een edge ver buiten het geheugenvenster wordt uitgesloten, ook bij een lange geschiedenis", () => {
    const tracker = new RerouteContextTracker();
    for (let i = 0; i < 20; i++) {
      tracker.recordPosition(`edge-${i}`, i * 100); // edges op 0,100,...,1900m
    }
    // Huidige afstand 2000m, geheugen 150m -> cutoff 1850m -> alleen edge-19 (1900m) valt binnen bereik.
    expect(tracker.getTemporaryAvoidEdgeIds(2000, 150)).toEqual(["edge-19"]);
  });
});
