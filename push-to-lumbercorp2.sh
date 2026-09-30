#!/usr/bin/env bash
# Push the current LumberCorp 2.0 build to github.com/lumber12345/lumbercorp2.0
#
# Requires the Arena GitHub connection (GH_TOKEN) to have PUSH access to that
# repo. If it doesn't yet: GitHub → Settings → Applications → Installed GitHub
# Apps → Arena → Configure → "Repository access" → add lumber12345/lumbercorp2.0.
# Then rerun this script (or just ask the agent to "push it").
#
# Usage: ./push-to-lumbercorp2.sh [branch]   (default branch: the repo default)
set -euo pipefail
cd "$(dirname "$0")"

OWNER_REPO="lumber12345/lumbercorp2.0"
REPO_URL="https://github.com/${OWNER_REPO}.git"
: "${GH_TOKEN:?GH_TOKEN not set}"

# ---- 1) access check BEFORE anything else (no blind push attempts) ----------
PERMS=$(curl -s -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/${OWNER_REPO}" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('permissions',{}).get('push'))")
if [ "$PERMS" != "True" ]; then
  echo "✗ NO PUSH ACCESS to ${OWNER_REPO}."
  echo "  The Arena GitHub connection is scoped to other repos. Add ${OWNER_REPO}"
  echo "  to the Arena app's repository access on GitHub, then rerun."
  exit 1
fi
echo "✓ push access confirmed"

# ---- 2) clone the target repo and detect its layout -------------------------
BRANCH="${1:-$(curl -s -H "Authorization: token $GH_TOKEN" \
  "https://api.github.com/repos/${OWNER_REPO}" | python3 -c "import json,sys; print(json.load(sys.stdin).get('default_branch','main'))")}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
git clone --depth 1 -b "$BRANCH" "$REPO_URL" "$WORK/repo" 2>/dev/null \
  || git clone --depth 1 "$REPO_URL" "$WORK/repo"
git -C "$WORK/repo" config user.name "arena-ai-coding-agent[bot]"
git -C "$WORK/repo" config user.email "arena-ai-coding-agent[bot]@users.noreply.github.com"

# ---- 3) overlay the build (same layout as the Render zip root) --------------
# App payload = zip-root layout: DEPLOY.md, render.yaml, proxy/, lumbercorp-2/.
# If the target repo keeps the app under a lumbercorp-2/ subdir instead, the
# lumbercorp-2/ folder lands there naturally (same relative path).
echo "--- syncing build files…"
cp -r DEPLOY.md render.yaml proxy lumbercorp-2 "$WORK/repo/"

VER=$(grep -o 'APP_VERSION = "[^"]*"' lumbercorp-2/index.html | cut -d'"' -f2)
echo "--- target repo status after sync:"
git -C "$WORK/repo" add -A
git -C "$WORK/repo" status --short | head -40
if git -C "$WORK/repo" diff --cached --quiet; then
  echo "✓ target already up to date (v${VER}) — nothing to push"
  exit 0
fi
git -C "$WORK/repo" commit -q -m "LumberCorp 2.0 v${VER} — sync from Arena build (PR #1 branch)"
git -C "$WORK/repo" push -q "https://x-access-token:${GH_TOKEN}@github.com/${OWNER_REPO}.git" "HEAD:refs/heads/${BRANCH}"
echo "✓ pushed v${VER} to ${OWNER_REPO}@${BRANCH}"
