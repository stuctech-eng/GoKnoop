import { GpsSample, GpsSource } from "../types";

/**
 * GpsSource-implementatie voor tests (ontwerp sectie 4/20 -- implementatiestap 1).
 *
 * Emit GEEN samples op basis van echte kloktijd -- dat zou tests traag en
 * niet-deterministisch maken. In plaats daarvan wordt een vooraf
 * samengestelde reeks GpsSample's expliciet, stap voor stap "afgespeeld" via
 * emitNext()/emitAll(), zodat elke testrun exact hetzelfde gedrag oplevert --
 * zelfde discipline als de Dijkstra-fixture-tests in Phase 2: bekende input,
 * met de hand te verifiëren gedrag, geen afhankelijkheid van setTimeout/
 * echte tijd.
 *
 * De `timestamp` van elke sample (device-tijd, ontwerp sectie 13B) blijft
 * leidend voor tijdgebaseerde logica in latere implementatiestappen -- de
 * simulator manipuleert die klok niet, alleen de volgorde van emissie.
 */
export class SimulatedGpsSource implements GpsSource {
  private cursor = 0;
  private lastKnown: GpsSample | null = null;
  private readonly listeners: Set<(sample: GpsSample) => void> = new Set();

  constructor(private readonly track: readonly GpsSample[]) {}

  subscribe(callback: (sample: GpsSample) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getLastKnown(): GpsSample | null {
    return this.lastKnown;
  }

  /** Hoeveel samples nog niet ge-emit zijn. */
  remaining(): number {
    return this.track.length - this.cursor;
  }

  /** Of de track volledig is afgespeeld. */
  isExhausted(): boolean {
    return this.cursor >= this.track.length;
  }

  /**
   * Emit de eerstvolgende sample uit de track naar alle subscribers.
   * Retourneert de sample, of null als de track al volledig is afgespeeld --
   * geen stille no-op, expliciet zichtbaar voor de aanroeper/test.
   */
  emitNext(): GpsSample | null {
    if (this.isExhausted()) return null;
    const sample = this.track[this.cursor];
    this.cursor += 1;
    this.lastKnown = sample;
    for (const listener of this.listeners) listener(sample);
    return sample;
  }

  /** Emit alle resterende samples, in volgorde, synchroon. */
  emitAll(): GpsSample[] {
    const emitted: GpsSample[] = [];
    let next = this.emitNext();
    while (next !== null) {
      emitted.push(next);
      next = this.emitNext();
    }
    return emitted;
  }

  /** Zet de track terug naar het begin. Subscribers blijven geabonneerd. */
  reset(): void {
    this.cursor = 0;
    this.lastKnown = null;
  }
}
