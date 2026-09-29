// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseColor} from './util.js';

const DEFAULT_SHORTCUT = '<Shift><Super>s';

export default class RicingScreenshotsPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(560, 640);

        const page = new Adw.PreferencesPage();
        window.add(page);

        const capture = new Adw.PreferencesGroup({
            title: 'Capture',
            description: 'Drag over an area and it is copied to the clipboard at once.',
        });
        page.add(capture);
        capture.add(this._shortcutRow(window, settings));
        capture.add(this._switch(settings, 'ask-to-edit', 'Offer to edit',
            'After a capture, a card by the area asks whether to draw on it or crop it'));
        capture.add(this._switch(settings, 'show-notification', 'Notification',
            '“Screenshot captured” at the top of the screen'));
        capture.add(this._switch(settings, 'play-sound', 'Shutter sound', null));

        const look = new Adw.PreferencesGroup({title: 'Look'});
        page.add(look);
        look.add(this._colorRow(settings, 'accent-color', 'Accent color',
            'Selection frame, the Edit and Copy buttons, the active tool'));
        const dim = new Adw.SpinRow({
            title: 'Darken the rest of the screen',
            subtitle: 'Percent, while selecting and editing',
            adjustment: new Gtk.Adjustment({lower: 0, upper: 90, step_increment: 5, page_increment: 10}),
        });
        dim.value = Math.round(settings.get_double('dim-opacity') * 100);
        dim.connect('notify::value', () => settings.set_double('dim-opacity', dim.value / 100));
        look.add(dim);

        const keys = new Adw.PreferencesGroup({
            title: 'In the editor',
            description: 'P pen · H highlighter · A arrow · R rectangle · C crop\n' +
                'Ctrl+Z undo · Ctrl+Shift+Z redo · Enter or Ctrl+C copy · Esc discard',
        });
        page.add(keys);
    }

    _switch(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title});
        if (subtitle)
            row.subtitle = subtitle;
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
        return row;
    }

    _colorRow(settings, key, title, subtitle) {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const load = () => {
            const {r, g, b} = parseColor(settings.get_string(key));
            const rgba = new Gdk.RGBA();
            rgba.parse(`rgb(${r},${g},${b})`);
            button.rgba = rgba;
        };
        load();
        button.connect('notify::rgba', () => {
            const {red, green, blue} = button.rgba;
            const value = `rgb(${Math.round(red * 255)},${Math.round(green * 255)},${Math.round(blue * 255)})`;
            if (value !== settings.get_string(key))
                settings.set_string(key, value);
        });
        row.add_suffix(button);
        row.activatable_widget = button;
        return row;
    }

    _shortcutRow(window, settings) {
        const row = new Adw.ActionRow({
            title: 'Shortcut',
            subtitle: 'Starts an area screenshot',
            activatable: true,
        });
        const label = new Gtk.ShortcutLabel({
            disabled_text: 'Off',
            valign: Gtk.Align.CENTER,
        });
        const sync = () => {
            label.accelerator = settings.get_strv('shortcut')[0] ?? '';
        };
        sync();
        settings.connect('changed::shortcut', sync);
        const reset = new Gtk.Button({
            icon_name: 'edit-undo-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Back to Shift+Super+S',
            css_classes: ['flat'],
        });
        reset.connect('clicked', () => settings.set_strv('shortcut', [DEFAULT_SHORTCUT]));
        row.add_suffix(label);
        row.add_suffix(reset);
        row.connect('activated', () => this._askShortcut(window, settings));
        return row;
    }

    // A small dialog that takes the next key combination.
    _askShortcut(window, settings) {
        const dialog = new Adw.Dialog({title: 'Set shortcut', content_width: 380});
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
        });
        box.append(new Gtk.Label({
            label: 'Press the new shortcut',
            css_classes: ['title-3'],
        }));
        box.append(new Gtk.Label({
            label: 'Esc cancels, Backspace turns the shortcut off',
            css_classes: ['dim-label'],
        }));
        const view = new Adw.ToolbarView({content: box});
        view.add_top_bar(new Adw.HeaderBar());
        dialog.child = view;

        const keys = new Gtk.EventControllerKey();
        keys.connect('key-pressed', (_c, keyval, keycode, state) => {
            const mask = state & Gtk.accelerator_get_default_mod_mask();
            const lower = Gdk.keyval_to_lower(keyval);
            if (!mask && lower === Gdk.KEY_Escape) {
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            if (!mask && lower === Gdk.KEY_BackSpace) {
                settings.set_strv('shortcut', []);
                dialog.close();
                return Gdk.EVENT_STOP;
            }
            // Modifiers alone are not a shortcut yet.
            if (isModifier(lower))
                return Gdk.EVENT_STOP;
            // Plain letters would fire while typing; Print and F-keys may stand alone.
            const standalone = lower === Gdk.KEY_Print || (lower >= Gdk.KEY_F1 && lower <= Gdk.KEY_F35);
            if (!mask && !standalone)
                return Gdk.EVENT_STOP;
            if (!Gtk.accelerator_valid(lower, mask) && !standalone)
                return Gdk.EVENT_STOP;
            settings.set_strv('shortcut', [Gtk.accelerator_name_with_keycode(null, lower, keycode, mask)]);
            dialog.close();
            return Gdk.EVENT_STOP;
        });
        dialog.add_controller(keys);
        dialog.present(window);
    }
}

function isModifier(keyval) {
    return [
        Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Control_L, Gdk.KEY_Control_R,
        Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R,
        Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_Caps_Lock,
    ].includes(keyval);
}
