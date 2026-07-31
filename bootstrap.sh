#!/usr/bin/env bash
set -euo pipefail

ORG="${ROSETTA_GITHUB_ORG:-Rosetta-Foundation}"
REPO="rosetta_dev-scripts"
DEST="${1:-$HOME/projects/rosetta}"

# ── Colours ────────────────────────────────────────────────────────────────────
red()  { printf '\033[0;31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[0;32m%s\033[0m\n' "$*"; }
blu()  { printf '\033[0;34m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

bold ""
bold "🧭  Rosetta Bootstrap"
bold "────────────────────────────────────────────"

# ── Prerequisites ──────────────────────────────────────────────────────────────
if ! command -v gh &>/dev/null; then
  red "✗ GitHub CLI (gh) is required but not found."
  echo "  Install: brew install gh   then: gh auth login"
  exit 1
fi
grn "✓ gh found: $(gh --version | head -1)"

if ! gh auth status &>/dev/null; then
  red "✗ GitHub CLI is not authenticated."
  echo "  Run: gh auth login"
  exit 1
fi
grn "✓ gh authenticated"

if ! command -v node &>/dev/null; then
  red "✗ Node.js is required but not found."
  echo "  Install via nvm: nvm install 20"
  exit 1
fi
grn "✓ node found: $(node --version)"

if ! command -v yarn &>/dev/null; then
  red "✗ Yarn is required but not found."
  echo "  Install: npm install -g yarn"
  exit 1
fi
grn "✓ yarn found: $(yarn --version)"

# ── Clone or update dev-scripts ────────────────────────────────────────────────
SCRIPTS_DIR="$DEST/$REPO"

echo ""
bold "Setting up $DEST..."

mkdir -p "$DEST"

if [ -d "$SCRIPTS_DIR/.git" ]; then
  blu "↻ $REPO already cloned — pulling latest..."
  git -C "$SCRIPTS_DIR" pull --ff-only
else
  blu "↓ Cloning $ORG/$REPO..."
  gh repo clone "$ORG/$REPO" "$SCRIPTS_DIR"
fi

# ── Install team-setup dependencies ───────────────────────────────────────────
echo ""
bold "Installing dependencies..."
yarn --cwd "$SCRIPTS_DIR" install --frozen-lockfile --silent

# ── Run setup ─────────────────────────────────────────────────────────────────
echo ""
bold "Running workspace setup..."
yarn --cwd "$SCRIPTS_DIR" workspace team-setup dev -- setup --base-dir "$DEST" --skip-clone

echo ""
bold "────────────────────────────────────────────"
grn "✓ Bootstrap complete!"
echo ""
echo "  Add the goto alias to your shell:"
echo ""
yarn --cwd "$SCRIPTS_DIR" workspace team-setup dev -- shell-alias 2>/dev/null | grep 'alias goto'
echo ""
echo "  Then: source ~/.zshrc"
echo "  Then: gotor  — to navigate your Rosetta repos"
echo ""
