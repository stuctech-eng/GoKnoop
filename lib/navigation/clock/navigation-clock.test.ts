import { describe, it, expect } from "vitest";
import { ManualNavigationClock, SystemNavigationClock } from "./navigation-clock";

describe("ManualNavigationClock", () => {
  it("start op 0 tenzij anders opgegeven", () => {
    expect(new ManualNavigationClock().now()).toBe(0);
    expect(new ManualNavigationClock(500).now()).toBe(500);
  });

  it("advance() verplaatst de klok vooruit", () => {
    const clock = new ManualNavigationClock(0);
    clock.advance(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
  });

  it("advance() met een negatieve waarde gooit een fout (klok mag nooit teruglopen)", () => {
    const clock = new ManualNavigationClock(1000);
    expect(() => clock.advance(-1)).toThrow(/terugspoelen/);
    expect(clock.now()).toBe(1000); // ongewijzigd na de geweigerde poging
  });

  it("set() naar een latere of gelijke tijd is toegestaan", () => {
    const clock = new ManualNavigationClock(1000);
    clock.set(1000); // gelijk, toegestaan
    expect(clock.now()).toBe(1000);
    clock.set(2000);
    expect(clock.now()).toBe(2000);
  });

  it("set() naar een eerdere tijd gooit een fout", () => {
    const clock = new ManualNavigationClock(1000);
    expect(() => clock.set(999)).toThrow(/terugspoelen/);
    expect(clock.now()).toBe(1000);
  });
});

describe("SystemNavigationClock", () => {
  it("levert een niet-negatief, numeriek tijdstip (geen tijdsafhankelijke assertie, alleen een sanity check)", () => {
    const clock = new SystemNavigationClock();
    const t = clock.now();
    expect(typeof t).toBe("number");
    expect(Number.isFinite(t)).toBe(true);
    expect(t).toBeGreaterThanOrEqual(0);
  });

  it("is monotoon niet-dalend over twee aanroepen (basale sanity check, geen echte-tijd-afhankelijke waarde)", () => {
    const clock = new SystemNavigationClock();
    const t1 = clock.now();
    const t2 = clock.now();
    expect(t2).toBeGreaterThanOrEqual(t1);
  });
});
