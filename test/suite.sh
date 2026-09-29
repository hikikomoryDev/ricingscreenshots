#!/bin/bash
# Runs every scenario on one GNOME version (49 in a container, 50 locally)
# and prints each scenario's findings plus any error from the extension.
#   test/suite.sh 49|50
V=$1
T=$(dirname "$(readlink -f "$0")")
cd "$T"
SCEN="basic edit prefs keys"
for s in $SCEN; do
    if [ "$V" = 50 ]; then
        ./run.sh scenarios/$s.js > /dev/null 2>&1; log=out/$s/shell.log
    else
        ./podman.sh "$V" scenarios/$s.js > /dev/null 2>&1; log=out/$s-g$V/shell.log
    fi
    status=OK
    grep -q "RSTEST DONE" "$log" 2>/dev/null || status=NO-DONE
    grep -q "RSTEST FAIL" "$log" 2>/dev/null && status=FAIL
    errs=$(grep -E "JS ERROR|JS WARNING|CRITICAL" "$log" 2>/dev/null | grep -iE "ricingscreenshots|rstest" | head -3)
    [ -n "$errs" ] && status="$status+ERR"
    echo "=== $s: $status"
    grep -E "RSTEST" "$log" 2>/dev/null | grep -vE "shot |RSTEST DONE" | sed 's/.*RSTEST /    /' | cut -c1-160
    [ -n "$errs" ] && echo "$errs" | sed 's/^/    !! /' | cut -c1-220
done
