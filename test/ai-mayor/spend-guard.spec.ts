import { poorAtTakeover, SpendGuard, spendGuardConfigFrom, spends, SpendGuardRefusal, type Funds } from "../../src/main/services/ai-mayor/v2/spend-guard";

const HOUR = 262_144 / 24;

/** A treasury the test moves by hand: reads return it, a spend takes `price` from it. */
function purse(start: number, over: Partial<Funds> = {}) {
  const state = { money: start, frame: 0 as number | null, monthlyBalance: 400_000 as number | null, monthlyExpenses: 100_000 as number | null, ...over };
  return { state, read: async (): Promise<Funds | null> => ({ ...state }) };
}
const spend = (state: { money: number }, price: number) => async () => { state.money -= price; return "ok"; };

describe("the spending fuse", () => {
  test("only calls that cost money pass through it: previews and dry runs, and reads, do not", () => {
    expect(spends("cs2_purchase_tile", {})).toBe(true);
    expect(spends("cs2_build_road", { previewOnly: true })).toBe(false);
    expect(spends("cs2_replace_road", { preview: true })).toBe(false);
    expect(spends("cs2_list_roads", {})).toBe(false);
  });

  test("a call that would leave the treasury under the floor is refused, whatever it is", async () => {
    const { state, read } = purse(744_000);
    const guard = new SpendGuard(744_000, false, read);
    // 10% of the takeover funds (it was 30% until 2026-10-08: on a new 1,000,000 city that held 330,000 idle).
    expect(guard.floor).toBeCloseTo(74_400);
    // Well above the floor: allowed. Near it (inside the margin): refused.
    await expect(guard.run("cs2_build_road", spend(state, 10_000))).resolves.toBe("ok");
    state.money = 80_000;
    await expect(guard.run("cs2_purchase_tile", spend(state, 100_000))).rejects.toBeInstanceOf(SpendGuardRefusal);
    expect(state.money).toBe(80_000);
    expect(guard.refusals).toBe(1);
  });

  test("one game hour's spending is capped across every category; the next game hour starts clean", async () => {
    const { state, read } = purse(1_000_000);
    const guard = new SpendGuard(1_000_000, false, read);
    expect(guard.hourlyCap).toBeCloseTo(150_000);
    await guard.run("cs2_purchase_tile", spend(state, 90_000));
    await guard.run("cs2_place_building", spend(state, 70_000));
    expect(guard.spentThisHour).toBe(160_000);
    await expect(guard.run("cs2_build_road", spend(state, 1_000))).rejects.toThrow(/SPEND_GUARD_REFUSED.*already spent this game hour/);
    state.frame = HOUR + 1;
    await expect(guard.run("cs2_build_road", spend(state, 1_000))).resolves.toBe("ok");
  });

  test("a save that was poor at takeover is never frozen: there is no cushion to protect", async () => {
    const funds = { money: 40_000, monthlyExpenses: 300_000 };
    expect(poorAtTakeover(funds)).toBe(true);
    expect(poorAtTakeover({ money: -5_000, monthlyExpenses: null })).toBe(true);
    expect(poorAtTakeover({ money: 744_000, monthlyExpenses: 100_000 })).toBe(false);
    const { state, read } = purse(40_000);
    const guard = new SpendGuard(40_000, true, read);
    await expect(guard.run("cs2_purchase_tile", spend(state, 35_000))).resolves.toBe("ok");
    await expect(guard.run("cs2_build_road", spend(state, 4_000))).resolves.toBe("ok");
    expect(guard.refusals).toBe(0);
    expect(guard.standDowns).toBe(2);
  });

  test("a healthy city under its floor that is losing money every month may act; one that is earning waits for its income", async () => {
    const bleeding = purse(50_000, { monthlyBalance: -50_000 });
    const guardA = new SpendGuard(744_000, false, bleeding.read);
    await expect(guardA.run("cs2_place_building", spend(bleeding.state, 20_000))).resolves.toBe("ok");
    const earning = purse(50_000, { monthlyBalance: 200_000 });
    const guardB = new SpendGuard(744_000, false, earning.read);
    await expect(guardB.run("cs2_place_building", spend(earning.state, 20_000))).rejects.toBeInstanceOf(SpendGuardRefusal);
  });

  test("the player can turn it off or retune it; a value out of range is ignored", async () => {
    expect(spendGuardConfigFrom({ mode: "OFF" }).mode).toBe("OFF");
    expect(spendGuardConfigFrom({ floorFraction: 0.5, hourlyFraction: 7 })).toMatchObject({ mode: "ADAPTIVE", floorFraction: 0.5, hourlyFraction: 0.15 });
    expect(spendGuardConfigFrom(null, { AI_MAYOR_SPEND_FLOOR_FRACTION: "0.2" }).floorFraction).toBe(0.2);
    const { state, read } = purse(200_000);
    const off = new SpendGuard(744_000, false, read, spendGuardConfigFrom({ mode: "OFF" }));
    await expect(off.run("cs2_purchase_tile", spend(state, 150_000))).resolves.toBe("ok");
  });

  test("a fuse that cannot read the treasury refuses rather than guess, unless it stands down anyway", async () => {
    const blind = async () => null;
    await expect(new SpendGuard(744_000, false, blind).run("cs2_build_road", async () => "ok")).rejects.toThrow(/could not be read/);
    await expect(new SpendGuard(40_000, true, blind).run("cs2_build_road", async () => "ok")).resolves.toBe("ok");
  });
});
