import type { Point } from "./types";

/**
 * Bepaalt of een gesloten lus linksom (tegen de klok in) of rechtsom (met de
 * klok mee) doorlopen wordt -- gebruikt voor zichtbare terugkoppeling bij de
 * "↻ Andere kant op rijden"-knop (sectie 6J/6K, 29-8-2026): een omgekeerde
 * lus tekent bij een simpele lijnweergave exact dezelfde vorm, dus zonder
 * expliciet label lijkt de knop niets te doen.
 *
 * Pure geometrische berekening (shoelace-formule/signed area), geen aanname
 * -- RD-coördinaten (x=oost, y=noord) hebben dezelfde oriëntatie als de
 * standaard wiskundige x-y-conventie, dus een positieve signed area
 * betekent linksom (tegen de klok in), negatief betekent rechtsom.
 */
export function loopOrientation(geometry: readonly Point[]): "linksom" | "rechtsom" {
  let signedArea = 0;
  for (let i = 0; i < geometry.length - 1; i++) {
    signedArea += geometry[i].x * geometry[i + 1].y - geometry[i + 1].x * geometry[i].y;
  }
  return signedArea > 0 ? "linksom" : "rechtsom";
}
