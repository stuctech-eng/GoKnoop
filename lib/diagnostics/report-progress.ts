/**
 * Fase M6/M7-diagnose, 10-9-2026. `console.log`-regels bleken NIET
 * betrouwbaar zichtbaar in Vercel's functielogs bij een harde
 * FUNCTION_INVOCATION_TIMEOUT (live bevestigd: geen enkele regel kwam
 * door, ook niet de eerste, ondanks dat die binnen milliseconden na
 * functiestart geplaatst zou moeten zijn) -- vermoedelijk gebufferde
 * stdout die verloren gaat bij een hardhandige afbreking.
 *
 * Dit schrijft in plaats daarvan elk checkpoint DIRECT naar Firestore,
 * BEWUST NIET AFGEWACHT (geen `await` op de aanroeper-kant) -- de
 * schrijfactie loopt op de achtergrond door, onafhankelijk van of de
 * aanroepende functie zelf later wordt afgebroken. Een voltooide
 * Firestore-write overleeft dat; een gebufferde console.log-regel niet.
 *
 * Absichtlich een simpel, vast documentpad (één "laatste run" tracker,
 * geen geschiedenis) -- dit is puur diagnostisch gereedschap, geen
 * permanente productiedata.
 *
 * BEWUST EEN DYNAMISCHE IMPORT (niet statisch bovenaan): `combined-graph.ts`
 * heeft uitgebreide, waardevolle unit-tests (18 stuks) die GEEN echte
 * Firestore-verbinding gebruiken/nodig hebben -- een statische import van
 * `@/lib/firebase-admin` bleek vitest's testcollectie voor dat bestand te
 * breken ("Failed to load url... Does the file exist?", ondanks dat
 * `getDb()` zelf al lui is). Een dynamische import binnen de functie
 * voorkomt dat vitest dit ooit statisch hoeft te resolven voor bestanden
 * die `reportProgress` alleen aanroepen, nooit daadwerkelijk in een
 * teststraat uitvoeren met een falende Firestore-verbinding.
 */
export function reportProgress(runId: string, checkpoint: string, extra?: Record<string, unknown>): void {
  import("@/lib/firebase-admin")
    .then(({ getDb }) => getDb())
    .then((db) =>
      db
        .collection("_diagnostics")
        .doc("progress")
        .collection("runs")
        .doc(runId)
        .collection("checkpoints")
        .doc(String(Date.now()))
        .set({ checkpoint, at: new Date().toISOString(), ...extra })
    )
    .catch(() => {
      // Bewust stil -- dit is best-effort diagnostiek, mag de eigenlijke
      // berekening nooit laten falen of vertragen.
    });
}
