/**
 * Vitest global setup: downloads all available Agda binaries for the
 * current platform before any tests run. Binary paths are provided to
 * test files via vitest's provide/inject mechanism.
 *
 * Binaries are cached in .agda-test-binaries/ at the project root so
 * subsequent test runs skip the download.
 */

import type { TestProject } from "vitest/node";
import * as path from "path";
import { fileURLToPath } from "url";
import {
  detectPlatform,
  getAvailableReleases,
  downloadAndInstall,
} from "../../src/agda/installations.js";
import { formatVersion } from "../../src/agda/version.js";
import type { TestAgdaBinary } from "../helpers/agdaSession.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "../../.agda-test-binaries");

// Extend vitest's ProvidedContext so inject() is typed.
declare module "vitest" {
  export interface ProvidedContext {
    agdaBinaries: TestAgdaBinary[];
  }
}

export default async function (project: TestProject) {
  const platform = detectPlatform();
  const releases = getAvailableReleases(platform);

  if (releases.length === 0) {
    console.warn(
      `\n  No Agda releases available for platform ${platform.os}-${platform.arch}.\n` +
        `  Integration tests will be skipped.\n`,
    );
    project.provide("agdaBinaries", []);
    return;
  }

  console.log(
    `\n  Ensuring ${releases.length} Agda version(s) for ${platform.os}-${platform.arch}...\n`,
  );

  const binaries: TestAgdaBinary[] = [];

  for (const release of releases) {
    const versionStr = formatVersion(release.version);
    try {
      const binaryPath = await downloadAndInstall(release, platform, CACHE_DIR, (msg) =>
        console.log(`    [Agda ${versionStr}] ${msg}`),
      );
      binaries.push({ version: versionStr, binaryPath });
      console.log(`    Agda ${versionStr} ready at ${binaryPath}`);
    } catch (err) {
      console.error(`    Failed to download Agda ${versionStr}: ${err}`);
    }
  }

  if (binaries.length === 0) {
    console.warn("\n  No Agda binaries available. Integration tests will be skipped.\n");
  } else {
    console.log(`\n  ${binaries.length} Agda version(s) ready.\n`);
  }

  project.provide("agdaBinaries", binaries);
}
