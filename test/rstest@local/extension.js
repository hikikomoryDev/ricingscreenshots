// Test driver for the headless shell. Loads the scenario module named in
// RSTEST_SCENARIO and hands it a small toolbox, then quits the shell.
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const OUT = GLib.getenv('RSTEST_OUT') ?? '/tmp';

function log_(msg) {
    console.log(`RSTEST ${msg}`);
}

function wait(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

export default class TestDriver extends Extension {
    enable() {
        const path = GLib.getenv('RSTEST_SCENARIO');
        if (!path)
            return;
        Main.layoutManager.connectObject('startup-complete', () => this._run(path), this);
        if (!Main.layoutManager._startingUp)
            this._run(path);
    }

    disable() {
        Main.layoutManager.disconnectObject(this);
    }

    async _run(path) {
        if (this._started)
            return;
        this._started = true;
        const seat = Clutter.get_default_backend().get_default_seat();
        const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        const keyboard = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const now = () => GLib.get_monotonic_time();
        const t = {
            Main, Clutter, GLib, Gio, Shell, St, GdkPixbuf, OUT,
            log: log_,
            wait,
            move: async (x, y, ms = 120) => {
                pointer.notify_absolute_motion(now(), x, y);
                await wait(ms);
            },
            press: async (button = Clutter.BUTTON_PRIMARY, ms = 60) => {
                pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
                await wait(ms);
            },
            release: async (button = Clutter.BUTTON_PRIMARY, ms = 60) => {
                pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
                await wait(ms);
            },
            // Press, glide in steps so motion handlers see a path, release.
            drag: async (x0, y0, x1, y1, steps = 16, ms = 400) => {
                // Two moves: in the GNOME 49 container a single jump
                // sometimes lands with one coordinate left behind.
                pointer.notify_absolute_motion(now(), x0 - 1, y0 - 1);
                await wait(60);
                pointer.notify_absolute_motion(now(), x0, y0);
                await wait(100);
                pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
                await wait(40);
                for (let i = 1; i <= steps; i++) {
                    pointer.notify_absolute_motion(now(),
                        x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
                    await wait(ms / steps);
                }
                pointer.notify_button(now(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
                await wait(200);
            },
            click: async (x, y, button = Clutter.BUTTON_PRIMARY, ms = 300) => {
                pointer.notify_absolute_motion(now(), x, y);
                await wait(60);
                pointer.notify_button(now(), button, Clutter.ButtonState.PRESSED);
                await wait(40);
                pointer.notify_button(now(), button, Clutter.ButtonState.RELEASED);
                await wait(ms);
            },
            // key(Clutter.KEY_Escape) or key(Clutter.KEY_z, [Clutter.KEY_Control_L])
            key: async (keyval, mods = [], ms = 250) => {
                for (const m of mods)
                    keyboard.notify_keyval(now(), m, Clutter.KeyState.PRESSED);
                keyboard.notify_keyval(now(), keyval, Clutter.KeyState.PRESSED);
                await wait(30);
                keyboard.notify_keyval(now(), keyval, Clutter.KeyState.RELEASED);
                for (const m of mods.slice().reverse())
                    keyboard.notify_keyval(now(), m, Clutter.KeyState.RELEASED);
                await wait(ms);
            },
            shot: async name => {
                const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
                const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                const shooter = new Shell.Screenshot();
                await shooter.screenshot(false, stream);
                stream.close(null);
                log_(`shot ${name}`);
            },
            // The image in the clipboard as a pixbuf (null if none), saved to OUT.
            clipboard: name => new Promise(resolve => {
                St.Clipboard.get_default().get_content(St.ClipboardType.CLIPBOARD, 'image/png', (_c, bytes) => {
                    if (!bytes || bytes.get_size() === 0) {
                        resolve(null);
                        return;
                    }
                    if (name)
                        GLib.file_set_contents(`${OUT}/${name}.png`, bytes.get_data());
                    resolve(GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null));
                });
            }),
            clearClipboard: () => St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, ''),
            launch: id => {
                const app = Shell.AppSystem.get_default().lookup_app(id);
                if (!app)
                    throw new Error(`no app ${id}`);
                app.open_new_window(-1);
            },
            ext: () => Main.extensionManager.lookup('ricingscreenshots@hikikomoriDev')?.stateObj,
            settings: () => Main.extensionManager.lookup('ricingscreenshots@hikikomoriDev')?.stateObj?._settings,
            session: () => Main.extensionManager.lookup('ricingscreenshots@hikikomoriDev')?.stateObj?._session,
            notifications: () => Main.messageTray.getSources().flatMap(s => s.notifications.map(n => `${n.title}: ${n.body}`)),
            env: (name, fallback) => GLib.getenv(name) ?? fallback,
        };
        try {
            const mod = await import(`file://${path}`);
            await mod.default(t);
            log_('DONE');
        } catch (e) {
            log_(`FAIL ${e}\n${e.stack}`);
        }
        await wait(300);
        global.context.terminate();
    }
}
