import path from "node:path";
import { resolveUserDataFolder } from "../../src/main/services/ai-mayor/brand/user-data-folder";

describe("where the product keeps its data", () => {
  test("under its own folder in the roaming application data", () => {
    const appData = path.join("C:", "Users", "x", "AppData", "Roaming");
    expect(resolveUserDataFolder(appData)).toBe(path.join(appData, "AI Mayor"));
  });
});
