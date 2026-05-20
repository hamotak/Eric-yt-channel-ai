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
echo "  Uses the full path from src/lib/ for @/lib/<path> matches."
echo "============================================================"
$FIND $SRC/lib -type f -name '*.ts' -print0 | while IFS= read -r -d '' f; do
  rel=${f#$SRC/lib/}
  rel_noext=${rel%.ts}
  base=$($BASENAME "$f" .ts)
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
echo "  Uses the full path from src/components/ — picks up ui/<x>."
echo "============================================================"
$FIND $SRC/components -type f -name '*.tsx' -print0 | while IFS= read -r -d '' f; do
  rel=${f#$SRC/components/}
  rel_noext=${rel%.tsx}
  base=$($BASENAME "$f" .tsx)
  pascal=$(echo "$base" | $SED -E 's/(^|-)([a-z])/\U\2/g')
  count=$($GREP -rlE "@/components/${rel_noext}\b|<${pascal}\b" $SRC 2>/dev/null \
    | $GREP -v node_modules \
    | $GREP -v "^${f}$" \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    echo "DEAD: $f"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 3 — API routes nothing in src/ fetches"
echo "  [id] segments collapsed to [^/]+ regex so template-literal calls"
echo "  like /api/channels/\${id}/tags actually match the route."
echo "============================================================"
$FIND $SRC/app/api -name route.ts -print0 | while IFS= read -r -d '' r; do
  dir=$($DIRNAME "$r")
  path_full=${dir#$SRC/app}
  # Replace each [id]-style segment with a non-greedy non-slash match.
  path_re=$(echo "$path_full" | $SED -E 's|/\[[^]]+\]|/[^/]+|g')
  count=$($GREP -rlE -- "${path_re}([^a-zA-Z0-9_/-]|$)" $SRC 2>/dev/null \
    | $GREP -v node_modules \
    | $GREP -v "^${r}$" \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    echo "DEAD: $r  (regex=${path_re})"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 4 — DB tables with no SELECT/INSERT/UPDATE/JOIN"
echo "  Excludes DDL (CREATE/DROP/ALTER) — those exist for every table."
echo "============================================================"
$SQLITE "$DB" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts_%' ORDER BY name;" | while read -r t; do
  if [ -z "$t" ]; then continue; fi
  count=$($GREP -rlE "(FROM|INTO|UPDATE|JOIN)[[:space:]]+${t}\b" $SRC 2>/dev/null \
    | $GREP -v node_modules \
    | $WC -l | $TR -d ' ')
  if [ "$count" = "0" ]; then
    rowcount=$($SQLITE "$DB" "SELECT COUNT(*) FROM $t;" 2>/dev/null)
    echo "DEAD TABLE: $t (rows: $rowcount)"
  fi
done

echo ""
echo "============================================================"
echo "AUDIT 5 — npm dependencies not imported from src/ or configs"
echo "  Filter the candidates against your known build-system deps."
echo "============================================================"
/usr/bin/python3 -c "
import json, re, subprocess
pkg = json.load(open('package.json'))
deps = list(pkg.get('dependencies', {}).keys()) + list(pkg.get('devDependencies', {}).keys())
DEAD = []
for d in sorted(deps):
    patterns = [
        f'from [\\'\"]{re.escape(d)}[\\'\"]/?',
        f'from [\\'\"]{re.escape(d)}/',
        f'require\\([\\'\"]{re.escape(d)}/?[\\'\"]\\)',
    ]
    found = False
    for p in patterns:
        try:
            r = subprocess.run(['/usr/bin/grep', '-rlE', p, 'src', 'next.config.ts',
                                'eslint.config.mjs', 'tsconfig.json'],
                               capture_output=True, text=True, errors='ignore')
            if r.stdout.strip():
                found = True; break
        except Exception:
            pass
    if not found:
        DEAD.append(d)
for d in DEAD: print(f'CANDIDATE-DEAD-DEP: {d}')
print(f'(Total deps: {len(deps)}; candidates: {len(DEAD)})')
"

echo ""
echo "============================================================"
echo "AUDIT 6 — long-running timers (setInterval)"
echo "============================================================"
$GREP -rn "setInterval" $SRC 2>/dev/null
