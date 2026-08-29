import { NavigationClock } from "../clock/navigation-clock";
import { NavigationStateMachine } from "../session/navigation-state-machine";
import { RerouteExecutor, RerouteRequest, RerouteResult } from "./reroute-executor";

/**
 * Koppelt `RerouteExecutor` (stap 8) aan `NavigationStateMachine` (stap 2) --
 * exact het mechaniek dat al in stap 2 gebouwd en getest is
 * (`startReroute()`/`completeReroute()`/`failReroute()`), hier voor het
 * eerst daadwerkelijk aangedreven door een (gesimuleerde) Route Engine-
 * uitkomst in plaats van directe testaanroepen.
 *
 * Vereist dat de state machine al in OFF_ROUTE staat (dezelfde eis als
 * `startReroute()` zelf, stap 2) -- deze functie triggert die transitie
 * niet zelf op basis van een afwijkingsoordeel; dat blijft bij de
 * deviation-detectielaag (stap 6).
 */
export async function performReroute(params: {
  stateMachine: NavigationStateMachine;
  clock: NavigationClock;
  executor: RerouteExecutor;
  request: RerouteRequest;
}): Promise<RerouteResult> {
  const { stateMachine, clock, executor, request } = params;

  stateMachine.startReroute(); // gooit InvalidNavigationTransitionError als de state niet OFF_ROUTE is

  const result = await executor.execute(request);

  if (result.outcome === "success") {
    stateMachine.completeReroute(clock.now());
  } else {
    stateMachine.failReroute();
  }

  return result;
}
