#!/bin/bash
# Installs RicingScreenshots for this user.
#
#   ./install.sh            regular install (new code needs a logout)
#   ./install.sh --dev      install through the dev loader: every later
#                           `./install.sh --dev` reloads the extension in
#                           place, no logout (the first switch to the loader
#                           still needs one)
set -eu
UUID=ricingscreenshots@hikikomoriDev
ROOT=$(dirname "$(readlink -f "$0")")
SRC=$ROOT/src
DEST=$HOME/.local/share/gnome-shell/extensions/$UUID

add_to() {  # add_to <key> <uuid>
    python3 - "$1" "$2" <<'PY'
import ast, subprocess, sys
key, uuid = sys.argv[1:]
cur = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', key], text=True).replace('@as ', ''))
if uuid not in cur:
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', key, str(cur + [uuid])])
PY
}
remove_from() {  # remove_from <key> <uuid>
    python3 - "$1" "$2" <<'PY'
import ast, subprocess, sys
key, uuid = sys.argv[1:]
cur = ast.literal_eval(subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', key], text=True).replace('@as ', ''))
if uuid in cur:
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', key, str([u for u in cur if u != uuid])])
PY
}

glib-compile-schemas --strict "$SRC/schemas"

if [ "${1:-}" = "--dev" ]; then
    # Shared files at the top, code in a fresh builds/<stamp>/ each time.
    STAMP=$(date +%Y%m%d-%H%M%S-%N)
    mkdir -p "$DEST/builds/$STAMP"
    find "$DEST" -maxdepth 1 -type f -delete
    rm -rf "$DEST/schemas" "$DEST/icons"
    # prefs.js runs in its own process from this folder, with its imports.
    cp "$SRC"/metadata.json "$SRC"/stylesheet.css "$SRC"/prefs.js "$SRC"/util.js "$DEST"/
    cp -r "$SRC"/schemas "$SRC"/icons "$DEST"/
    cp "$ROOT/dev/loader.js" "$DEST/extension.js"
    cp "$SRC"/*.js "$DEST/builds/$STAMP"/
    echo "$STAMP" > "$DEST/builds/current"
    # Keep the five newest builds.
    ls -1d "$DEST"/builds/*/ | sort | head -n -5 | xargs -r rm -rf
else
    rm -rf "$DEST"
    mkdir -p "$DEST"
    cp -r "$SRC"/. "$DEST"/
fi

add_to enabled-extensions "$UUID"
remove_from disabled-extensions "$UUID"
gsettings set org.gnome.shell disable-user-extensions false

if [ "${1:-}" = "--dev" ]; then
    # Reload only when this session already runs the loader: re-enabling an
    # older, regular build would load its cached code against the new schema.
    START=$(date -d "$(ps -o lstart= -C gnome-shell | head -1)" '+%Y-%m-%d %H:%M:%S')
    if journalctl --user --since "$START" --no-pager -q 2>/dev/null | grep -q "RicingScreenshots dev build"; then
        gnome-extensions disable "$UUID" && sleep 0.5 && gnome-extensions enable "$UUID"
        echo "Dev build $STAMP installed and reloaded."
    else
        echo "Dev build $STAMP installed. Log out once so the shell starts the dev loader;"
        echo "after that every ./install.sh --dev reloads the extension in place."
    fi
else
    echo "Installed to $DEST. Log out and back in to start RicingScreenshots."
fi
