// Manage Agda installations: discover, probe, download, and install.
//
// Discovery: scan PATH, well-known locations, and user-configured paths.
// Download: pre-built binaries from GitHub releases for linux (x64),
// macOS (arm64/x64), and Windows (x64). Archives are cached in
// globalStorage/archives/; extracted binaries live in globalStorage/bin/{tag}/.

import * as fs from "fs";
import * as https from "https";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import type { IncomingMessage } from "http";
import type { CancellationToken } from "vscode";
import { type AgdaVersion, agdaVersion, formatVersion, parseAgdaVersion } from "./version.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgdaPlatform {
  os: string;
  arch: string;
}

export interface AgdaRelease {
  version: AgdaVersion;
  url: string;
}

// ---------------------------------------------------------------------------
// Known releases
// ---------------------------------------------------------------------------

// Each list must be in descending version order (newest first) so the UI can label the latest.
// Keyed by "${os}-${arch}" matching os.platform() and os.arch() values.
const RELEASES: Record<string, AgdaRelease[]> = {
  "linux-x64": [
    {
      version: agdaVersion(2, 8, 0),
      url: "https://github.com/agda/agda/releases/download/v2.8.0/Agda-v2.8.0-linux.tar.xz",
    },
    {
      version: agdaVersion(2, 7, 0, 1),
      url: "https://github.com/agda/agda/releases/download/v2.7.0.1/Agda-v2.7.0.1-linux.tar.xz",
    },
  ],
  "darwin-arm64": [
    {
      version: agdaVersion(2, 8, 0),
      url: "https://github.com/agda/agda/releases/download/v2.8.0/Agda-v2.8.0-macOS-arm64.tar.xz",
    },
    {
      version: agdaVersion(2, 7, 0, 1),
      url: "https://github.com/agda/agda/releases/download/v2.7.0.1/Agda-v2.7.0.1-macOS.tar.xz",
    },
  ],
  "darwin-x64": [
    {
      version: agdaVersion(2, 8, 0),
      url: "https://github.com/agda/agda/releases/download/v2.8.0/Agda-v2.8.0-macOS-x64.tar.xz",
    },
    // v2.7.0.1 only has an arm64 macOS binary
  ],
  "win32-x64": [
    {
      version: agdaVersion(2, 8, 0),
      url: "https://github.com/agda/agda/releases/download/v2.8.0/Agda-v2.8.0-win64.zip",
    },
    // v2.8.0 is missing "zlib1.dll", so we vendor it. v2.7.0.1 is additionally missing MinGW
    // runtime DLLs "libgcc_s_seh-1.dll", "libstdc++-6.dll", and "libwinpthread-1.dll". Supporting
    // it is too much of a hassle.
  ],
};

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

export function detectPlatform(): AgdaPlatform {
  return { os: os.platform(), arch: os.arch() };
}

// ---------------------------------------------------------------------------
// Release lookup
// ---------------------------------------------------------------------------

export function getAvailableReleases(platform: AgdaPlatform): AgdaRelease[] {
  return RELEASES[`${platform.os}-${platform.arch}`] ?? [];
}

// ---------------------------------------------------------------------------
// Download and install
// ---------------------------------------------------------------------------

const AGDA_INSTALL_GUIDE =
  "https://agda.readthedocs.io/en/latest/getting-started/installation.html";

export { AGDA_INSTALL_GUIDE };

/**
 * Download and extract an Agda release. Returns the path to the binary.
 * Skips download if the archive is already cached; skips extraction if the
 * binary already exists.
 *
 * Handles two archive layouts:
 *   - v2.8.0+: bare `agda` at the archive root
 *   - v2.7.0.1: `Agda-v2.7.0.1/bin/agda` with `lib/` and `data/` alongside
 */
export async function downloadAndInstall(
  release: AgdaRelease,
  platform: AgdaPlatform,
  storageDir: string,
  extensionDir: string,
  progress: (message: string, increment?: number) => void,
  token?: CancellationToken,
): Promise<string> {
  const tag = `v${formatVersion(release.version)}`;
  const binDir = versionDir(storageDir, tag);

  const existing = await findAgdaBinary(binDir, platform);
  if (existing) {
    progress("Already installed", 100);
    return existing;
  }

  const archiveName = path.basename(new URL(release.url).pathname);
  const archive = archivePath(storageDir, archiveName);

  const needsDownload = !(await fileExists(archive));

  if (needsDownload) {
    await fs.promises.mkdir(archivesDir(storageDir), { recursive: true });
    progress("Downloading...", 0);
    await httpsDownloadToFile(
      release.url,
      archive,
      (received, total) => {
        if (total > 0) {
          const pct = Math.round((received / total) * 80);
          const mb = (received / 1024 / 1024).toFixed(1);
          const totalMb = (total / 1024 / 1024).toFixed(1);
          progress(`${mb} / ${totalMb} MB`, pct);
        }
      },
      token,
    );
  } else {
    progress("Using cached archive", 80);
  }

  progress("Extracting...", 80);
  await fs.promises.mkdir(binDir, { recursive: true });
  await extractArchive(archive, binDir, platform);

  // macOS: remove quarantine from the entire extracted tree
  if (platform.os === "darwin") {
    try {
      await execFileAsync("xattr", ["-cr", binDir]);
    } catch {
      // Not fatal -- attribute may not be set
    }
  }

  // The Agda 2.8.0 win64 release dynamically links zlib but doesn't bundle it.
  // Copy our vendored zlib1.dll next to agda.exe.
  if (platform.os === "win32") {
    const zlibSrc = path.join(extensionDir, "vendor", "win64", "zlib1.dll");
    const zlibDst = path.join(binDir, "zlib1.dll");
    if (!(await fileExists(zlibDst))) {
      await fs.promises.copyFile(zlibSrc, zlibDst);
    }
  }

  const binaryPath = await findAgdaBinary(binDir, platform);
  if (!binaryPath) {
    throw new Error(`Agda binary not found after extracting to ${binDir}`);
  }

  if (platform.os !== "win32") {
    await fs.promises.chmod(binaryPath, 0o755);
  }

  progress("Done", 100);
  return binaryPath;
}

// ---------------------------------------------------------------------------
// Discover installed versions
// ---------------------------------------------------------------------------

export interface InstalledAgda {
  version: AgdaVersion;
  path: string;
}

export type ProbeResult =
  | { path: string; kind: "ok"; version: AgdaVersion }
  | { path: string; kind: "failed"; reason: string };

/**
 * Resolve a path to its canonical form (symlinks resolved).
 * Falls back to path.resolve for non-existent files.
 */
async function normalizePath(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Check whether a candidate path is a working Agda binary.
 * The returned path is always normalized (symlinks resolved).
 * Returns the detected version on success, or a failure reason.
 */
export async function probeAgda(candidate: string): Promise<ProbeResult> {
  const normalized = await normalizePath(candidate);
  try {
    await fs.promises.access(candidate, fs.constants.X_OK);
  } catch {
    return { path: normalized, kind: "failed", reason: "file not found" };
  }
  const version = await detectAgdaVersion(candidate);
  if (!version) return { path: normalized, kind: "failed", reason: "not a valid Agda binary" };
  return { path: normalized, kind: "ok", version };
}

/** Scan globalStorage/bin/ for previously downloaded Agda binaries. */
export async function getDownloadedVersions(storageDir: string): Promise<InstalledAgda[]> {
  const binDir = binRoot(storageDir);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(binDir);
  } catch {
    return [];
  }

  const platform = detectPlatform();
  const results: InstalledAgda[] = [];
  for (const entry of entries) {
    const versionDir = path.join(binDir, entry);
    const binaryPath = await findAgdaBinary(versionDir, platform);
    if (!binaryPath) continue;

    // Parse version from directory name (e.g. "v2.8.0" → "2.8.0")
    const versionStr = entry.startsWith("v") ? entry.slice(1) : entry;
    try {
      const version = parseAgdaVersion(`Agda version ${versionStr}`);
      results.push({ version, path: await normalizePath(binaryPath) });
    } catch {
      // Skip directories with invalid version names
    }
  }
  return results;
}

/**
 * Well-known directories where Agda may be installed, beyond what is on
 * the system PATH (e.g. ~/.cabal/bin from `cabal install`).
 */
function wellKnownCandidates(platform: AgdaPlatform): string[] {
  const bin = binaryName(platform);
  const candidates: string[] = [];

  if (platform.os === "win32") {
    const appData = process.env.APPDATA;
    if (appData) candidates.push(path.join(appData, "cabal", "bin", bin));
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) candidates.push(path.join(localAppData, "ghcup", "bin", bin));
  } else {
    const home = os.homedir();
    candidates.push(
      path.join(home, ".cabal", "bin", bin),
      path.join(home, ".local", "bin", bin),
      path.join(home, ".ghcup", "bin", bin),
      path.join(home, ".nix-profile", "bin", bin),
      "/nix/var/nix/profiles/default/bin/" + bin,
    );
    if (platform.os === "darwin") {
      candidates.push("/opt/homebrew/bin/" + bin, "/usr/local/bin/" + bin);
    }
  }

  return candidates;
}

/**
 * Probe a list of candidate paths, deduplicating by normalized path.
 * Returns only successful probes (used for speculative discovery where
 * missing binaries are expected).
 */
async function probeUnique(candidates: string[]): Promise<InstalledAgda[]> {
  const seen = new Set<string>();
  const results: InstalledAgda[] = [];

  for (const candidate of candidates) {
    const result = await probeAgda(candidate);
    if (seen.has(result.path)) continue;
    seen.add(result.path);
    if (result.kind === "ok") {
      results.push({ version: result.version, path: result.path });
    }
  }

  return results;
}

/**
 * Probe well-known installation directories for Agda binaries that may
 * not be on the system PATH.
 */
export async function findWellKnownAgda(): Promise<InstalledAgda[]> {
  return probeUnique(wellKnownCandidates(detectPlatform()));
}

/**
 * Find Agda executables on the system PATH.
 * Returns unique paths with their detected versions.
 */
export async function findSystemAgda(): Promise<InstalledAgda[]> {
  const platform = detectPlatform();
  const dirs = (process.env.PATH ?? "").split(platform.os === "win32" ? ";" : ":").filter(Boolean);
  const binName = binaryName(platform);
  return probeUnique(dirs.map((dir) => path.join(dir, binName)));
}

/**
 * Probe user-configured additional paths, returning both valid and broken
 * results so broken entries can be surfaced in the UI.
 */
export function probeAdditionalPaths(paths: string[]): Promise<ProbeResult[]> {
  return Promise.all(paths.map((p) => probeAgda(p)));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function binRoot(storageDir: string): string {
  return path.join(storageDir, "bin");
}

function versionDir(storageDir: string, tag: string): string {
  return path.join(binRoot(storageDir), tag);
}

function archivesDir(storageDir: string): string {
  return path.join(storageDir, "archives");
}

function archivePath(storageDir: string, archiveName: string): string {
  return path.join(archivesDir(storageDir), archiveName);
}

function binaryName(platform: AgdaPlatform): string {
  return platform.os === "win32" ? "agda.exe" : "agda";
}

/**
 * Detect Agda_datadir for pre-2.8 bundled installs (e.g. v2.7.0.1)
 * whose binary is at Agda-&#42;/bin/agda with data/ alongside.
 * Returns the data directory path if found, or undefined.
 */
export function detectAgdaDatadir(agdaPath: string): string | undefined {
  const binDir = path.dirname(agdaPath);
  const dataDir = path.join(path.dirname(binDir), "data");
  try {
    fs.accessSync(path.join(dataDir, "lib"));
    return dataDir;
  } catch {
    return undefined;
  }
}

export function detectAgdaVersion(agdaPath: string): Promise<AgdaVersion | undefined> {
  return new Promise((resolve) => {
    execFile(agdaPath, ["--version"], { timeout: 10000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      try {
        resolve(parseAgdaVersion(stdout));
      } catch {
        resolve(undefined);
      }
    });
  });
}

/**
 * Search for the agda binary within a version directory.
 * Handles two layouts:
 *   - dir/agda              (v2.8.0+: bare binary at root)
 *   - dir/Agda-{tag}/bin/agda   (v2.7.0.1: nested in subdirectory)
 */
async function findAgdaBinary(dir: string, platform: AgdaPlatform): Promise<string | undefined> {
  const name = binaryName(platform);

  // Layout 1: binary at root
  const direct = path.join(dir, name);
  if (await fileExists(direct)) return direct;

  // Layout 2: Agda-*/bin/agda
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.startsWith("Agda-")) continue;
    const nested = path.join(dir, entry, "bin", name);
    if (await fileExists(nested)) return nested;
  }

  return undefined;
}

function extractArchive(
  archivePath: string,
  destDir: string,
  platform: AgdaPlatform,
): Promise<void> {
  // Linux/macOS: .tar.xz; Windows: .zip (but Windows bsdtar handles both)
  const args =
    platform.os === "win32"
      ? ["-xf", archivePath, "-C", destDir]
      : ["xJf", archivePath, "-C", destDir];

  return execFileAsync("tar", args);
}

function execFileAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`${cmd} ${args.join(" ")} failed: ${stderr || err.message}`));
      } else {
        resolve();
      }
    });
  });
}

/** Follow HTTP redirects (GitHub 302s to CDN). */
function followRedirects(
  url: string,
  token?: CancellationToken,
  maxRedirects = 5,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    if (token?.isCancellationRequested) {
      reject(new Error("Cancelled"));
      return;
    }

    const req = https.get(url, { headers: { "User-Agent": "agda2-vscode" } }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        if (maxRedirects <= 0) {
          reject(new Error("Too many redirects"));
          return;
        }
        // Consume response body to free socket
        res.resume();
        followRedirects(res.headers.location, token, maxRedirects - 1).then(resolve, reject);
      } else if (status >= 200 && status < 300) {
        resolve(res);
      } else {
        res.resume();
        reject(new Error(`HTTP ${status} for ${url}`));
      }
    });

    req.on("error", reject);

    if (token) {
      const disposable = token.onCancellationRequested(() => {
        req.destroy();
        disposable.dispose();
        reject(new Error("Cancelled"));
      });
    }
  });
}

/** Stream a URL to a file on disk. */
function httpsDownloadToFile(
  url: string,
  destPath: string,
  onProgress: (received: number, total: number) => void,
  token?: CancellationToken,
): Promise<void> {
  return new Promise((resolve, reject) => {
    followRedirects(url, token)
      .then((res) => {
        const total = parseInt(res.headers["content-length"] ?? "0", 10);
        let received = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, total);
        });

        res.pipe(fileStream);

        fileStream.on("finish", () => {
          fileStream.close();
          resolve();
        });

        fileStream.on("error", (err) => {
          // Clean up partial file
          fs.unlink(destPath, () => {});
          reject(err);
        });

        if (token) {
          const disposable = token.onCancellationRequested(() => {
            res.destroy();
            fileStream.close();
            fs.unlink(destPath, () => {});
            disposable.dispose();
            reject(new Error("Cancelled"));
          });
        }
      })
      .catch(reject);
  });
}
