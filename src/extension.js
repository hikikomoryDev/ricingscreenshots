// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CaptureSession} from './capture.js';
import {Recorder} from './recorder.js';

// GNOME's own "take a screenshot" key (Print by default).
const GNOME_KEY = 'show-screenshot-ui';
// GNOME opens the notification list with Super+V and Super+M.
const TRAY_KEY = 'toggle-message-tray';
const TRAY_MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

// '<Super>v', '<Mod4>V' and '<super>v' are the same key.
function normalize(accel) {
    const alias = {primary: 'control', ctrl: 'control', mod4: 'super', mod1: 'alt'};
    const mods = [...accel.matchAll(/<([^>]+)>/g)].map(m => alias[m[1].toLowerCase()] ?? m[1].toLowerCase());
    const key = accel.replace(/<[^>]+>/g, '').toLowerCase();
    return `${[...new Set(mods)].sort().join('+')}+${key}`;
}

export default class RicingScreenshots extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._gnomeKeys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        Main.wm.addKeybinding('shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, () => this.capture());
        this._printTaken = false;
        this._settings.connectObject('changed::take-print', () => this._syncPrint(), this);
        this._syncPrint();

        this._recorder = new Recorder(this._settings, this.path);
        this._trayBorrowed = false;
        this._syncTray();
        Main.wm.addKeybinding('record-shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, () => this.record());
        this._settings.connectObject('changed::record-shortcut', () => this._syncTray(), this);
        this._gnomeKeys.connectObject(`changed::${TRAY_KEY}`, () => this._syncTray(), this);
    }

    disable() {
        this._settings.disconnectObject(this);
        this._gnomeKeys.disconnectObject(this);
        this._givePrintBack();
        Main.wm.removeKeybinding('record-shortcut');
        this._giveTrayBack();
        this._recorder.destroy();
        this._recorder = null;
        Main.wm.removeKeybinding('shortcut');
        this._session?.destroy();
        this._session = null;
        this._gnomeKeys = null;
        this._settings = null;
    }

    // The Print key is borrowed at run time, never rewritten in GNOME's
    // settings: whatever key GNOME uses for screenshots opens this instead,
    // and GNOME gets it back whenever the extension is off.
    _syncPrint() {
        const take = this._settings.get_boolean('take-print');
        if (take === this._printTaken)
            return;
        if (!take) {
            this._givePrintBack();
            return;
        }
        Main.wm.removeKeybinding(GNOME_KEY);
        Main.wm.addKeybinding(GNOME_KEY, this._gnomeKeys,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, () => this.capture());
        this._printTaken = true;
    }

    _givePrintBack() {
        if (!this._printTaken)
            return;
        Main.wm.removeKeybinding(GNOME_KEY);
        // As GNOME Shell registers it in ui/screenshot.js.
        Main.wm.addKeybinding(GNOME_KEY, this._gnomeKeys,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.ALL & ~Shell.ActionMode.LOGIN_SCREEN,
            () => Main.screenshotUI.open().catch(e => logError(e, 'Error opening the screenshot UI')));
        this._printTaken = false;
    }

    // GNOME's notification list keeps its other keys (Super+M); only the
    // ones the recording shortcut uses are held back, through a copy of
    // the list in this extension's settings. GNOME's settings stay as they are.
    _syncTray() {
        const ours = new Set(this._settings.get_strv('record-shortcut').map(normalize));
        const gnome = this._gnomeKeys.get_strv(TRAY_KEY);
        const rest = gnome.filter(a => !ours.has(normalize(a)));
        if (rest.length === gnome.length) {
            this._giveTrayBack();
            return;
        }
        this._settings.set_strv(TRAY_KEY, rest);
        if (this._trayBorrowed)
            return;
        Main.wm.removeKeybinding(TRAY_KEY);
        Main.wm.addKeybinding(TRAY_KEY, this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, TRAY_MODES, () => Main.panel.toggleCalendar());
        this._trayBorrowed = true;
    }

    _giveTrayBack() {
        if (!this._trayBorrowed)
            return;
        Main.wm.removeKeybinding(TRAY_KEY);
        // As GNOME Shell registers it in ui/windowManager.js.
        Main.wm.addKeybinding(TRAY_KEY, this._gnomeKeys,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, TRAY_MODES, () => Main.panel.toggleCalendar());
        this._trayBorrowed = false;
    }

    // Super+V: pick an area and record it with the system sound; pressed
    // again, stop.
    record() {
        if (this._recorder.recording) {
            this._recorder.stop().catch(e => logError(e, 'RicingScreenshots: stop failed'));
            return;
        }
        if (this._session || this._recorder.busy)
            return;
        this._session = new CaptureSession(this._settings, this.path, () => {
            this._session = null;
        }, {onArea: rect => this._recorder.start(rect).catch(e => logError(e, 'RicingScreenshots: recording failed'))});
        this._session.open().catch(e => {
            logError(e, 'RicingScreenshots: picking an area failed');
            this._session?.destroy();
        });
    }

    // One session at a time: the shortcut does nothing while one is open.
    capture() {
        if (this._session || this._recorder?.busy)
            return;
        this._session = new CaptureSession(this._settings, this.path, () => {
            this._session = null;
        });
        this._session.open().catch(e => {
            logError(e, 'RicingScreenshots: capture failed');
            this._session?.destroy();
        });
    }
}
