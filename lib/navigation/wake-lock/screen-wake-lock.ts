/**
 * Screen Wake Lock (ontwerp sectie 16, MVP-beslissing 29-8-2026) --
 * implementatiestap 11B.
 *
 * BELANGRIJKE, EXPLICIETE BEPERKING (niet wegpoetsen): Wake Lock voorkomt
 * dat het scherm automatisch uitgaat. Het is GEEN garantie dat Safari/iOS
 * de pagina niet alsnog opschort (bijv. bij het wisselen van app, of ander
 * systeemgedrag) -- dat bleek bij de echte meting in implementatiestap 11
 * (5,5 minuten volledige stilte in de log toen het scherm uit ging). Deze
 * laag lost dat niet op; hij maakt het scenario "scherm gaat vanzelf uit
 * tijdens navigatie" minder waarschijnlijk, niet onmogelijk.
 *
 * GoKnoop web-MVP vereist dat het scherm tijdens navigatie actief blijft.
 * Wake Lock probeert het scherm actief te houden, maar biedt geen garantie
 * op continue JavaScript/GPS-uitvoering wanneer iOS/Safari de pagina
 * opschort.
 *
 * Lokaal getypeerd (`WakeLockLike` e.a.), niet de globale DOM-typen -- zodat
 * deze klasse injecteerbaar en testbaar is zonder een browseromgeving.
 */

export interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

export interface WakeLockLike {
  request(type: "screen"): Promise<WakeLockSentinelLike>;
}

export interface DocumentLike {
  visibilityState: "visible" | "hidden";
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export type ScreenWakeLockOptions = {
  /** Geïnjecteerd voor tests. Standaard `navigator.wakeLock` in de browser. */
  wakeLock?: WakeLockLike;
  /** Geïnjecteerd voor tests. Standaard het globale `document`. */
  document?: DocumentLike;
  onError?: (err: unknown) => void;
};

export class ScreenWakeLockController {
  private readonly wakeLock: WakeLockLike | null;
  private readonly doc: DocumentLike | null;
  private readonly onError?: (err: unknown) => void;
  private sentinel: WakeLockSentinelLike | null = null;
  /** Of de sessie momenteel Wake Lock WIL hebben -- bepaalt of visibilitychange opnieuw aanvraagt. */
  private desired = false;

  constructor(options: ScreenWakeLockOptions = {}) {
    const globalWakeLock =
      typeof navigator !== "undefined" ? (navigator as unknown as { wakeLock?: WakeLockLike }).wakeLock : undefined;
    this.wakeLock = options.wakeLock ?? globalWakeLock ?? null;

    const globalDocument = typeof document !== "undefined" ? (document as unknown as DocumentLike) : undefined;
    this.doc = options.document ?? globalDocument ?? null;
    this.onError = options.onError;

    this.doc?.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  /**
   * Vraagt de Wake Lock aan. Faalt stil (retourneert `false`) als de API niet
   * beschikbaar is (progressive enhancement -- geen crash op browsers/
   * situaties zonder ondersteuning) of als de aanvraag om andere reden
   * mislukt (bijv. lage batterij op sommige platforms).
   */
  async request(): Promise<boolean> {
    this.desired = true;
    return this.acquire();
  }

  /** Geeft de Wake Lock vrij. Aan te roepen bij PAUSED/ARRIVED/CANCELLED/het verlaten van navigatie. */
  async release(): Promise<void> {
    this.desired = false;
    if (this.sentinel && !this.sentinel.released) {
      await this.sentinel.release();
    }
    this.sentinel = null;
  }

  isActive(): boolean {
    return this.sentinel !== null && !this.sentinel.released;
  }

  /** Ruimt de visibilitychange-listener op. Aanroepen bij het definitief verlaten van de pagina/component. */
  destroy(): void {
    this.doc?.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private async acquire(): Promise<boolean> {
    if (!this.wakeLock) return false;
    try {
      const sentinel = await this.wakeLock.request("screen");
      this.sentinel = sentinel;
      sentinel.addEventListener("release", () => {
        // Door het systeem (of onszelf) vrijgegeven -- niet hier direct opnieuw aanvragen,
        // dat gebeurt uitsluitend via visibilitychange (voorkomt een aanvraag-loop
        // wanneer release() bewust is aangeroepen, want `desired` staat dan al op false).
        this.sentinel = null;
      });
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }

  private handleVisibilityChange = (): void => {
    if (this.desired && this.doc?.visibilityState === "visible" && !this.isActive()) {
      void this.acquire();
    }
  };
}
