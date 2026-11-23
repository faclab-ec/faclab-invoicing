#!/usr/bin/env bash
# Prepares and tags a release of this repository (S8.2). The same script lives in faclab-core,
# faclab-invoicing, faclab-web and faclab-infra (README, "Versiones y publicación").
#
#   scripts/release.sh <X.Y.Z|major|minor|patch>
#       On master, up to date with origin: creates the branch release/vX.Y.Z with one commit,
#       `chore(release): vX.Y.Z`, that adds the version's section to CHANGELOG.md (master's commits
#       since the last version, grouped by their conventional type) and, in the Node repositories,
#       sets package.json and package-lock.json to X.Y.Z. Push it and open the PR with that title.
#   scripts/release.sh tag <X.Y.Z>
#       Once that PR is merged: the annotated tag vX.Y.Z on its commit of origin/master. Pushing it
#       (git push origin vX.Y.Z) runs .github/workflows/release.yml, which publishes the image.
#
# Pre-releases for staging (vX.Y.Z-rc.N) need neither: tag any pushed commit and push the tag.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
CHANGELOG=CHANGELOG.md
SEMVER='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'

die() {
  echo "release.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,14p' "${BASH_SOURCE[0]}" >&2
  exit 1
}

# The last final version on origin/master (pre-releases don't count), or nothing
last_version() {
  git tag --list 'v*' --merged origin/master --sort=-v:refname |
    sed -n 's/^v//p' | grep -E "$SEMVER" | head -n 1 || true
}

bump() {
  local major minor patch
  IFS=. read -r major minor patch <<< "${1:-0.0.0}"
  case "$2" in
    major) echo "$((major + 1)).0.0" ;;
    minor) echo "$major.$((minor + 1)).0" ;;
    patch) echo "$major.$minor.$((patch + 1))" ;;
  esac
}

# version_gt X Y: X comes after Y
version_gt() {
  [ "$1" != "$2" ] &&
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)" = "$1" ]
}

# For grep: the dots of a version are literal
escape() {
  printf '%s' "${1//./\\.}"
}

# The section of version $1: master's commits since version $2 (none: the first version)
section() {
  local version="$1" since="$2"
  printf '## [%s] - %s\n\n' "$version" "$(date +%Y-%m-%d)"
  if [ -z "$since" ]; then
    printf 'Primera versión etiquetada.\n'
    return
  fi
  # One record per commit (\036), its fields split by \037: short hash, subject and body
  git log --first-parent --format='%h%x1f%s%x1f%b%x1e' "v$since..origin/master" | awk '
    BEGIN { RS = "\036"; FS = "\037" }
    {
      hash = $1
      sub(/^[\n ]+/, "", hash)
      subject = $2
      if (hash == "" || subject ~ /^chore\(release\)/) next
      type = ""; scope = ""; text = subject; breaking = 0
      if (match(subject, /^[a-z]+(\([^)]*\))?!?: /)) {
        head = substr(subject, 1, RLENGTH - 2)
        text = substr(subject, RLENGTH + 1)
        if (head ~ /!$/) { breaking = 1; sub(/!$/, "", head) }
        if (match(head, /\(.*\)/)) {
          scope = substr(head, RSTART + 1, RLENGTH - 2)
          head = substr(head, 1, RSTART - 1)
        }
        type = head
      }
      if ($3 ~ /BREAKING[ -]CHANGE:/) breaking = 1
      # Squashed PRs already end with their number: the hash only for the rest
      ref = (subject ~ /\(#[0-9]+\)$/) ? "" : " (" hash ")"
      line = "- " (scope != "" ? "**" scope ":** " : "") text ref "\n"
      if (breaking) out["breaking"] = out["breaking"] line
      else if (type == "feat") out["feat"] = out["feat"] line
      else if (type == "fix") out["fix"] = out["fix"] line
      else if (type == "perf") out["perf"] = out["perf"] line
      else out["other"] = out["other"] "- " subject ref "\n"
    }
    END {
      split("breaking feat fix perf other", keys, " ")
      titles["breaking"] = "Cambios incompatibles"; titles["feat"] = "Nuevo"
      titles["fix"] = "Correcciones"; titles["perf"] = "Rendimiento"; titles["other"] = "Otros cambios"
      first = 1
      for (i = 1; i <= 5; i++) {
        if (out[keys[i]] == "") continue
        printf "%s### %s\n\n%s", (first ? "" : "\n"), titles[keys[i]], out[keys[i]]
        first = 0
      }
    }'
}

# Adds version $1's section on top of the others
write_changelog() {
  local version="$1" since="$2" tmp
  [ -f "$CHANGELOG" ] || die "$CHANGELOG doesn't exist"
  if grep -q "^## \[$(escape "$version")\]" "$CHANGELOG"; then
    die "$CHANGELOG already has $version"
  fi
  tmp="$(mktemp -d)"
  section "$version" "$since" > "$tmp/section"
  awk -v section="$tmp/section" '
    !done && /^## \[/ {
      while ((getline line < section) > 0) print line
      print ""
      done = 1
    }
    { print }
    END {
      if (!done) {
        print ""
        while ((getline line < section) > 0) print line
      }
    }' "$CHANGELOG" > "$tmp/changelog"
  mv "$tmp/changelog" "$CHANGELOG"
  rm -rf "$tmp"
}

prepare() {
  local wanted="$1" last version
  [ -z "$(git status --porcelain)" ] || die "the working tree has changes"
  [ "$(git rev-parse --abbrev-ref HEAD)" = master ] || die "run it on master"
  git fetch --quiet --tags origin
  [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/master)" ] ||
    die "master isn't origin/master: git pull first"

  last="$(last_version)"
  case "$wanted" in
    major | minor | patch) version="$(bump "$last" "$wanted")" ;;
    *)
      [[ "$wanted" =~ $SEMVER ]] || die "$wanted isn't X.Y.Z, major, minor nor patch"
      version="$wanted"
      ;;
  esac
  if [ -n "$last" ]; then
    version_gt "$version" "$last" || die "$version doesn't come after the last version, $last"
    [ -n "$(git log --first-parent --format=%h "v$last..origin/master")" ] ||
      die "nothing was merged since v$last"
  fi
  ! git rev-parse -q --verify "refs/tags/v$version" > /dev/null || die "v$version already exists"

  git switch --quiet -c "release/v$version"
  write_changelog "$version" "$last"
  git add "$CHANGELOG"
  if [ -f package.json ]; then
    npm version "$version" --no-git-tag-version --allow-same-version > /dev/null
    git add package.json package-lock.json
  fi
  git commit --quiet -m "chore(release): v$version"

  echo "Branch release/v$version ready${last:+ (after v$last)}. Review $CHANGELOG, then:"
  echo "  git push -u origin release/v$version"
  echo "  open the PR titled 'chore(release): v$version' and merge it"
  echo "  scripts/release.sh tag $version"
}

# The merge of version $1's release PR on origin/master: squashed, its subject is the PR title plus
# " (#N)". A function and not inline: bash 3.2 (macOS) can't parse a case inside $(...)
release_commit() {
  local sha subject
  while IFS=$'\t' read -r sha subject; do
    case "$subject" in
      "chore(release): v$1" | "chore(release): v$1 "*)
        echo "$sha"
        return
        ;;
    esac
  done < <(git log --first-parent --format='%H%x09%s' origin/master)
}

tag_release() {
  local version="$1" commit
  [[ "$version" =~ $SEMVER ]] || die "$version isn't X.Y.Z"
  git fetch --quiet --tags origin
  ! git rev-parse -q --verify "refs/tags/v$version" > /dev/null || die "v$version already exists"

  commit="$(release_commit "$version")"
  [ -n "$commit" ] || die "origin/master has no 'chore(release): v$version' commit: merge its PR first"
  git show "$commit:$CHANGELOG" | grep -q "^## \[$(escape "$version")\]" ||
    die "$CHANGELOG at ${commit:0:7} has no $version section"
  if git cat-file -e "$commit:package.json" 2> /dev/null &&
    ! git show "$commit:package.json" | grep -q "\"version\": \"$(escape "$version")\""; then
    die "package.json at ${commit:0:7} isn't $version"
  fi

  git tag -a "v$version" "$commit" -m "v$version"
  echo "Tag v$version on ${commit:0:7}. Publish it with:"
  echo "  git push origin v$version"
}

main() {
  case "${1:-}" in
    tag) tag_release "${2:-}" ;;
    "" | -h | --help) usage ;;
    *) prepare "$1" ;;
  esac
}

main "$@"
