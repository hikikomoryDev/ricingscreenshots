#!/bin/bash
# Headless GNOME Shell with its own dconf and data dirs, so the real session is
# never touched. Usage: test/run.sh scenarios/<name>.js [WxH] [extra gsettings file]
set -u
T=$(dirname "$(readlink -f "$0")")
SCEN=$(readlink -f "$T/$1")
SIZE=${2:-1920x1080}
NAME=$(basename "$1" .js)
OUT=$T/out/$NAME
ROOT=${RSTEST_ROOT:-$HOME/.cache/ricingscreenshots-test}
rm -rf "$ROOT" "$OUT"
glib-compile-schemas "$T/../src/schemas"
mkdir -p "$ROOT"/{data,config,cache}/ "$ROOT/data/gnome-shell/extensions" "$OUT"
if [ -n "${ZIP:-}" ]; then
    # As extensions.gnome.org installs it: unpack the release zip and compile
    # its schema (the shell's downloader does that step).
    D=$ROOT/data/gnome-shell/extensions/ricingscreenshots@hikikomoriDev
    mkdir -p "$D"
    python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$ZIP" "$D"
    glib-compile-schemas --strict "$D/schemas"
elif [ -n "${DEV:-}" ]; then
    # Same layout as install.sh --dev: loader on top, code in builds/<stamp>/.
    D=$ROOT/data/gnome-shell/extensions/ricingscreenshots@hikikomoriDev
    mkdir -p "$D/builds/first"
    cp "$T/../src"/metadata.json "$T/../src"/stylesheet.css "$T/../src"/prefs.js "$T/../src"/util.js "$D"/
    cp -r "$T/../src"/schemas "$T/../src"/icons "$D"/
    cp "$T/../dev/loader.js" "$D/extension.js"
    cp "$T/../src"/*.js "$D/builds/first"/
    echo first > "$D/builds/current"
else
    ln -s "$T/../src" "$ROOT/data/gnome-shell/extensions/ricingscreenshots@hikikomoriDev"
fi
ln -s "$T/rstest@local" "$ROOT/data/gnome-shell/extensions/rstest@local"


export XDG_DATA_HOME=$ROOT/data XDG_CONFIG_HOME=$ROOT/config XDG_CACHE_HOME=$ROOT/cache
export RSTEST_SCENARIO=$SCEN RSTEST_OUT=$OUT RSTEST_EXTRA=${3:-} RSTEST_WALL=${RSTEST_WALL:-}
export RSTEST_FAVS=${RSTEST_FAVS:-'["org.gnome.Characters.desktop", "org.gnome.clocks.desktop", "org.gnome.Ptyxis.desktop", "org.gnome.Loupe.desktop", "org.gnome.TextEditor.desktop", "org.gnome.Nautilus.desktop", "org.gnome.Papers.desktop", "org.gnome.Calculator.desktop", "org.gnome.Logs.desktop", "org.gnome.DiskUtility.desktop"]'}
export GSETTINGS_SCHEMA_DIR_EXTRA=$T/../src/schemas
unset DISPLAY WAYLAND_DISPLAY

# D-Bus-activated apps (the prefs window) find the test display through the
# bus's environment; the shell itself must not see it.
export WAYLAND_DISPLAY=${RSTEST_DISPLAY:-wayland-rstest}
timeout 120 dbus-run-session -- bash -c '
  gsettings set org.gnome.shell enabled-extensions "[\"ricingscreenshots@hikikomoriDev\", \"rstest@local\"]"
  gsettings set org.gnome.shell disable-user-extensions false
  gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
  gsettings set org.gnome.shell favorite-apps "$RSTEST_FAVS"
  gsettings set org.gnome.desktop.interface icon-theme "Yaru-prussiangreen-dark"
  gsettings set org.gnome.desktop.interface color-scheme "prefer-dark"
  gsettings set org.gnome.desktop.interface gtk-theme "Yaru-prussiangreen-dark"
  gsettings set org.gnome.desktop.interface enable-animations true
  # Test shells share the real sound server: keep them silent.
  gsettings set org.gnome.desktop.sound event-sounds false
  gsettings set org.gnome.desktop.sound input-feedback-sounds false
  gsettings --schemadir "$GSETTINGS_SCHEMA_DIR_EXTRA" set org.gnome.shell.extensions.ricingscreenshots play-sound false
  WALL=${RSTEST_WALL:-$HOME/.config/background}
  if [ -f "$WALL" ]; then
    gsettings set org.gnome.desktop.background picture-uri "file://$WALL"
    gsettings set org.gnome.desktop.background picture-uri-dark "file://$WALL"
  fi
  if [ -n "$RSTEST_EXTRA" ]; then while read -r k v; do [ -n "$k" ] && gsettings --schemadir "$GSETTINGS_SCHEMA_DIR_EXTRA" set org.gnome.shell.extensions.ricingscreenshots "$k" "$v"; done < "$RSTEST_EXTRA"; fi
  unset WAYLAND_DISPLAY
  exec gnome-shell --headless --force-animations --wayland --no-x11 --virtual-monitor '"$SIZE"' --wayland-display='"${RSTEST_DISPLAY:-wayland-rstest}"'
' > "$OUT/shell.log" 2>&1
echo "exit $?"
grep -E "RSTEST|JS ERROR|JS WARNING|ricingdock|Error|error" "$OUT/shell.log" | grep -vE "libinput|ibus|Gvc|gsd-|polkit|NetworkManager|Bluetooth|bluez|upower|geoclue|UPower|malcontent|flatpak|xdg-desktop|rfkill|Could not open device|goa|evolution|gnome-session|Unable to|systemd|PolicyKit|location" | head -60
ls "$OUT"
