import { sendVirtualHidMouseClick } from "../../src/main/services/ai-mayor/v2/virtual-hid-mouse-adapter";

describe("Virtual HID Mouse adapter", () => {
  test("rejects values outside the control executable contract", async () => {
    await expect(sendVirtualHidMouseClick({ deltaX: 128, executablePath: "missing.exe" })).rejects.toThrow("deltaX");
  });

  test("does not silently skip the click phase", async () => {
    await expect(sendVirtualHidMouseClick({ deltaX: 1, deltaY: 0, executablePath: "missing.exe" })).rejects.toThrow();
  });
});
