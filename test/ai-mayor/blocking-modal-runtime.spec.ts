import { createBlockingModalRuntimePort } from "../../src/main/services/ai-mayor/v2/blocking-modal-runtime";
import { MayorUiSettingsStore, resolveUiSettings, uiSettingsFromEnvironment, DEFAULT_MAYOR_UI_SETTINGS } from "../../src/main/services/ai-mayor/ui-settings";

const identity = { kind: "PROGRESSION_MILESTONE", entity: { index: 327, version: 1 }, milestoneIndex: 8, isVictory: false };
const popup = { modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL", modalIdentity: identity, surfaceAvailable: true, detectionSource: "CS2MCP.UI.MilestoneUnlockEventPanel" };
const none = { modalClass: "NO_MODAL", modalIdentity: null, surfaceAvailable: true, detectionSource: "CS2MCP.UI.MilestoneUnlockEventPanel" };

/** A fake game: the popup is up from `raise()` until it is dismissed (by a `cs2_dismiss_blocking_modal` call or by the player). */
function game() {
  const state = { open: false, dismissCalls: 0, reads: 0 };
  const caller = {
    async call(name: string) {
      if (name === "cs2_read_blocking_modal") { state.reads += 1; return state.open ? popup : none; }
      state.dismissCalls += 1;
      state.open = false;
      return { dismissed: true };
    },
  };
  return { state, caller, raise: () => { state.open = true; } };
}

describe("milestone popup: automatic closing is a player's switch, watched in the background", () => {
  test("the switch is read at the moment of each check, so a button can flip it while the Mayor runs", async () => {
    const world = game();
    let auto = true;
    const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: () => auto, sleep: async () => undefined, pollMs: 1, waitForPlayerMs: 0 });
    world.raise();
    expect((await port.check()).allowedToContinue).toBe(true);
    expect(world.state.dismissCalls).toBe(1);
    // Switched off: the next popup is left alone. (A look between the two popups finds none: that is what ends the first one's memory.)
    await port.check();
    world.raise();
    auto = false;
    expect((await port.check()).allowedToContinue).toBe(false);
    expect(world.state.dismissCalls).toBe(1);
    expect(world.state.open).toBe(true);
    // Switched on again: it is cleared.
    auto = true;
    expect((await port.check()).allowedToContinue).toBe(true);
    expect(world.state.dismissCalls).toBe(2);
  });

  test("the watcher clears a popup that appears between simulation windows, within one look, and stays out of it when the switch is off", async () => {
    const world = game();
    let auto = true;
    const abort = new AbortController();
    let looks = 0;
    const port = createBlockingModalRuntimePort(world.caller, {
      autoDismiss: () => auto,
      watchEveryMs: 1,
      sleep: async () => { looks += 1; if (looks === 2) world.raise(); if (looks === 5) auto = false; if (looks === 6) world.raise(); if (looks >= 9) abort.abort(); },
    });
    await port.watch(abort.signal);
    // The popup raised on look 2 was cleared by the watcher; the one raised on look 6 (switch off) was not touched.
    expect(world.state.dismissCalls).toBe(1);
    expect(world.state.open).toBe(true);
  });

  test("a check and the watcher never close the same popup twice: checks are serialized", async () => {
    const world = game();
    const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: () => true, sleep: async () => undefined });
    world.raise();
    const results = await Promise.all([port.check(), port.check(), port.check()]);
    expect(world.state.dismissCalls).toBe(1);
    expect(results.every((result) => result.allowedToContinue)).toBe(true);
  });

  test("the same milestone raised again after the popup was gone (a reloaded save) is a new occurrence, not a refused loop", async () => {
    const world = game();
    const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: () => true, sleep: async () => undefined });
    world.raise();
    expect((await port.check()).allowedToContinue).toBe(true);
    await port.check(); // NO_MODAL: the handled memory is let go
    world.raise();
    expect((await port.check()).allowedToContinue).toBe(true);
    expect(world.state.dismissCalls).toBe(2);
  });

  test("an explicit reset (the world changed) lets a handled popup be handled again", async () => {
    const world = game();
    const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: () => true, sleep: async () => undefined });
    world.raise();
    await port.check();
    world.raise();
    port.reset();
    expect((await port.check()).allowedToContinue).toBe(true);
    expect(world.state.dismissCalls).toBe(2);
  });

  test("by default the background watcher does nothing (the window-start check is what closes a popup)", async () => {
    let calls = 0;
    const port = createBlockingModalRuntimePort({ call: async () => { calls += 1; throw new Error("must not be called"); } }, { autoDismiss: () => true });
    await expect(port.watch(new AbortController().signal)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  test("a failing look never breaks the watcher", async () => {
    const abort = new AbortController();
    let looks = 0;
    const port = createBlockingModalRuntimePort({ call: async () => { throw new Error("bridge down"); } }, {
      autoDismiss: () => true, watchEveryMs: 1, sleep: async () => { looks += 1; if (looks >= 4) abort.abort(); },
    });
    await expect(port.watch(abort.signal)).resolves.toBeUndefined();
  });
});

// The "new signature building unlocked" popup (the one with a building to look at and an OK button).
const signaturePopup = (key = "71:3,72:1", count = 2) => ({ modalClass: "KNOWN_SAFE_DISMISSIBLE_MODAL", modalIdentity: { kind: "SIGNATURE_UNLOCK", key, count, isVictory: false },
  surfaceAvailable: true, detectionSource: "CS2MCP.UI.SignatureUnlockEventPanel.mount" });

/** A fake game showing one popup of any shape until a dismiss call (or the player) removes it; it records what each dismiss call carried. */
function gameShowing(popupNow: () => unknown) {
  const state = { open: false, dismissed: [] as unknown[] };
  const caller = {
    async call(name: string, args?: Record<string, unknown>) {
      if (name === "cs2_read_blocking_modal") return state.open ? popupNow() : none;
      state.dismissed.push(args?.expected);
      state.open = false;
      return { dismissed: true };
    },
  };
  return { state, caller, raise: () => { state.open = true; } };
}

describe("the 'new signature building unlocked' popup", () => {
  const settings = (milestone: boolean, signature: boolean) => {
    const store = new MayorUiSettingsStore({ autoDismissMilestoneModal: milestone, autoDismissSignatureUnlockModal: signature });
    return (observation: { type: string | null }) => observation.type === "SIGNATURE_UNLOCK" ? store.get().autoDismissSignatureUnlockModal : store.get().autoDismissMilestoneModal;
  };

  test("it is closed with exactly the identity the Bridge read, and the run goes on", async () => {
    const world = gameShowing(() => signaturePopup());
    const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: settings(true, true), sleep: async () => undefined });
    world.raise();
    const result = await port.check();
    expect(result.allowedToContinue).toBe(true);
    expect(world.state.dismissed).toEqual([{ kind: "SIGNATURE_UNLOCK", key: "71:3,72:1", count: 2, isVictory: false }]);
  });

  test("its switch is its own: milestone popups can stay the player's while this one is cleared, and the other way round", async () => {
    const onlySignature = gameShowing(() => signaturePopup());
    const a = createBlockingModalRuntimePort(onlySignature.caller, { autoDismiss: settings(false, true), sleep: async () => undefined });
    onlySignature.raise();
    expect((await a.check()).allowedToContinue).toBe(true);
    expect(onlySignature.state.dismissed).toHaveLength(1);

    const milestoneOff = gameShowing(() => popup);
    const b = createBlockingModalRuntimePort(milestoneOff.caller, { autoDismiss: settings(false, true), sleep: async () => undefined, waitForPlayerMs: 0, pollMs: 1 });
    milestoneOff.raise();
    expect((await b.check()).allowedToContinue).toBe(false);
    expect(milestoneOff.state.dismissed).toHaveLength(0);

    const signatureOff = gameShowing(() => signaturePopup());
    const c = createBlockingModalRuntimePort(signatureOff.caller, { autoDismiss: settings(true, false), sleep: async () => undefined, waitForPlayerMs: 0, pollMs: 1 });
    signatureOff.raise();
    expect((await c.check()).allowedToContinue).toBe(false);
    expect(signatureOff.state.dismissed).toHaveLength(0);
  });

  test("a signature popup whose list the Bridge did not name is unknown UI and is never touched", async () => {
    for (const bad of [signaturePopup("", 1), signaturePopup("71:3", 0), { ...signaturePopup(), modalIdentity: { kind: "SIGNATURE_UNLOCK", count: 1 } }]) {
      const world = gameShowing(() => bad);
      const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: () => true, sleep: async () => undefined });
      world.raise();
      const result = await port.check();
      expect(result.allowedToContinue).toBe(false);
      expect(world.state.dismissed).toHaveLength(0);
    }
  });

  test("the background watcher clears it between simulation windows", async () => {
    const world = gameShowing(() => signaturePopup());
    const abort = new AbortController();
    let looks = 0;
    const port = createBlockingModalRuntimePort(world.caller, {
      autoDismiss: settings(false, true), watchEveryMs: 1,
      sleep: async () => { looks += 1; if (looks === 2) world.raise(); if (looks >= 5) abort.abort(); },
    });
    await port.watch(abort.signal);
    expect(world.state.dismissed).toHaveLength(1);
    expect(world.state.open).toBe(false);
  });

  test("the watcher stays out of it when both switches are off", async () => {
    const world = gameShowing(() => signaturePopup());
    const abort = new AbortController();
    let looks = 0;
    const port = createBlockingModalRuntimePort(world.caller, {
      autoDismiss: settings(false, false), watchEveryMs: 1,
      sleep: async () => { looks += 1; if (looks === 1) world.raise(); if (looks >= 4) abort.abort(); },
    });
    await port.watch(abort.signal);
    expect(world.state.dismissed).toHaveLength(0);
    expect(world.state.open).toBe(true);
  });

  test("two unlocked buildings in a row are two occurrences, each cleared in turn", async () => {
    let list = "71:3";
    const world = gameShowing(() => signaturePopup(list, 1));
    const port = createBlockingModalRuntimePort(world.caller, { autoDismiss: () => true, sleep: async () => undefined });
    world.raise();
    expect((await port.check()).allowedToContinue).toBe(true);
    list = "72:1";
    world.raise();
    expect((await port.check()).allowedToContinue).toBe(true);
    expect(world.state.dismissed).toEqual([
      { kind: "SIGNATURE_UNLOCK", key: "71:3", count: 1, isVictory: false },
      { kind: "SIGNATURE_UNLOCK", key: "72:1", count: 1, isVictory: false },
    ]);
  });
});

describe("player UI settings", () => {
  test("each popup kind has its own switch, both on by default", () => {
    expect(DEFAULT_MAYOR_UI_SETTINGS).toEqual({ autoDismissMilestoneModal: true, autoDismissSignatureUnlockModal: true });
    expect(resolveUiSettings({ autoDismissSignatureUnlockModal: false })).toEqual({ autoDismissMilestoneModal: true, autoDismissSignatureUnlockModal: false });
    expect(uiSettingsFromEnvironment({ AI_MAYOR_AUTO_DISMISS_SIGNATURE: "off" })).toEqual({ autoDismissMilestoneModal: true, autoDismissSignatureUnlockModal: false });
    expect(uiSettingsFromEnvironment({ AI_MAYOR_AUTO_DISMISS_MILESTONE: "0", AI_MAYOR_AUTO_DISMISS_SIGNATURE: "1" })).toEqual({ autoDismissMilestoneModal: false, autoDismissSignatureUnlockModal: true });
  });
  test("automatic closing is on by default and only a boolean changes it", () => {
    expect(DEFAULT_MAYOR_UI_SETTINGS.autoDismissMilestoneModal).toBe(true);
    expect(resolveUiSettings({ autoDismissMilestoneModal: false }).autoDismissMilestoneModal).toBe(false);
    expect(resolveUiSettings({ autoDismissMilestoneModal: "no" as never }).autoDismissMilestoneModal).toBe(true);
    expect(resolveUiSettings(null).autoDismissMilestoneModal).toBe(true);
  });
  test("the launch default can be turned off by environment, and the store flips at runtime", () => {
    expect(uiSettingsFromEnvironment({}).autoDismissMilestoneModal).toBe(true);
    expect(uiSettingsFromEnvironment({ AI_MAYOR_AUTO_DISMISS_MILESTONE: "0" }).autoDismissMilestoneModal).toBe(false);
    expect(uiSettingsFromEnvironment({ AI_MAYOR_AUTO_DISMISS_MILESTONE: "off" }).autoDismissMilestoneModal).toBe(false);
    const store = new MayorUiSettingsStore(uiSettingsFromEnvironment({ AI_MAYOR_AUTO_DISMISS_MILESTONE: "false" }));
    expect(store.get().autoDismissMilestoneModal).toBe(false);
    expect(store.set({ autoDismissMilestoneModal: true }).autoDismissMilestoneModal).toBe(true);
    expect(store.set({}).autoDismissMilestoneModal).toBe(true);
  });
});
