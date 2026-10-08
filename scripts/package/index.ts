import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { notarize } from "@electron/notarize";
import { type BuildResult, build } from "electron-builder";
import { existsSync, readdirSync, readFile, readFileSync, rmSync, statSync, writeFile, writeFileSync } from "fs-extra";
import { stringify } from "yaml";

const publish = process.argv.includes("--publish");

const signLinuxAppImages = async (result: BuildResult) => {
  if (process.platform !== "linux") {
    return;
  }

  const appImages = result.artifactPaths.filter((artifact) => artifact.endsWith(".AppImage"));

  if (!appImages.length) {
    return console.warn("No AppImages found in artifact paths, skipping signing");
  }

  if (!process.env.GPG_SECRET_KEY_B64) {
    return console.warn("GPG_SECRET_KEY_B64 environment variable not set, skipping AppImage signing");
  }

  const secretKey = Buffer.from(process.env.GPG_SECRET_KEY_B64, "base64").toString("utf-8");
  if (!secretKey.includes("BEGIN PGP PRIVATE KEY BLOCK")) {
    console.error("[signLinuxAppImages] Decoded secret key does NOT contain BEGIN PGP PRIVATE KEY BLOCK");
  }
  const secretKeyPassword = process.env.GPG_SECRET_KEY_PASSWORD || "";

  let importSecretKeyResult: string;

  try {
    importSecretKeyResult = execSync("gpg --batch --yes --pinentry-mode loopback --import --logger-fd 1", {
      input: secretKey,
      encoding: "utf-8",
    });
    console.info("[signLinuxAppImages] GPG import stdout:\n", importSecretKeyResult);
  } catch (err: any) {
    console.error("[signLinuxAppImages] GPG import failed");
    console.error("exit code:", err.status);
    if (err.stdout) {
      console.error("stdout:", err.stdout.toString());
    }
    if (err.stderr) {
      console.error("stderr:", err.stderr.toString());
    }
    throw err;
  }

  const listOutput = execSync("gpg --list-secret-keys --with-colons", {
    encoding: "utf-8",
  });

  const secLine = listOutput.split("\n").find((line) => line.startsWith("sec:"));

  if (!secLine) {
    throw new Error("No secret key found after import");
  }

  const keyId = secLine.split(":")[4];
  console.info(`Using key: ${keyId}`);

  const additionalFiles: string[] = [];

  for (const appImage of appImages) {
    console.info(`Signing AppImage with key ${keyId}: ${appImage}`);

    execSync(
      `gpg --detach-sign --armor --batch --passphrase-fd 0 --pinentry-mode loopback --yes --default-key ${keyId} "${appImage}"`,
      {
        input: `${secretKeyPassword}\n`,
      },
    );

    additionalFiles.push(`${appImage}.asc`);
  }

  return additionalFiles;
};

const generateManifest = async (result: BuildResult) => {
  const file = join(result.outDir, `manifest-${process.platform}-${process.arch}.yml`);
  const content = {
    files: await Promise.all(
      result.artifactPaths
        .filter((artifact) => {
          return !artifact.endsWith(".blockmap");
        })
        .map(async (artifact) => {
          const content = await readFile(artifact);
          const sha512 = createHash("sha512").update(content).digest().toString("base64");
          const size = content.byteLength;

          return {
            url: basename(artifact),
            sha512,
            size,
          };
        }),
    ),
  };

  await writeFile(file, stringify(content, { aliasDuplicateObjects: false }));

  return [file];
};

build({
  config: {
    // The product is AI Mayor (the chat client it grew out of stays reachable for development with AI_MAYOR_CHAT_CLIENT=1).
    productName: "AI Mayor",
    appId: "app.aimayor.desktop",
    // The game connector (MCP server) and the game mod, staged by scripts/package/prepare-mayor-bundle.ts.
    extraResources: [{ from: "mayor-bundle", to: "mayor", filter: ["**/*"] }, { from: "LICENSE", to: "LICENSE.txt" }, { from: "NOTICE", to: "NOTICE.txt" }, { from: "licenses", to: "licenses", filter: ["**/*"] }],
    // Using maximum compression on Linux can cause excessively long application startup times
    compression: process.platform === "linux" ? "normal" : "maximum",
    asar: false,
    asarUnpack: ["**/node_modules/**/*"],
    protocols: [
      {
        name: "ai-mayor-deep-linking",
        schemes: ["app.aimayor"],
      },
    ],
    electronLanguages: ["zh_CN", "en"],
    files: [
      // No source maps anywhere in the product (they would ship the source).
      "!**/*.map",
      "!**/node_modules/**/*.map",
      "!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme,LICENSE,test.js,license}",
      "!**/node_modules/*/{test,__tests__,tests,powered-test,example,examples}",
      "!**/node_modules/*.d.ts",
      "!**/node_modules/.bin",
      "!**/*.{iml,o,hprof,orig,pyc,pyo,rbc,swp,csproj,sln,xproj,md,txt}",
      "!**/._*",
      "!**/{.DS_Store,.git,.hg,.svn,CVS,RCS,SCCS,.gitignore,.gitattributes}",
      "!**/{__pycache__,docs, thumbs.db,.flowconfig,.idea,.vs,.nyc_output}",
      "!**/{appveyor.yml,.travis.yml,circle.yml}",
      "!**/{npm-debug.log,yarn.lock,.yarn-integrity,.yarn-metadata.json}",
    ],
    afterPack: async (ctx) => {
      // The bundler bakes the build machine's source paths (file:///<repository>/node_modules/...) into the compiled files. They name a folder that does not
      // exist on the player's machine (and the build machine's folder layout is nobody's business): scrubbed to a neutral root. The code that reads them
      // already falls back when the path does not resolve.
      {
        const appDir = join(ctx.appOutDir, "resources", "app");
        const rootUrl = `file:///${process.cwd().replace(/\\/g, "/")}`;
        const scrub = (dir: string) => {
          for (const entry of readdirSync(dir)) {
            if (entry === "node_modules") continue;
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) { scrub(full); continue; }
            if (!/\.(c?js|mjs)$/.test(entry) || statSync(full).size > 40 * 1024 * 1024) continue;
            const text = readFileSync(full, "utf8");
            if (text.includes(rootUrl)) writeFileSync(full, text.split(rootUrl).join("file:///app"));
          }
        };
        if (existsSync(appDir)) scrub(appDir);
      }
      // On a workstation that cannot extract electron-builder's signing tools (no symlink right) the executable keeps Electron's icon and version strings.
      // The product's own icon and names are written into it here with the rcedit that tool cache already holds, so the .exe never shows another name.
      if (process.platform === "win32" && process.env.AI_MAYOR_SKIP_WINDOWS_SIGNING_TOOLS === "1") {
        const cache = join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "electron-builder", "Cache", "winCodeSign");
        const rcedit = existsSync(cache)
          ? readdirSync(cache).map((entry) => join(cache, entry, "rcedit-x64.exe")).find((candidate) => existsSync(candidate))
          : undefined;
        const exe = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.exe`);
        if (rcedit && existsSync(exe)) {
          execFileSync(rcedit, [exe, "--set-icon", join(process.cwd(), "build", "icon.ico"),
            "--set-version-string", "ProductName", "AI Mayor", "--set-version-string", "FileDescription", "AI Mayor",
            "--set-version-string", "InternalName", "AI Mayor", "--set-version-string", "OriginalFilename", `${ctx.packager.appInfo.productFilename}.exe`,
            "--set-version-string", "CompanyName", "AI Mayor", "--set-version-string", "LegalCopyright", "AI Mayor"]);
        } else console.warn("rcedit not found in the electron-builder cache: the executable keeps its default icon and version strings");
      }
      if (process.platform === "darwin") {
        const resources = join(
          ctx.appOutDir,
          `${ctx.packager.appInfo.productName}.app`,
          "Contents",
          "Frameworks",
          "Electron Framework.framework",
          "Resources",
        );

        if (existsSync(resources)) {
          const items = readdirSync(resources);

          for (const item of items) {
            if (item.endsWith(".lproj") && item !== `en.lproj` && item !== `zh_CN.lproj`) {
              rmSync(join(resources, item), { force: true, recursive: true });
            }
          }
        }
      }
    },
    afterSign: async (ctx) => {
      if (ctx.electronPlatformName !== "darwin") {
        return;
      }

      const appleId = process.env.APPLE_ID;
      const appleIdPass = process.env.APPLE_ID_PASS;
      const appleTeamId = process.env.APPLE_TEAM_ID;

      if (!appleId || !appleIdPass || !appleTeamId) {
        return console.warn(
          "Skipping notarization. APPLE_ID, APPLE_ID_PASS, and APPLE_TEAM_ID environment variables must be set",
        );
      }

      console.info("Notarizing...");

      await notarize({
        tool: "notarytool",
        appPath: `${ctx.appOutDir}/${ctx.packager.appInfo.productFilename}.app`,
        teamId: appleTeamId,
        appleId: appleId,
        appleIdPassword: appleIdPass,
      });

      console.info("Notarization complete");
    },
    afterAllArtifactBuild: async (ctx) => {
      const additionalFiles: string[] = [];

      await signLinuxAppImages(ctx).then((files) => {
        if (files) {
          additionalFiles.push(...files);
        }
      });

      await generateManifest(ctx).then((files) => {
        if (files) {
          additionalFiles.push(...files);
        }
      });

      return additionalFiles;
    },
    mac: {
      target: ["dmg", "zip"],
      notarize: false,
      electronLanguages: ["zh_CN", "en"],
    },
    dmg: {
      contents: [
        {
          x: 130,
          y: 220,
        },
        {
          x: 410,
          y: 220,
          type: "link",
          path: "/Applications",
        },
      ],
    },
    nsis: {
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      // Per user: no administrator rights needed, and the game mod goes to the same user's game folder.
      perMachine: false,
      shortcutName: "AI Mayor",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder macro
      artifactName: "AI-Mayor-Setup-${version}.${ext}",
    },
    win: {
      target: ["nsis"],
      // CI/workstation fallback for Windows accounts that cannot create the
      // macOS symlinks bundled in winCodeSign. This only skips executable
      // resource editing/signing; the default production behavior is unchanged.
      signAndEditExecutable: process.env.AI_MAYOR_SKIP_WINDOWS_SIGNING_TOOLS !== "1",
    },
    linux: {
      target: ["AppImage"],
      category: "Development",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: x
      artifactName: "${productName}-${version}-${arch}.${ext}",
    },
    directories: {
      output: "release",
      app: "output",
    },
    // No update feed is baked into the build (an automatic feed taken from the git remote would name another project); see AI_MAYOR_UPDATE_URL in updater.ts.
    publish: null,
  },
  publish: publish ? "always" : undefined,
});
