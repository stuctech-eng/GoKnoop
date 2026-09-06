import { describe, it, expect } from "vitest";
import { loopOrientation } from "./loop-orientation";

describe("loopOrientation", () => {
  it("herkent een linksom (tegen de klok in) doorlopen vierkant", () => {
    // (0,0) -> (10,0) -> (10,10) -> (0,10) -> (0,0): oost, dan noord, dan west, dan zuid --
    // op een noordgerichte kaart is dit tegen de klok in (linksom).
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ];
    expect(loopOrientation(square)).toBe("linksom");
  });

  it("herkent een rechtsom (met de klok mee) doorlopen vierkant -- exact het omgekeerde", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 0, y: 0 },
    ];
    const reversed = [...square].reverse();
    expect(loopOrientation(reversed)).toBe("rechtsom");
  });

  it("een omgekeerde lus geeft altijd de tegenovergestelde oriëntatie van het origineel", () => {
    const irregularLoop = [
      { x: 0, y: 0 },
      { x: 5, y: 8 },
      { x: 12, y: 3 },
      { x: 7, y: -4 },
      { x: 0, y: 0 },
    ];
    const original = loopOrientation(irregularLoop);
    const reversed = loopOrientation([...irregularLoop].reverse());
    expect(reversed).not.toBe(original);
  });
});
