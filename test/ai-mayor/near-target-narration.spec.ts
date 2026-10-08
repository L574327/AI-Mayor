import { narrateNote } from "../../src/main/services/ai-mayor/host/mayor-narrator";

describe("near the player's population target the Mayor explains why the next district is smaller or not opened", () => {
  test("a cut district and a stop are both said, with the numbers", () => {
    const cut = narrateNote("growth: near the target population (92000 of 100000): a new district is cut to 304000 m2, what the 8000 people still to come would fill", "zh")!;
    expect(cut.text).toMatch(/快到目标 100,000.*约 30 公顷.*8,000 人/);
    const stop = narrateNote("growth: near the target population (98500 of 100000): a new district is cut to 57000 m2, what the 1500 people still to come would fill; that is less than the smallest district, so none is opened", "zh")!;
    expect(stop.text).toMatch(/不再开新区/);
  });
});