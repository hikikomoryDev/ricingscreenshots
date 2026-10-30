#!/bin/bash
# Installs the latest RicingScreenshots release for this user:
#
#   curl -fsSL https://raw.githubusercontent.com/hikikomoryDev/ricingscreenshots/main/get.sh | bash
#
# GNOME on Wayland loads a new extension only at login, so it is switched on
# in the settings here and starts after the next login.
set -eu
UUID=ricingscreenshots@hikikomoriDev
URL=https://github.com/hikikomoryDev/ricingscreenshots/releases/latest/download/$UUID.shell-extension.zip
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
echo "Downloading $URL"
curl -fsSL -o "$TMP/$UUID.shell-extension.zip" "$URL"
gnome-extensions install --force "$TMP/$UUID.shell-extension.zip"
python3 - "$UUID" <<'PY'
import ast, subprocess, sys

def get(key):
    out = subprocess.check_output(['gsettings', 'get', 'org.gnome.shell', key], text=True)
    return ast.literal_eval(out.replace('@as ', ''))

def put(key, value):
    subprocess.check_call(['gsettings', 'set', 'org.gnome.shell', key, str(value)])

uuid = sys.argv[1]
on = [u for u in get('enabled-extensions') if u != uuid] + [uuid]
off = [u for u in get('disabled-extensions') if u != uuid]
put('enabled-extensions', on)
put('disabled-extensions', off)
PY
echo "RicingScreenshots is installed. Log out and back in to start it."
