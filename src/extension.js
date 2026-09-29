// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {CaptureSession} from './capture.js';

export default class RicingScreenshots extends Extension {
    enable() {
        this._settings = this.getSettings();
        Main.wm.addKeybinding('shortcut', this._settings,
            Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            () => this.capture());
    }

    disable() {
        Main.wm.removeKeybinding('shortcut');
        this._session?.destroy();
        this._session = null;
        this._settings = null;
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
