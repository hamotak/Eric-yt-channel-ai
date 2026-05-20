#!/bin/bash
# PRIO-11 dead-code audit — discovery only. Surface candidates for HAmo
# review; do NOT delete anything from this script.

set -u
cd "$(dirname "$0")/.."

SRC=src
GREP=/usr/bin/grep
FIND=/usr/bin/find
WC=/usr/bin/wc
TR=/usr/bin/tr
SED=/usr/bin/sed
BASENAME=/usr/bin/basename
DIRNAME=/usr/bin/dirname
SQLITE=/usr/bin/sqlite3
DB=data/app.db

echo "============================================================"
echo "AUDIT 1 — lib files with zero imports"
echo "  Matches: @/lib/<path>, ./<file>, ../lib/<file>, ./lib/<file>"
echo "============================================================"
$FIND $SRC/lib -type f -name '*.ts' -print0 | while IFS= read -r -d '' f; do
  rel=${f#$SRC/lib/}
  rel_noext=${rel%.ts}
  base=$($BASENAME "$f" .ts)
  # Search for full path (e.g. ideate/pipeline) or bare filename for sibling-relative
  count=$($GREP -rlE "from ['\"]@/lib/${rel_noext}['\"]|from ['\"]\\./${base}['\"]|from ['\"]\\.\\./lib/${rel_noext}['\"]|from ['\"]\\./lib/${rel_noext}['\"]|require\\(['\"]@/lib/${rel_noext}['\"]\\)" $SRC scripts 2>/dev/null \
    | $GREP -v node_modules \
    | $GREP -v "^$f$" \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    echo "DEAD: $f"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 2 — components with zero references"
echo "  Matches: @/components/<file>, ./components/<file>, or <PascalName tag"
echo "============================================================"
$FIND $SRC/components -type f -name '*.tsx' -print0 | while IFS= read -r -d '' f; do
  base=$($BASENAME "$f" .tsx)
  # Convert kebab to PascalCase guess for tag usage. e.g. transcribe-all-banner → TranscribeAllBanner
  pascal=$(echo "$base" | $SED -E 's/(^|-)([a-z])/\U\2/g')
  count=$($GREP -rlE "@/components/${base}\b|\\./${base}\b|@/components/${base#ui/}\b|<${pascal}\b" $SRC 2>/dev/null \
    | $GREP -v node_modules \
    | $GREP -v "^$f$" \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    echo "DEAD: $f"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 3 — API routes nothing in src/ fetches"
echo "  Heuristic: search for the literal /api/<path> string in src/"
echo "============================================================"
$FIND $SRC/app/api -name route.ts -print0 | while IFS= read -r -d '' r; do
  dir=$($DIRNAME "$r")
  # Strip src/app prefix to get the URL path. [id] segments collapsed to *.
  path_full=${dir#$SRC/app}
  path_relaxed=$(echo "$path_full" | $SED -E 's|/\[[^]]+\]||g')
  # Count occurrences of either the literal full path or the relaxed (dynamic-segment-stripped) one.
  needle1="\"${path_full}"
  needle2="\"${path_relaxed}/"
  count=$($GREP -rl -E "${needle1}|${needle2}" $SRC 2>/dev/null \
    | $GREP -v node_modules \
    | $GREP -v "^$r$" \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    echo "DEAD: $r  (no fetch in src/ matches $path_full or ${path_relaxed}/...)"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 4 — DB tables nothing reads/writes"
echo "============================================================"
$SQLITE "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name;" | while read -r t; do
  if [ -z "$t" ]; then continue; fi
  count=$($GREP -rlE "(FROM|INTO|UPDATE|TABLE)[[:space:]]+${t}\b" $SRC 2>/dev/null \
    | $GREP -v node_modules \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    echo "DEAD TABLE: $t"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 5 — unused npm dependencies (depcheck)"
echo "============================================================"
PATH=$PATH:/usr/local/bin:/opt/homebrew/bin npx --no-install depcheck 2>&1 | head -60

echo ""
echo "============================================================"
echo "AUDIT 6 — long-running timers (setInterval)"
echo "============================================================"
$GREP -rn "setInterval" $SRC 2>/dev/null
