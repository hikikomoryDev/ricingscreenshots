// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CaptureSession} from './capture.js';

// GNOME's own "take a screenshot" key (Print by default).
const GNOME_KEY = 'show-screenshot-ui';
const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW;

export default class RicingScreenshots extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._gnomeKeys = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
        Main.wm.addKeybinding('shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, MODES, () => this.capture());
        this._printTaken = false;
        this._settings.connectObject('changed::take-print', () => this._syncPrint(), this);
        this._syncPrint();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._givePrintBack();
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

    // One session at a time: the shortcut does nothing while one is open.
    capture() {
        if (this._session)
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
