import type { SkillAdapter } from "../adapters/port";
import type { SkillDefinition } from "../definitions/types";
import { parseSkillManifest, type SkillManifest } from "../schemas/manifest";

export interface RegisteredSkill {
  readonly manifest: SkillManifest;
  readonly adapter?: SkillAdapter;
  readonly definition?: SkillDefinition;
}

export class SkillRegistry {
  private readonly entries = new Map<string, RegisteredSkill>();

  register(manifestInput: unknown, adapter?: SkillAdapter, definition?: SkillDefinition): RegisteredSkill {
    const manifest = parseSkillManifest(manifestInput);
    if (this.entries.has(manifest.id)) {
      throw new Error(`Skill is already registered: ${manifest.id}`);
    }
    if (manifest.adapterId !== undefined && adapter?.id !== manifest.adapterId) {
      throw new Error(`Skill adapter mismatch: ${manifest.id}`);
    }
    if (definition !== undefined && definition.manifest.id !== manifest.id) {
      throw new Error(`Skill definition mismatch: ${manifest.id}`);
    }
    const entry = Object.freeze({ manifest, adapter, definition });
    this.entries.set(manifest.id, entry);
    return entry;
  }

  get(id: string): RegisteredSkill | undefined {
    return this.entries.get(id);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  list(): readonly RegisteredSkill[] {
    return [...this.entries.values()];
  }

  clear(): void {
    this.entries.clear();
  }
}
