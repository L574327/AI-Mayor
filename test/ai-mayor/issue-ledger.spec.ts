import { describeStanding, IssueLedger } from "../../src/main/services/ai-mayor/v2/issue-ledger";

const at = (hours: number) => ({ frame: Math.round(hours * (262144 / 24)), cycle: Math.round(hours) });

describe("issue ledger", () => {
  it("starts each icon's clock once, and forgets it when the icon is gone", () => {
    const ledger = new IssueLedger();
    const hearse = { type: "Hearse Notification", x: 100, z: 100, prefab: "CitizenMale" };
    ledger.observe([hearse], at(0));
    ledger.observe([hearse], at(5));
    expect(ledger.stuck(at(5), 6, 30)).toHaveLength(0);
    expect(ledger.stuck(at(7), 6, 30)).toHaveLength(1);
    ledger.observe([], at(8));
    expect(ledger.size).toBe(0);
    ledger.observe([hearse], at(9));
    expect(ledger.stuck(at(10), 6, 30)).toHaveLength(0);
  });

  it("never reports a level-up or a traffic bottleneck as stuck, and orders the oldest first", () => {
    const ledger = new IssueLedger();
    ledger.observe([{ type: "Leveling Building", x: 0, z: 0 }, { type: "No Pedestrian Access", x: 50, z: 50, prefab: "Cemetery02" }], at(0));
    ledger.observe([{ type: "Leveling Building", x: 0, z: 0 }, { type: "No Pedestrian Access", x: 50, z: 50, prefab: "Cemetery02" }, { type: "Hearse Notification", x: 900, z: 900 }], at(3));
    const stuck = ledger.stuck(at(12), 6, 30);
    expect(stuck.map((icon) => icon.type)).toEqual(["No Pedestrian Access", "Hearse Notification"]);
    expect(describeStanding(stuck)).toContain("No Pedestrian Access x1 (oldest at 50,50 on Cemetery02)");
  });
});
