import {
  AI_MAYOR_OVERLAY_SHORTCUT,
  AI_MAYOR_PRODUCT_MODE_ENV,
  AI_MAYOR_PRODUCT_MODE_FLAG,
  hasAiMayorCityObservationTools,
  isAiMayorProductMode,
  normalizeAiMayorOverlaySettings,
} from "../../src/main/services/ai-mayor-product-mode";

describe("AI Mayor Product Mode", () => {
  it("supports the explicit CLI flag and environment switch", () => {
    expect(isAiMayorProductMode(["electron", AI_MAYOR_PRODUCT_MODE_FLAG], {})).toBe(true);
    expect(isAiMayorProductMode(["electron"], { [AI_MAYOR_PRODUCT_MODE_ENV]: "1" })).toBe(true);
    expect(isAiMayorProductMode(["electron"], { [AI_MAYOR_PRODUCT_MODE_ENV]: "0" })).toBe(false);
  });

  it("waits for both authoritative city observation tools before production startup", () => {
    expect(hasAiMayorCityObservationTools(["cs2_game_state"])).toBe(false);
    expect(hasAiMayorCityObservationTools(["cs2_mayor_snapshot"])).toBe(false);
    expect(hasAiMayorCityObservationTools(["cs2_game_state", "cs2_mayor_snapshot"])).toBe(true);
  });

  it("keeps the overlay shortcut in one configuration value", () => {
    expect(AI_MAYOR_OVERLAY_SHORTCUT).toBe("CommandOrControl+Shift+M");
  });

  it("defaults to fast autonomous construction with local commentary enabled", () => {
    expect(normalizeAiMayorOverlaySettings(undefined)).toEqual({
      showOnStartup: true,
      alwaysOnTop: true,
      mayorSpeed: "fast",
      commentaryEnabled: true,
    });
    expect(normalizeAiMayorOverlaySettings({ mayorSpeed: "fast" })).toEqual({
      showOnStartup: true,
      alwaysOnTop: true,
      mayorSpeed: "fast",
      commentaryEnabled: true,
    });
    expect(normalizeAiMayorOverlaySettings({ mayorSpeed: "normal" }).mayorSpeed).toBe("normal");
    expect(normalizeAiMayorOverlaySettings({ mayorSpeed: "unsafe" as never }).mayorSpeed).toBe("fast");
    expect(normalizeAiMayorOverlaySettings({ commentaryEnabled: false }).commentaryEnabled).toBe(false);
  });
});
