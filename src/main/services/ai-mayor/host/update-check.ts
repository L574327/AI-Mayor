/**
 * THE PRODUCT'S OWN UPDATE CHECK. The owner's website publishes ONE small JSON file (`docs/UPDATE-MANIFEST.md` says what is in it); the product reads it,
 * compares versions, and — when the player says so — downloads the installer, verifies its SHA-256 against the manifest, and starts it. No account, no
 * server of ours, nothing is sent but the request for the file (the version is not even sent).
 *
 * Pure parts only here (parsing, comparing, verifying); the network and the installer launch are in `main.ts`.
 */
import { createHash } from "node:crypto";

/** Where the manifest lives unless `AI_MAYOR_UPDATE_URL` names another (the owner's site). */
export const DEFAULT_MANIFEST_URL = "https://my-portfolio-six-livid-63.vercel.app/ai-mayor/latest.json";

export interface UpdateManifest {
  version: string;
  notes: string;
  /** https URL of the installer (.exe). Absent: only the page below is offered. */
  downloadUrl: string | null;
  /** Lower-case hex SHA-256 of the installer. The installer is only run when this matches what was downloaded. */
  sha256: string | null;
  /** https page to open when the installer cannot be fetched in-app (or has no hash). */
  pageUrl: string | null;
  /** Players below this version are told the update is required (still never forced). */
  minimumVersion: string | null;
  /** The size in bytes, for the progress line (optional). */
  sizeBytes: number | null;
}

const SEMVER = /^\d+(?:\.\d+){1,3}$/;
const https = (value: unknown): string | null => (typeof value === "string" && /^https:\/\/[^\s]+$/i.test(value.trim()) ? value.trim() : null);

/** One manifest from parsed JSON; null when it is not one (missing/odd version) — a bad file never produces an update. */
export function parseManifest(raw: unknown): UpdateManifest | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const version = typeof row.version === "string" ? row.version.trim().replace(/^v/i, "") : "";
  if (!SEMVER.test(version)) return null;
  const sha = typeof row.sha256 === "string" && /^[a-f0-9]{64}$/i.test(row.sha256.trim()) ? row.sha256.trim().toLowerCase() : null;
  const minimum = typeof row.minimumVersion === "string" && SEMVER.test(row.minimumVersion.trim().replace(/^v/i, "")) ? row.minimumVersion.trim().replace(/^v/i, "") : null;
  const notesRaw = row.notes;
  const notes = Array.isArray(notesRaw) ? notesRaw.map(String).join("\n") : typeof notesRaw === "string" ? notesRaw : "";
  const size = Number(row.sizeBytes);
  return { version, notes: notes.slice(0, 2_000), downloadUrl: https(row.downloadUrl), sha256: sha, pageUrl: https(row.pageUrl), minimumVersion: minimum,
    sizeBytes: Number.isFinite(size) && size > 0 ? size : null };
}

/** -1, 0, 1 as `left` is older than, equal to, newer than `right` (numeric, missing parts are 0). */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export type UpdateVerdict =
  | { kind: "UP_TO_DATE"; current: string; latest: string }
  | { kind: "AVAILABLE"; current: string; manifest: UpdateManifest; required: boolean; canInstallInApp: boolean };

export function judgeUpdate(current: string, manifest: UpdateManifest): UpdateVerdict {
  if (compareVersions(manifest.version, current) <= 0) return { kind: "UP_TO_DATE", current, latest: manifest.version };
  return { kind: "AVAILABLE", current, manifest, required: manifest.minimumVersion !== null && compareVersions(current, manifest.minimumVersion) < 0,
    // In-app install needs an https installer AND its hash: without the hash nothing is run, the page is opened instead.
    canInstallInApp: manifest.downloadUrl !== null && manifest.sha256 !== null };
}

/** The hex SHA-256 of bytes (streamed by the caller through `createHash` when large; this is for small checks and tests). */
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Whether a downloaded file's hash is the manifest's. */
export const hashMatches = (actualHex: string, manifest: Pick<UpdateManifest, "sha256">): boolean => manifest.sha256 !== null && actualHex.toLowerCase() === manifest.sha256;
