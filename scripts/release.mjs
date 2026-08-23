#!/usr/bin/env node
//
// Publish a release of the extension to:
//   - the VS Code Marketplace  (vsce; needs VSCE_PAT)
//   - Open VSX                 (ovsx; needs OVSX_PAT)
//   - GitHub                   (tag + release with the .vsix attached; needs gh)
//
// One-time setup (put values in a gitignored .env file at the repo root;
// real environment variables with the same names take precedence):
//   1. Marketplace auth, ONE of:
//        VSCE_PAT=...   Azure DevOps personal access token with the
//                       "Marketplace > Manage" scope, for the publisher "bdrisc".
//                       NOTE: global ("all accessible organizations") PATs stop
//                       working on 2026-12-01; whether org-scoped PATs will be
//                       accepted is tracked in microsoft/vscode#322741.
//        VSCE_AUTH=azure-credential
//                       Publish with Microsoft Entra ID instead of a PAT:
//                       sign in with `az login` as the Microsoft account that
//                       has access to the "bdrisc" publisher.
//   2. OVSX_PAT=...    open-vsx.org access token for the "bdrisc" namespace:
//                       https://open-vsx.org/user-settings/tokens
//   3. Log in to the GitHub CLI (gh auth login).
//
// Per release:
//   1. Bump "version" in package.json and add a matching "## [vX.Y.Z](...)"
//      section to CHANGELOG.md (it becomes the GitHub release notes).
//   2. Commit and push to master.
//   3. npm run release
//
// Anything already done (a store that already has this version, an existing
// tag or release) is skipped, so re-running resumes a partial release.
//
// Usage: scripts/release.mjs [--dry-run] [--skip-tests]
//   --dry-run     Run every check and build the .vsix, but do not publish,
//                 tag, or create a release. Preflight failures become warnings.
//   --skip-tests  Do not run npm test (for emergencies only).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--dry-run" && flag !== "--skip-tests") {
    console.error("usage: scripts/release.mjs [--dry-run] [--skip-tests]");
    process.exit(2);
  }
}
const dryRun = flags.has("--dry-run");
const skipTests = flags.has("--skip-tests");

const info = (msg) => console.log(`\x1b[1;34m==>\x1b[0m ${msg}`);
const warn = (msg) => console.error(`\x1b[1;33mwarning:\x1b[0m ${msg}`);
const die = (msg) => {
  console.error(`\x1b[1;31merror:\x1b[0m ${msg}`);
  process.exit(1);
};
// Fatal normally, a warning under --dry-run.
const softDie = (msg) => (dryRun ? warn(msg) : die(msg));

// Run a command, streaming its output; die if it fails.
function run(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: "inherit" });
  if (res.error) die(`${cmd} failed to start: ${res.error.message}`);
  if (res.status !== 0) {
    die(`"${cmd} ${args.join(" ")}" failed (${res.signal ?? `status ${res.status}`})`);
  }
}

// Run a command and return its stdout, or null if it fails.
function capture(cmd, args) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (res.error || res.status !== 0) return null;
  return res.stdout.trim();
}

const succeeds = (cmd, args) => capture(cmd, args) !== null;

function mustCapture(cmd, args) {
  const out = capture(cmd, args);
  if (out === null) die(`"${cmd} ${args.join(" ")}" failed`);
  return out;
}

// The changelog section for `tag`: the lines between the "## [<tag>](...)"
// heading and the next "## " heading.
function changelogSection(tag) {
  const body = [];
  let found = false;
  for (const line of readFileSync("CHANGELOG.md", "utf8").split("\n")) {
    if (line.startsWith("## ")) {
      if (found) break;
      found = line.includes(`[${tag}]`);
      continue;
    }
    if (found && (body.length > 0 || line.trim() !== "")) body.push(line);
  }
  return body.join("\n").trimEnd();
}

// Load VSCE_PAT / OVSX_PAT from a gitignored .env file at the repo root;
// real environment variables take precedence.
if (existsSync(".env")) {
  if (succeeds("git", ["ls-files", "--error-unmatch", ".env"])) {
    softDie(".env is tracked by git; it holds secrets and must stay untracked");
  }
  for (const [key, value] of Object.entries(parseEnv(readFileSync(".env", "utf8")))) {
    process.env[key] ??= value;
  }
}

const vsceAuth = process.env.VSCE_AUTH ?? "pat";
if (vsceAuth !== "pat" && vsceAuth !== "azure-credential") {
  die(`VSCE_AUTH must be "pat" or "azure-credential" (got "${vsceAuth}")`);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const { name, publisher, version } = pkg;
const repoUrl = pkg.repository.url.replace(/\.git$/, "");
const extId = `${publisher}.${name}`;
const tag = `v${version}`;
const vsix = `${name}-${version}.vsix`;

info(`Releasing ${extId} ${version}`);

const branch = mustCapture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "master") {
  softDie(`releases must be cut from master (currently on ${branch})`);
}
if (mustCapture("git", ["status", "--porcelain"]) !== "") {
  softDie("working tree has uncommitted changes; commit or stash first");
}
if (
  spawnSync("git", ["fetch", "-q", "origin", "master", "--tags"], { stdio: "inherit" }).status === 0
) {
  if (
    mustCapture("git", ["rev-parse", "HEAD"]) !== mustCapture("git", ["rev-parse", "origin/master"])
  ) {
    softDie("HEAD does not match origin/master; push (or pull) first");
  }
} else {
  softDie("could not fetch from origin");
}

const notes = changelogSection(tag);
if (!notes) softDie(`CHANGELOG.md has no "## [${tag}]" section for this version`);

info("Installing dependencies (npm ci)...");
run("npm", ["ci"]);

info("Checking what is already published...");
let mpVersion = "unknown";
try {
  mpVersion =
    JSON.parse(capture("npx", ["vsce", "show", extId, "--json"])).versions[0].version ?? "unknown";
} catch {}
let ovsxVersion = "unknown";
try {
  const res = await fetch(`https://open-vsx.org/api/${publisher}/${name}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (res.ok) ovsxVersion = (await res.json()).version ?? "unknown";
} catch {}

const headSha = mustCapture("git", ["rev-parse", "HEAD"]);
const tagSha = capture("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
if (tagSha !== null && tagSha !== headSha) {
  softDie(
    `tag ${tag} already exists but points at ${tagSha.slice(0, 12)}, not HEAD (forgot to bump the version?)`,
  );
}
const remoteTag = succeeds("git", ["ls-remote", "--exit-code", "origin", `refs/tags/${tag}`]);
const releaseExists = succeeds("gh", ["release", "view", tag]);

const needMp = mpVersion !== version;
const needOvsx = ovsxVersion !== version;
const needTag = tagSha === null || !remoteTag;
const needRelease = !releaseExists;

const step = (needed, todo, done) =>
  console.log(`      ${needed ? "todo" : "done"}  ${needed ? todo : done}`);
info(`Plan for ${version}:`);
step(
  needMp,
  `publish to VS Code Marketplace (latest there: ${mpVersion})`,
  `VS Code Marketplace already has ${version}`,
);
step(
  needOvsx,
  `publish to Open VSX (latest there: ${ovsxVersion})`,
  `Open VSX already has ${version}`,
);
step(needTag, `create git tag ${tag} and push it to origin`, `tag ${tag} exists on origin`);
step(
  needRelease,
  `create GitHub release ${tag} with ${vsix} attached`,
  `GitHub release ${tag} exists`,
);

if (!needMp && !needOvsx && !needTag && !needRelease) {
  info(`Nothing to do; ${version} is fully released.`);
  process.exit(0);
}

if (needMp) {
  if (vsceAuth === "azure-credential") {
    if (!succeeds("az", ["account", "show"])) {
      softDie("VSCE_AUTH=azure-credential requires a logged-in Azure CLI (run: az login)");
    }
  } else if (!process.env.VSCE_PAT) {
    softDie(
      "VSCE_PAT is not set; add it to .env or the environment, or use VSCE_AUTH=azure-credential (see the header of this script)",
    );
  }
}
if (needOvsx && !process.env.OVSX_PAT) {
  softDie("OVSX_PAT is not set; add it to .env or the environment (see the header of this script)");
}
if (needRelease && !succeeds("gh", ["auth", "status"])) {
  softDie("GitHub CLI is not authenticated (run: gh auth login)");
}

if (skipTests) {
  warn("skipping tests (--skip-tests)");
} else {
  info("Running tests...");
  run("npm", ["test"]);
}

info(`Packaging ${vsix}...`);
run("npx", ["vsce", "package", "-o", vsix]);

if (dryRun) {
  info(`Dry run complete: built ${vsix}; nothing was published.`);
  process.exit(0);
}

if (needMp) {
  info("Publishing to the VS Code Marketplace...");
  const publishArgs = ["vsce", "publish", "--packagePath", vsix];
  if (vsceAuth === "azure-credential") publishArgs.push("--azure-credential");
  run("npx", publishArgs);
  info(
    "Published (new versions can take a few minutes to appear while the Marketplace verifies them).",
  );
}

if (needOvsx) {
  info("Publishing to Open VSX...");
  run("npx", ["ovsx", "publish", vsix]);
}

if (needTag) {
  if (tagSha === null) {
    info(`Tagging ${tag}...`);
    run("git", ["tag", "-a", tag, "-m", tag]);
  }
  info(`Pushing ${tag} to origin...`);
  run("git", ["push", "-q", "origin", `refs/tags/${tag}`]);
}

if (needRelease) {
  info(`Creating GitHub release ${tag}...`);
  run("gh", ["release", "create", tag, vsix, "--verify-tag", "--title", tag, "--notes", notes]);
}

info(`Release ${version} complete:`);
for (const url of [
  `https://marketplace.visualstudio.com/items?itemName=${extId}`,
  `https://open-vsx.org/extension/${publisher}/${name}`,
  `${repoUrl}/releases/tag/${tag}`,
]) {
  console.log(`      ${url}`);
}
