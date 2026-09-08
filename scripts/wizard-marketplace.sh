#!/usr/bin/env bash
set -euo pipefail
if [[ -t 1 ]] && command -v tput >/dev/null 2>&1 && [[ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]]; then BOLD=$(tput bold); DIM=$(tput dim); RESET=$(tput sgr0); BLUE=$(tput setaf 4); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3); RED=$(tput setaf 1); else BOLD=""; DIM=""; RESET=""; BLUE=""; GREEN=""; YELLOW=""; RED=""; fi
TOTAL_STAGES=5
_STAGE_INDEX=0
_clear(){ [[ -t 1 ]] || return 0; if command -v tput >/dev/null 2>&1; then tput clear; else printf '\033[2J\033[3J\033[H'; fi; }
banner(){ _clear; printf '\n%s%s  %s%s\n' "$BOLD" "$BLUE" "$1" "$RESET"; printf '%s  %s stages%s\n\n' "$DIM" "$TOTAL_STAGES" "$RESET"; printf '%s  You drive the browser; wizard guides clicks.\n  Ctrl-C to stop, re-run later.%s\n' "$DIM" "$RESET"; read -p "  Ready? Enter " _; }
stage(){ _clear; _STAGE_INDEX=$((_STAGE_INDEX+1)); printf '\n%s%s- Stage %s/%s - %s%s\n' "$BOLD" "$BLUE" "$_STAGE_INDEX" "$TOTAL_STAGES" "$1" "$RESET"; }
say(){ printf '  %s\n' "$1"; }
step(){ printf '  %s- %s %s\n' "$BLUE" "$RESET" "$1"; }
open_url(){ local url="$1"; printf '  %s opening %s\n' "$GREEN" "$RESET" "$url"; { if command -v wslview >/dev/null 2>&1; then wslview "$url"; elif command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$url"; elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$url"; elif command -v open >/dev/null 2>&1; then open "$url"; else echo "visit manually: $url"; fi; } >/dev/null 2>&1 || echo "visit manually: $url"; }
pause(){ printf '  %s%s%s ' "$DIM" "${1:-Press Enter}" "$RESET"; read -r _ || true; }

banner "Blognice -> Public Marketplaces"
stage "Fork openai/skills"
say "Codex curated at github.com/openai/skills/tree/main/skills/.curated"
open_url "https://github.com/openai/skills"
step "Click Fork -> Create fork (keep main)"
pause "Enter when fork ready"

stage "Add blognice to your fork"
say "Copy repo skill into fork curated folder"
open_url "https://github.com/pragmaticonline/blognice/tree/main/skills/blognice"
step "Run: gh repo clone YOU/skills /tmp/skills-fork && cp -r /opt/blognice/skills/blognice /tmp/skills-fork/skills/.curated/ && cd /tmp/skills-fork && git add skills/.curated/blognice && git commit -m 'add blognice skill' && git push"
pause "Enter when pushed"

stage "Open PR to openai/skills"
open_url "https://github.com/openai/skills/compare"
step "Compare across forks: base openai/skills main <- head YOU/skills main"
step "Create PR: Title 'Add blognice skill — Blognice API' Body: 'Portable skill for https://blognice.com — token API for 5 blogs, posts/pages/media, navigation+header_link_url. Docs docs/API.md + openapi.yaml user-only. Source pragmaticonline/blognice.'"
pause "Enter when PR opened"

stage "Claude Code"
say "Claude marketplace: add via GitHub path — teammates run: Muse plugin marketplace add pragmaticonline/blognice"
open_url "https://github.com/pragmaticonline/blognice/tree/main/skills/blognice"
pause "Enter"

stage "Verify"
say "Local marketplace already live: .agents/plugins/marketplace.json + plugins/blognice"
say "View: codex://plugins/blognice?marketplacePath=%2Fopt%2Fblognice%2F.agents%2Fplugins%2Fmarketplace.json"
pause "Done"
_clear
printf '\n%s%s  Done%s\n' "$BOLD" "$GREEN" "$RESET"
