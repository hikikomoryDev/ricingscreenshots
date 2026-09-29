#!/bin/bash
# Runs a scenario on GNOME Shell 49 in a container (the image is built from
# RicingDock's test/containers/gnome49.Containerfile):
#   test/podman.sh 49 scenarios/<name>.js [WxH] [conf]
# Output lands in test/out/<name>-g<version>/ like a local run.
set -u
V=$1; shift
T=$(dirname "$(readlink -f "$0")")
REPO=$(dirname "$T")
NAME=$(basename "$1" .js)
podman run --rm --userns=keep-id --security-opt label=disable \
    -v "$REPO:$REPO" \
    -e RSTEST_ROOT=/tmp/rsenv -e REPO="$REPO" \
    -e HOME=/tmp/home -e XDG_RUNTIME_DIR=/tmp/xdg -e ZIP="${ZIP:-}" \
    "ricingdock-gnome$V" bash -c '
        mkdir -p -m 700 /tmp/xdg /tmp/home
        # The shell always opens the system bus; give it an empty one.
        dbus-daemon --session --address=unix:path=/tmp/sysbus --fork --nopidfile
        export DBUS_SYSTEM_BUS_ADDRESS=unix:path=/tmp/sysbus
        exec "$REPO/test/run.sh" "$@"' _ "$@"
# Keep results per version side by side.
rm -rf "$T/out/$NAME-g$V"; mv "$T/out/$NAME" "$T/out/$NAME-g$V" 2>/dev/null
