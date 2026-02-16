#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

version=$(node -p "require('./package.json').version")
tag="v${version}"
vsix="agda2-vscode-${version}.vsix"

if ! git rev-parse "$tag" >/dev/null 2>&1; then
  echo "Error: tag ${tag} does not exist locally. Create it first with: git tag ${tag}" >&2
  exit 1
fi

if ! git ls-remote --tags origin "$tag" | grep -q "$tag"; then
  echo "Error: tag ${tag} is not pushed to origin. Push it first with: git push origin ${tag}" >&2
  exit 1
fi

echo "Building ${vsix}..."
npx vsce package

echo "Creating GitHub release ${tag}..."
gh release create "$tag" "$vsix" --title "$tag"
