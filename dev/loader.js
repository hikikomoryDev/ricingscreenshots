// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

// Development loader, installed as extension.js by `install.sh --dev`.
//
// GNOME Shell imports an extension's modules once per session, so new code
// normally needs a logout. This loader imports the build named in
// builds/current on every enable, from a fresh directory each time, so
// `gnome-extensions disable` + `enable` runs new code at once.
// Never shipped: the published zip contains the real extension.js.
import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class RicingScreenshotsDevLoader extends Extension {
    async enable() {
        const generation = this._generation = (this._generation ?? 0) + 1;
        const [, bytes] = GLib.file_get_contents(`${this.path}/builds/current`);
        const build = new TextDecoder().decode(bytes).trim();
        const {default: RicingScreenshots} = await import(`file://${this.path}/builds/${build}/extension.js`);
        // disable() may have run while the import was pending.
        if (generation !== this._generation)
            return;
        this._inner = new RicingScreenshots(this.metadata);
        this._inner.enable();
        console.log(`RicingScreenshots dev build ${build} enabled`);
    }

    disable() {
        this._generation = (this._generation ?? 0) + 1;
        this._inner?.disable();
        this._inner = null;
    }
}
