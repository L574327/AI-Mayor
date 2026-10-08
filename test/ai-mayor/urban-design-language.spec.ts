import {
  createUrbanDesignRng,
  parseUrbanGrammarPack,
  URBAN_DESIGN_MAX_RNG_CALLS,
  URBAN_DESIGN_OPERATOR_REGISTRY,
} from "../../src/main/services/ai-mayor/urban-design/grammar";
import {
  BUNDLED_URBAN_GRAMMAR_PACKS,
  getBundledUrbanGrammarPromptCards,
  requireBundledUrbanGrammar,
} from "../../src/main/services/ai-mayor/urban-design/loader";

describe("Urban Design Language Phase 1", () => {
  test("loads exactly the five bounded bundled grammar packs", () => {
    expect(BUNDLED_URBAN_GRAMMAR_PACKS.map((pack) => pack.id)).toEqual([
      "orthogonal-grid",
      "terrain-organic",
      "waterfront-linear",
      "garden-neighborhood",
      "compact-urban",
    ]);
    for (const pack of BUNDLED_URBAN_GRAMMAR_PACKS) {
      expect(pack.motifs.length).toBeGreaterThan(0);
      expect(pack.motifs.length).toBeLessThanOrEqual(12);
      expect(Object.keys(pack.parameters).length).toBeLessThanOrEqual(24);
      expect(pack.motifs.flatMap((motif) => motif.operators)).toEqual(
        expect.arrayContaining(pack.motifs.flatMap((motif) => motif.operators)),
      );
      for (const motif of pack.motifs) {
        for (const operator of motif.operators) expect(URBAN_DESIGN_OPERATOR_REGISTRY[operator]).toBeDefined();
      }
    }
  });

  test("projects model-facing prompt cards without parameters or operators", () => {
    const cards = getBundledUrbanGrammarPromptCards();
    expect(cards).toHaveLength(5);
    expect(cards[0]).toEqual(expect.objectContaining({ styleId: "orthogonal-grid", name: "Orthogonal Grid" }));
    expect(cards[0]).not.toHaveProperty("parameters");
    expect(cards[0]).not.toHaveProperty("operators");
    expect(cards.flatMap((card) => card.motifs)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "promenade-spine" })]),
    );
  });

  test("uses deterministic bounded variation", () => {
    const left = createUrbanDesignRng("district-7");
    const right = createUrbanDesignRng("district-7");
    const other = createUrbanDesignRng("district-8");
    const leftValues = [left.next(), left.integer(1, 10), left.range(4, 8), left.pick(["a", "b", "c"])];
    const rightValues = [right.next(), right.integer(1, 10), right.range(4, 8), right.pick(["a", "b", "c"])];
    expect(leftValues).toEqual(rightValues);
    expect(leftValues).not.toEqual([
      other.next(),
      other.integer(1, 10),
      other.range(4, 8),
      other.pick(["a", "b", "c"]),
    ]);
    for (let index = left.calls; index < URBAN_DESIGN_MAX_RNG_CALLS; index += 1) left.next();
    expect(() => left.next()).toThrow("variation budget exceeded");
  });

  test("fails closed for unknown operators and adaptation motifs", () => {
    const base = requireBundledUrbanGrammar("waterfront-linear");
    expect(() =>
      parseUrbanGrammarPack({
        ...base,
        motifs: [{ ...base.motifs[0], operators: ["run-code"] }],
      }),
    ).toThrow();
    expect(() =>
      parseUrbanGrammarPack({
        ...base,
        adaptationRules: [{ ...base.adaptationRules[0], preferMotif: "unknown-motif" }],
      }),
    ).toThrow(/unknown motif/);
  });
});
