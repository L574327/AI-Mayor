export const AI_MAYOR_PRODUCT_MODE_FLAG = "--ai-mayor-product";
export const AI_MAYOR_PRODUCT_MODE_ENV = "AI_MAYOR_PRODUCT_MODE";
export const AI_MAYOR_OVERLAY_SHORTCUT = "CommandOrControl+Shift+M";

export const AI_MAYOR_OVERLAY_SETTINGS_DEFAULTS = {
  showOnStartup: true,
  alwaysOnTop: true,
  mayorSpeed: "fast" as const,
  commentaryEnabled: true,
} as const;

export interface AiMayorOverlaySettings {
  showOnStartup: boolean;
  alwaysOnTop: boolean;
  mayorSpeed: "normal" | "fast";
  commentaryEnabled: boolean;
}

export const normalizeAiMayorOverlaySettings = (value: Partial<AiMayorOverlaySettings> | undefined): AiMayorOverlaySettings => ({
  showOnStartup: value?.showOnStartup ?? AI_MAYOR_OVERLAY_SETTINGS_DEFAULTS.showOnStartup,
  alwaysOnTop: value?.alwaysOnTop ?? AI_MAYOR_OVERLAY_SETTINGS_DEFAULTS.alwaysOnTop,
  mayorSpeed: value?.mayorSpeed === "normal" ? "normal"
    : value?.mayorSpeed === "fast" ? "fast" : AI_MAYOR_OVERLAY_SETTINGS_DEFAULTS.mayorSpeed,
  commentaryEnabled: value?.commentaryEnabled ?? AI_MAYOR_OVERLAY_SETTINGS_DEFAULTS.commentaryEnabled,
});

export function isAiMayorProductMode(
  argv: readonly string[] = process.argv,
  env: Record<string, string | undefined> = process.env,
) {
  return argv.includes(AI_MAYOR_PRODUCT_MODE_FLAG) || env[AI_MAYOR_PRODUCT_MODE_ENV] === "1";
}

export function hasAiMayorCityObservationTools(toolNames: readonly string[]): boolean {
  return toolNames.includes("cs2_game_state") && toolNames.includes("cs2_mayor_snapshot");
}
