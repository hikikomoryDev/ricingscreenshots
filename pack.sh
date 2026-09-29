#!/bin/bash
# Builds the zip for extensions.gnome.org into dist/.
set -eu
ROOT=$(dirname "$(readlink -f "$0")")
mkdir -p "$ROOT/dist"
cd "$ROOT/src"
gnome-extensions pack --force --out-dir="$ROOT/dist" \
    --extra-source=capture.js --extra-source=editor.js --extra-source=place.js --extra-source=recorder.js \
    --extra-source=util.js --extra-source=icons --extra-source=LICENSE \
    --schema=schemas/org.gnome.shell.extensions.ricingscreenshots.gschema.xml
ls -l "$ROOT/dist"
