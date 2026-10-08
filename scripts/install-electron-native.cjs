const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const electronVersion = require(path.join(root, "node_modules", "electron", "package.json")).version;
const installer = path.join(root, "node_modules", "prebuild-install", "bin.js");
const packageDirectories = [
  path.join(root, "node_modules", "better-sqlite3"),
  path.join(root, "output", "node_modules", "better-sqlite3"),
].filter((directory) => fs.existsSync(path.join(directory, "package.json")));

for (const directory of packageDirectories) {
  const result = spawnSync(
    process.execPath,
    [
      installer,
      "--runtime=electron",
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
      `--platform=${process.platform}`,
      "--force",
    ],
    { cwd: directory, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
