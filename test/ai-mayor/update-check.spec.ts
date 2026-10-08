import { compareVersions, hashMatches, judgeUpdate, parseManifest, sha256Hex } from "../../src/main/services/ai-mayor/host/update-check";

describe("the product's own update check: one JSON file on the owner's site, nothing run unless its hash matches", () => {
  const good = { version: "v0.2.0", notes: ["a", "b"], downloadUrl: "https://example.com/Setup.exe", sha256: "A".repeat(64), pageUrl: "https://example.com/p", minimumVersion: "0.1.0", sizeBytes: 100 };

  test("a manifest is read; the hash is normalised; notes may be a list", () => {
    expect(parseManifest(good)).toMatchObject({ version: "0.2.0", notes: "a\nb", sha256: "a".repeat(64), downloadUrl: "https://example.com/Setup.exe", minimumVersion: "0.1.0", sizeBytes: 100 });
  });
  test("a bad file never produces an update; a non-https link is dropped", () => {
    for (const bad of [null, "x", {}, { version: "latest" }, { version: "1" }]) expect(parseManifest(bad)).toBeNull();
    expect(parseManifest({ ...good, downloadUrl: "http://example.com/a.exe", pageUrl: "javascript:alert(1)", sha256: "zz" })).toMatchObject({ downloadUrl: null, pageUrl: null, sha256: null });
  });
  test("versions compare by number, not by text", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
    expect(compareVersions("0.1.0", "0.1")).toBe(0);
    expect(compareVersions("0.1.0", "0.1.1")).toBe(-1);
  });
  test("newer = available; same or older = up to date; below the minimum = required", () => {
    const manifest = parseManifest(good)!;
    expect(judgeUpdate("0.2.0", manifest).kind).toBe("UP_TO_DATE");
    expect(judgeUpdate("0.3.0", manifest).kind).toBe("UP_TO_DATE");
    expect(judgeUpdate("0.1.5", manifest)).toMatchObject({ kind: "AVAILABLE", required: false, canInstallInApp: true });
    expect(judgeUpdate("0.0.9", manifest)).toMatchObject({ kind: "AVAILABLE", required: true });
  });
  test("without a hash the installer is never run in-app: only the page is offered", () => {
    const noHash = parseManifest({ ...good, sha256: undefined })!;
    expect(judgeUpdate("0.1.0", noHash)).toMatchObject({ kind: "AVAILABLE", canInstallInApp: false });
    expect(hashMatches("a".repeat(64), noHash)).toBe(false);
  });
  test("the downloaded bytes must hash to the published value", () => {
    const bytes = new TextEncoder().encode("installer");
    const manifest = parseManifest({ ...good, sha256: sha256Hex(bytes) })!;
    expect(hashMatches(sha256Hex(bytes), manifest)).toBe(true);
    expect(hashMatches(sha256Hex(new TextEncoder().encode("tampered")), manifest)).toBe(false);
  });
});