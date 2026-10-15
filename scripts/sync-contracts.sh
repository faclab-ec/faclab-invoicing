#!/usr/bin/env bash
# Copies the event contracts (contracts/) from faclab-core at a commit, branch or tag and pins the
# commit in contracts/source.json. CI compares the copy with faclab-core at that commit, so it is
# never edited by hand. See contracts/README.md.
#
#   npm run contracts:sync -- <full commit sha | branch | tag>
#   CORE_REPO=../faclab-core npm run contracts:sync -- <branch>   # local clone, before it is pushed
set -euo pipefail

ref="${1:?usage: npm run contracts:sync -- <full commit sha | branch | tag>}"
repo="${CORE_REPO:-https://github.com/faclab-ec/faclab-api.git}"
# git runs from a temporary directory: a local clone needs an absolute path
if [ -d "$repo" ]; then repo="$(cd "$repo" && pwd)"; fi
root="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

git -C "$tmp" init -q
git -C "$tmp" fetch -q --depth 1 "$repo" "$ref"
commit="$(git -C "$tmp" rev-parse FETCH_HEAD)"
git -C "$tmp" checkout -q FETCH_HEAD -- contracts

rm -rf "$root/contracts"
cp -R "$tmp/contracts" "$root/contracts"
cat > "$root/contracts/source.json" <<EOF
{
  "repository": "faclab-ec/faclab-api",
  "commit": "$commit"
}
EOF
echo "contracts/ synced from faclab-ec/faclab-api@$commit"
