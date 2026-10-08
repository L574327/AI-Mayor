import {
  freezeUrbanGrammarPack,
  parseUrbanGrammarPack,
  toUrbanDesignPromptCard,
  URBAN_DESIGN_MAX_PACKS,
  type UrbanDesignPromptCard,
  type UrbanGrammarPack,
} from "./grammar";
import compactUrban from "./grammars/compact-urban.json";
import gardenNeighborhood from "./grammars/garden-neighborhood.json";
import orthogonalGrid from "./grammars/orthogonal-grid.json";
import terrainOrganic from "./grammars/terrain-organic.json";
import waterfrontLinear from "./grammars/waterfront-linear.json";

const bundledPackInputs: readonly unknown[] = [
  orthogonalGrid,
  terrainOrganic,
  waterfrontLinear,
  gardenNeighborhood,
  compactUrban,
];

function loadBundledPacks(): readonly UrbanGrammarPack[] {
  if (bundledPackInputs.length > URBAN_DESIGN_MAX_PACKS) throw new Error("bundled urban grammar pack limit exceeded");
  const packs = bundledPackInputs.map((value) => freezeUrbanGrammarPack(parseUrbanGrammarPack(value)));
  const ids = new Set<string>();
  for (const pack of packs) {
    if (ids.has(pack.id)) throw new Error(`duplicate urban grammar pack: ${pack.id}`);
    ids.add(pack.id);
  }
  return Object.freeze(packs);
}

export const BUNDLED_URBAN_GRAMMAR_PACKS = loadBundledPacks();

const grammarById = new Map(BUNDLED_URBAN_GRAMMAR_PACKS.map((pack) => [pack.id, pack]));

export function getBundledUrbanGrammar(styleId: string): UrbanGrammarPack | undefined {
  return grammarById.get(styleId);
}

export function requireBundledUrbanGrammar(styleId: string): UrbanGrammarPack {
  const pack = getBundledUrbanGrammar(styleId);
  if (!pack) throw new Error(`unknown bundled urban grammar: ${styleId}`);
  return pack;
}

export function getBundledUrbanGrammarPromptCards(): readonly UrbanDesignPromptCard[] {
  return Object.freeze(BUNDLED_URBAN_GRAMMAR_PACKS.map(toUrbanDesignPromptCard));
}
