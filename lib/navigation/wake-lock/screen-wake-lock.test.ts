import { describe, it, expect, vi } from "vitest";
import { ScreenWakeLockController } from "./screen-wake-lock";
import type { WakeLockLike, WakeLockSentinelLike, DocumentLike } from "./screen-wake-lock";

class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: (() => void)[] = [];
  addEventListener(_type: "release", listener: () => void): void {
    this.listeners.push(listener);
  }
  async release(): Promise<void> {
    this.released = true;
    this.listeners.forEach((l) => l());
  }
  /** Simuleert dat het SYSTEEM de lock vrijgeeft (niet via onze eigen release()). */
  simulateSystemRelease(): void {
    this.released = true;
    this.listeners.forEach((l) => l());
  }
}

class FakeWakeLock implements WakeLockLike {
  public requestCount = 0;
  public lastSentinel: FakeSentinel | null = null;
  public shouldFail = false;

  async request(_type: "screen"): Promise<WakeLockSentinelLike> {
    this.requestCount += 1;
    if (this.shouldFail) throw new Error("NotAllowedError");
    const sentinel = new FakeSentinel();
    this.lastSentinel = sentinel;
    return sentinel;
  }
}

class FakeDocument implements DocumentLike {
  visibilityState: "visible" | "hidden" = "visible";
  private listeners: (() => void)[] = [];
  addEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners.push(listener);
  }
  removeEventListener(_type: "visibilitychange", listener: () => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  triggerVisibilityChange(state: "visible" | "hidden"): void {
    this.visibilityState = state;
    this.listeners.forEach((l) => l());
  }
}

describe("ScreenWakeLockController — basisgedrag", () => {
  it("request() vraagt de Wake Lock aan en isActive() wordt true", async () => {
    const wakeLock = new FakeWakeLock();
    const doc = new FakeDocument();
    const controller = new ScreenWakeLockController({ wakeLock, document: doc });

    const ok = await controller.request();
    expect(ok).toBe(true);
    expect(controller.isActive()).toBe(true);
    expect(wakeLock.requestCount).toBe(1);
  });

  it("release() geeft de lock vrij en isActive() wordt false", async () => {
    const wakeLock = new FakeWakeLock();
    const doc = new FakeDocument();
    const controller = new ScreenWakeLockController({ wakeLock, document: doc });

    await controller.request();
    await controller.release();
    expect(controller.isActive()).toBe(false);
    expect(wakeLock.lastSentinel?.released).toBe(true);
  });

  it("faalt stil (false) als de Wake Lock API niet beschikbaar is -- geen crash", async () => {
    const controller = new ScreenWakeLockController({ wakeLock: undefined, document: new FakeDocument() });
    const ok = await controller.request();
    expect(ok).toBe(false);
    expect(controller.isActive()).toBe(false);
  });

  it("faalt stil (false) als de aanvraag zelf een fout gooit, en roept onError aan", async () => {
    const wakeLock = new FakeWakeLock();
    wakeLock.shouldFail = true;
    const onError = vi.fn();
    const controller = new ScreenWakeLockController({ wakeLock, document: new FakeDocument(), onError });

    const ok = await controller.request();
    expect(ok).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("release() zonder eerdere request() is een no-op, geen crash", async () => {
    const controller = new ScreenWakeLockController({ wakeLock: new FakeWakeLock(), document: new FakeDocument() });
    await expect(controller.release()).resolves.toBeUndefined();
  });
});

describe("ScreenWakeLockController — visibilitychange her-aanvraag", () => {
  it("vraagt de lock opnieuw aan zodra de pagina weer zichtbaar wordt, als hij nog gewenst was", async () => {
    const wakeLock = new FakeWakeLock();
    const doc = new FakeDocument();
    const controller = new ScreenWakeLockController({ wakeLock, document: doc });

    await controller.request();
    wakeLock.lastSentinel?.simulateSystemRelease(); // systeem geeft 'm vrij (bijv. tab-wissel)
    expect(controller.isActive()).toBe(false);

    doc.triggerVisibilityChange("hidden");
    doc.triggerVisibilityChange("visible");

    // Her-aanvraag is asynchroon (await this.acquire() binnen de handler) -- wacht een tick.
    await new Promise((r) => setTimeout(r, 0));

    expect(wakeLock.requestCount).toBe(2);
    expect(controller.isActive()).toBe(true);
  });

  it("vraagt NIET opnieuw aan als release() bewust is aangeroepen (desired = false)", async () => {
    const wakeLock = new FakeWakeLock();
    const doc = new FakeDocument();
    const controller = new ScreenWakeLockController({ wakeLock, document: doc });

    await controller.request();
    await controller.release(); // bewust vrijgegeven, desired = false

    doc.triggerVisibilityChange("visible");
    await new Promise((r) => setTimeout(r, 0));

    expect(wakeLock.requestCount).toBe(1); // geen tweede aanvraag
    expect(controller.isActive()).toBe(false);
  });

  it("vraagt niet opnieuw aan als de lock nog steeds actief is (geen overbodige dubbele aanvraag)", async () => {
    const wakeLock = new FakeWakeLock();
    const doc = new FakeDocument();
    const controller = new ScreenWakeLockController({ wakeLock, document: doc });

    await controller.request();
    doc.triggerVisibilityChange("visible"); // lock is al actief, geen reden om opnieuw te vragen
    await new Promise((r) => setTimeout(r, 0));

    expect(wakeLock.requestCount).toBe(1);
  });
});

describe("ScreenWakeLockController — destroy()", () => {
  it("verwijdert de visibilitychange-listener, geen her-aanvraag meer daarna", async () => {
    const wakeLock = new FakeWakeLock();
    const doc = new FakeDocument();
    const controller = new ScreenWakeLockController({ wakeLock, document: doc });

    await controller.request();
    wakeLock.lastSentinel?.simulateSystemRelease();
    controller.destroy();

    doc.triggerVisibilityChange("visible");
    await new Promise((r) => setTimeout(r, 0));

    expect(wakeLock.requestCount).toBe(1); // geen her-aanvraag na destroy()
  });
});
