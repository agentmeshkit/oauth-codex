#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'USAGE'
Usage:
  ./release.sh <patch|minor|major|X.Y.Z> [--publish]
  ./release.sh --help

Without --publish, the script ensures dependencies are present, then runs
typecheck, tests, build, and a
package dry-run without changing the version. Add --publish to bump the
version, commit and push main, publish to GitHub Packages, and verify it.
USAGE
}

die() {
  printf 'release: %s\n' "$*" >&2
  exit 1
}

next_version() {
  local current="$1"
  local spec="$2"
  local major minor patch

  if [[ "$spec" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    printf '%s\n' "$spec"
    return
  fi
  if [[ ! "$current" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    die "current version is not plain semver: $current"
  fi

  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  case "$spec" in
    major) printf '%s.0.0\n' "$((major + 1))" ;;
    minor) printf '%s.%s.0\n' "$major" "$((minor + 1))" ;;
    patch) printf '%s.%s.%s\n' "$major" "$minor" "$((patch + 1))" ;;
    *) die "version must be patch, minor, major, or X.Y.Z" ;;
  esac
}

publish=false
version_spec=""

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --publish)
      publish=true
      ;;
    -*)
      die "unknown option: $arg"
      ;;
    *)
      [[ -z "$version_spec" ]] || die "only one version argument is allowed"
      version_spec="$arg"
      ;;
  esac
done

[[ -n "$version_spec" ]] || {
  usage
  exit 2
}

for command in git node npm; do
  command -v "$command" >/dev/null 2>&1 || die "missing command: $command"
done

[[ "$(git branch --show-current)" == "main" ]] || die "releases must run on main"
[[ -z "$(git status --porcelain)" ]] || die "worktree must be clean before release"

git fetch origin main
[[ "$(git rev-list --left-right --count origin/main...HEAD)" == $'0\t0' ]] ||
  die "local main must exactly match origin/main"

package_name="$(node -p "require('./package.json').name")"
current_version="$(node -p "require('./package.json').version")"
target_version="$(next_version "$current_version" "$version_spec")"

printf 'Package: %s\nCurrent: %s\nTarget:  %s\n' \
  "$package_name" "$current_version" "$target_version"

if [[ ! -d node_modules ]]; then
  CI=true npm install --no-package-lock
else
  printf 'Dependencies already installed; keeping the existing dependency tree.\n'
fi
npm run typecheck
CI=true npm test
npm run build
npm pack --dry-run >/dev/null

if [[ "$publish" != true ]]; then
  printf 'Dry run complete. Publish with: ./release.sh %s --publish\n' \
    "$target_version"
  exit 0
fi

if [[ -z "${GH_PACKAGES_TOKEN:-}" ]]; then
  if [[ -r "$HOME/.gh-packages-token" ]]; then
    GH_PACKAGES_TOKEN="$(tr -d '\r\n' < "$HOME/.gh-packages-token")"
  elif command -v gh >/dev/null 2>&1; then
    GH_PACKAGES_TOKEN="$(gh auth token)"
  else
    die "set GH_PACKAGES_TOKEN or create ~/.gh-packages-token"
  fi
fi
[[ -n "$GH_PACKAGES_TOKEN" ]] || die "GitHub Packages token is empty"

npmrc="$(mktemp)"
trap 'rm -f "$npmrc"' EXIT
chmod 600 "$npmrc"
printf '%s\n' \
  '@agentmeshkit:registry=https://npm.pkg.github.com' \
  "//npm.pkg.github.com/:_authToken=$GH_PACKAGES_TOKEN" > "$npmrc"

if npm view "$package_name@$target_version" version \
  --userconfig "$npmrc" >/dev/null 2>&1; then
  die "$package_name@$target_version is already published"
fi

if [[ "$target_version" != "$current_version" ]]; then
  npm version "$target_version" --no-git-tag-version
  git add package.json
  git commit -m "chore(release): $target_version"
  git push origin main
else
  printf 'Version already set to %s; continuing with publish recovery.\n' \
    "$target_version"
fi

npm publish --userconfig "$npmrc"

for _ in 1 2 3 4 5 6 7 8 9 10; do
  published="$(npm view "$package_name@$target_version" version \
    --userconfig "$npmrc" 2>/dev/null || true)"
  if [[ "$published" == "$target_version" ]]; then
    printf 'Published and verified: %s@%s\n' "$package_name" "$target_version"
    exit 0
  fi
  sleep 3
done

die "publish returned successfully but registry verification timed out"
