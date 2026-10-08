/**
 * Player-facing switches that are about the game's own UI, not about how the city is built.
 *
 * Kept apart from `MayorGrowthSettings` (pace and target population) on purpose: these are preferences the player will flip from a button
 * while the Mayor is running, so every reader asks the store at the moment it acts and nothing caches the answer.
 *
 * `autoDismissMilestoneModal` — the ordinary "milestone reached" popup pauses the game and covers the screen. By default the Mayor clears it
 * (exactly the one expected, non-victory identity, read first and verified gone after). A player who wants to read it, keep the moment, or
 * click it away themselves turns this off: the Mayor then leaves the popup alone and waits for the player to close it. It is a switch, not a
 * constant — the earlier hand-off (2026-10-03) recorded "make it switchable, do not hard-code it", and this is that.
 */
export interface MayorUiSettings {
  autoDismissMilestoneModal: boolean;
  /**
   * The "new signature building unlocked" popup (a building to look at and an OK button, no decision in it). Its own switch, because a
   * player may want to keep reading these while still letting the Mayor clear milestone popups, or the other way round.
   */
  autoDismissSignatureUnlockModal: boolean;
}

export const DEFAULT_MAYOR_UI_SETTINGS: MayorUiSettings = { autoDismissMilestoneModal: true, autoDismissSignatureUnlockModal: true };

/** Fill in a partial settings object; anything that is not a boolean falls back to `base`. */
export function resolveUiSettings(input?: Partial<MayorUiSettings> | null, base: MayorUiSettings = DEFAULT_MAYOR_UI_SETTINGS): MayorUiSettings {
  return {
    autoDismissMilestoneModal: typeof input?.autoDismissMilestoneModal === "boolean" ? input.autoDismissMilestoneModal : base.autoDismissMilestoneModal,
    autoDismissSignatureUnlockModal: typeof input?.autoDismissSignatureUnlockModal === "boolean" ? input.autoDismissSignatureUnlockModal : base.autoDismissSignatureUnlockModal,
  };
}

const flag = (raw: string | undefined): boolean | null => {
  const value = raw?.trim().toLowerCase();
  if (value === "0" || value === "false" || value === "off") return false;
  if (value === "1" || value === "true" || value === "on") return true;
  return null;
};

/**
 * The starting values: the product defaults, unless `AI_MAYOR_AUTO_DISMISS_MILESTONE` / `AI_MAYOR_AUTO_DISMISS_SIGNATURE` is `0`, `false` or
 * `off` (launch-time defaults only; the running Mayor reads the store).
 */
export function uiSettingsFromEnvironment(env: Record<string, string | undefined> = process.env): MayorUiSettings {
  const milestone = flag(env.AI_MAYOR_AUTO_DISMISS_MILESTONE);
  const signature = flag(env.AI_MAYOR_AUTO_DISMISS_SIGNATURE);
  return resolveUiSettings({ ...(milestone !== null ? { autoDismissMilestoneModal: milestone } : {}), ...(signature !== null ? { autoDismissSignatureUnlockModal: signature } : {}) });
}

export class MayorUiSettingsStore {
  #settings: MayorUiSettings;
  constructor(initial: MayorUiSettings = { ...DEFAULT_MAYOR_UI_SETTINGS }) { this.#settings = resolveUiSettings(initial); }
  get(): MayorUiSettings { return { ...this.#settings }; }
  set(patch: Partial<MayorUiSettings>): MayorUiSettings {
    this.#settings = resolveUiSettings(patch, this.#settings);
    return this.get();
  }
}

/** The one store the running Mayor reads. A UI handler flips a switch with `mayorUiSettings.set({ ... })` (or `MayorRuntime.setUiSettings`). */
export const mayorUiSettings = new MayorUiSettingsStore(uiSettingsFromEnvironment());
