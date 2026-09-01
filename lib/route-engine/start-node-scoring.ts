import { GraphProvider } from "./types";
import { generateLoopRoutes, LoopGenerationResult, LoopStartCandidate } from "./loop-route-generator";

/**
 * Slimmere startknooppunt-keuze (backlog-item 8C, 29-8-2026) --
 * VERVANGT de simpele "probeer kandidaten op volgorde, stop bij de eerste
 * die iets oplevert"-fallback (`generateLoopRoutesWithFallback`, sectie 6B)
 * door alle kandidaten te evalueren en de BESTE te kiezen, op basis van een
 * combinatie van drie factoren:
 *
 *   - afstand (dichterbij is beter, bij verder gelijke omstandigheden)
 *   - beschikbaarheid (levert de kandidaat überhaupt bruikbare routes op --
 *     harde voorwaarde, geen route = niet bruikbaar, ongeacht de score)
 *   - kwaliteit (hoe dicht ligt de beste gevonden route bij de gevraagde
 *     doelafstand -- hergebruikt `deviationPercent`, al bestaand in
 *     `LoopCandidate`, geen nieuwe berekening)
 *
 * De oude, simpele fallback (`generateLoopRoutesWithFallback`) blijft
 * bestaan en gebruikt -- deze functie is een BEWUSTE, aparte, nieuwe
 * strategie, geen wijziging van de bestaande, al bewezen fallback-logica
 * zelf.
 */

export type StartNodeScoreWeights = {
  /** Straf per meter afstand tot de kandidaat (hogere afstand = slechter). */
  distancePenaltyPerMeter: number;
  /** Beloning per daadwerkelijk gevonden route bij deze kandidaat (meer opties = beter). */
  availabilityBonusPerRoute: number;
  /** Straf per procentpunt afwijking van de doelafstand, van de BESTE route van deze kandidaat. */
  qualityPenaltyPerPercent: number;
};

/**
 * Uitgangspuntgewichten, nog niet definitief (zelfde discipline als sectie
 * 8A) -- gekozen zodat routebeschikbaarheid/-kwaliteit in de praktijk zwaarder
 * wegen dan een paar honderd meter extra aanrijafstand, maar afstand blijft
 * meetellen bij verder vergelijkbare kandidaten.
 */
export const DEFAULT_START_NODE_SCORE_WEIGHTS: StartNodeScoreWeights = {
  distancePenaltyPerMeter: 1,
  availabilityBonusPerRoute: 500,
  qualityPenaltyPerPercent: 20,
};

export type StartNodeCandidateScore = {
  logicalNodeId: string;
  distanceM: number | undefined;
  foundCount: number;
  bestDeviationPercent: number | null; // null als er geen enkele route gevonden is
  score: number; // LAGER is beter (kostenfunctie)
};

export type LoopGenerationWithScoringResult = LoopGenerationResult & {
  selectedStartNodeId: string;
  selectedStartNodeDisplayNumber: string;
  selectedStartNodeDistanceM: number | null;
  /** Positie (1-based) van de gekozen kandidaat in de oorspronkelijke, meegegeven volgorde --
   *  NIET per se 1, want de score kan een verdere kandidaat verkiezen. Gehouden voor
   *  compatibiliteit met de bestaande UI (dezelfde veldnaam als de oude fallback). */
  selectedCandidateRank: number;
  /** Alle geëvalueerde kandidaten, met hun score -- transparantie, net als de oude fallback's `attempts`. */
  candidateScores: StartNodeCandidateScore[];
};

export type LoopGenerationScoringFailure = {
  ok: false;
  reason: "no_usable_candidate";
  message: string;
  candidatesAttempted: number;
  candidateScores: StartNodeCandidateScore[];
};

/**
 * Berekent de score van één kandidaat (lager = beter). Geen enkele route
 * gevonden = `Infinity` (nooit bruikbaar, ongeacht hoe dichtbij).
 */
function scoreCandidate(
  distanceM: number | undefined,
  foundCount: number,
  bestDeviationPercent: number | null,
  weights: StartNodeScoreWeights
): number {
  if (foundCount === 0 || bestDeviationPercent === null) return Infinity;
  const distancePenalty = (distanceM ?? 0) * weights.distancePenaltyPerMeter;
  const availabilityBonus = foundCount * weights.availabilityBonusPerRoute;
  const qualityPenalty = bestDeviationPercent * weights.qualityPenaltyPerPercent;
  return distancePenalty - availabilityBonus + qualityPenalty;
}

export function generateLoopRoutesWithScoring(
  provider: GraphProvider,
  datasetVersionId: string,
  candidates: readonly LoopStartCandidate[],
  targetDistanceM: number,
  options: Parameters<typeof generateLoopRoutes>[4] = {},
  weights: StartNodeScoreWeights = DEFAULT_START_NODE_SCORE_WEIGHTS
): LoopGenerationWithScoringResult | LoopGenerationScoringFailure {
  const candidateScores: StartNodeCandidateScore[] = [];
  const resultsByNodeId = new Map<string, LoopGenerationResult>();

  for (const candidate of candidates) {
    if (!provider.getNode(candidate.logicalNodeId)) {
      candidateScores.push({ logicalNodeId: candidate.logicalNodeId, distanceM: candidate.distanceM, foundCount: 0, bestDeviationPercent: null, score: Infinity });
      continue;
    }

    const result = generateLoopRoutes(provider, datasetVersionId, candidate.logicalNodeId, targetDistanceM, options);
    resultsByNodeId.set(candidate.logicalNodeId, result);

    const bestDeviationPercent = result.loops.length > 0 ? Math.min(...result.loops.map((l) => l.deviationPercent)) : null;
    const score = scoreCandidate(candidate.distanceM, result.foundCount, bestDeviationPercent, weights);
    candidateScores.push({ logicalNodeId: candidate.logicalNodeId, distanceM: candidate.distanceM, foundCount: result.foundCount, bestDeviationPercent, score });
  }

  const usable = candidateScores.filter((c) => c.score !== Infinity);
  if (usable.length === 0) {
    return {
      ok: false,
      reason: "no_usable_candidate",
      message: `Geen van de ${candidates.length} kandidaat-knooppunten leverde een bruikbare route op voor ${targetDistanceM}m.`,
      candidatesAttempted: candidates.length,
      candidateScores,
    };
  }

  const best = usable.reduce((a, b) => (b.score < a.score ? b : a));
  const bestResult = resultsByNodeId.get(best.logicalNodeId)!;
  const selectedCandidateRank = candidates.findIndex((c) => c.logicalNodeId === best.logicalNodeId) + 1;

  return {
    ...bestResult,
    selectedStartNodeId: best.logicalNodeId,
    selectedStartNodeDisplayNumber: provider.getNode(best.logicalNodeId)?.displayNumber ?? best.logicalNodeId,
    selectedStartNodeDistanceM: best.distanceM ?? null,
    selectedCandidateRank,
    candidateScores,
  };
}
