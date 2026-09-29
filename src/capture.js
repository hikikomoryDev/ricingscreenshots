// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {Editor} from './editor.js';
import {placeNear, resetCursor, setCursor} from './place.js';
import {css, parseColor, textOn} from './util.js';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot_stage_to_content');
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
Gio._promisify(Shell.Screenshot, 'composite_to_stream');

// A drag shorter than this is a click, not a selection.
const MIN_SIZE = 4;
const FRAME = 2;
const THUMB_W = 132;
const THUMB_H = 84;

// The full-screen layer that holds the frozen screen, the shade and every
// control. It only forwards input to the session.
const Layer = GObject.registerClass(
class RicingScreenshotsLayer extends St.Widget {
    _init(session) {
        super._init({reactive: true, can_focus: true});
        this._session = session;
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
    }

    vfunc_key_press_event(event) {
        return this._session.onKey(event);
    }
});

// The input surface under the controls: presses on a button never reach it.
const Surface = GObject.registerClass(
class RicingScreenshotsSurface extends St.Widget {
    _init(session) {
        super._init({reactive: true});
        this._session = session;
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
    }

    vfunc_button_press_event(event) {
        return this._session.onPress(event);
    }

    vfunc_motion_event(event) {
        return this._session.onMotion(event);
    }

    vfunc_button_release_event(event) {
        return this._session.onRelease(event);
    }
});

// Darkens everything but the selection with four panels around it.
class Shade {
    constructor(parent, opacity) {
        this._panels = [0, 1, 2, 3].map(() => {
            const w = new St.Widget({style: `background-color: rgba(0,0,0,${opacity});`});
            parent.add_child(w);
            return w;
        });
    }

    // No hole: the whole screen is shaded.
    setHole(rect) {
        const {width: W, height: H} = global.stage;
        const [top, bottom, left, right] = this._panels;
        if (!rect) {
            top.set_position(0, 0);
            top.set_size(W, H);
            for (const p of [bottom, left, right])
                p.set_size(0, 0);
            return;
        }
        const {x, y, w, h} = rect;
        top.set_position(0, 0);
        top.set_size(W, y);
        bottom.set_position(0, y + h);
        bottom.set_size(W, Math.max(0, H - y - h));
        left.set_position(0, y);
        left.set_size(x, h);
        right.set_position(x + w, y);
        right.set_size(Math.max(0, W - x - w), h);
    }

    set visible(v) {
        this._panels.forEach(p => (p.visible = v));
    }
}

// Thumbnails keep a small copy, not the whole capture.
function shrink(pixbuf, maxW, maxH) {
    const k = Math.min(1, maxW / pixbuf.width, maxH / pixbuf.height);
    if (k >= 1)
        return pixbuf;
    return pixbuf.scale_simple(Math.max(1, Math.round(pixbuf.width * k)),
        Math.max(1, Math.round(pixbuf.height * k)), GdkPixbuf.InterpType.BILINEAR);
}

function imageContent(pixbuf) {
    if (!pixbuf.get_has_alpha())
        pixbuf = pixbuf.add_alpha(false, 0, 0, 0);
    const context = global.stage.context.get_backend().get_cogl_context();
    const content = St.ImageContent.new_with_preferred_size(pixbuf.width, pixbuf.height);
    content.set_bytes(context, pixbuf.read_pixel_bytes(), Cogl.PixelFormat.RGBA_8888,
        pixbuf.width, pixbuf.height, pixbuf.rowstride);
    return content;
}

let notificationSource = null;
function getSource() {
    if (!notificationSource) {
        notificationSource = new MessageTray.Source({
            title: 'RicingScreenshots',
            iconName: 'screenshot-recorded-symbolic',
        });
        notificationSource.connect('destroy', () => (notificationSource = null));
        Main.messageTray.add(notificationSource);
    }
    return notificationSource;
}

export class CaptureSession {
    // With onArea the session only picks an area on the live screen (for a
    // recording) and hands it over instead of taking a picture.
    constructor(settings, path, onClosed, {onArea = null} = {}) {
        this._settings = settings;
        this._path = path;
        this._onClosed = onClosed;
        this._onArea = onArea;
        this._rect = null;
        this._drag = null;
        this._mode = 'select';
    }

    async open() {
        if (this._onArea) {
            this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        } else {
            const shooter = new Shell.Screenshot();
            const [content, scale] = await shooter.screenshot_stage_to_content();
            if (this._destroyed)
                return;
            this._content = content;
            this._scale = scale;
        }
        this._accent = parseColor(this._settings.get_string('accent-color'));

        this._layer = new Layer(this);
        Main.layoutManager.screenshotUIGroup.add_child(this._layer);
        Main.layoutManager.screenshotUIGroup.show();

        this._frozen = new St.Widget();
        this._frozen.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
        if (this._content)
            this._frozen.set_content(this._content);
        // Shown 1:1, so the edited capture keeps the original pixels.
        this._frozen.set_content_scaling_filters(Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
        this._layer.add_child(this._frozen);

        this._shade = new Shade(this._layer, this._settings.get_double('dim-opacity'));
        this._shade.setHole(null);

        // Everything drawn from here on goes above the shade.
        this._editLayer = new St.Widget();
        this._layer.add_child(this._editLayer);

        this._frame = new St.Widget({
            style: `border: ${FRAME}px solid ${css(this._accent)};`,
            visible: false,
        });
        this._layer.add_child(this._frame);
        this._sizeLabel = new St.Label({style_class: 'rs-size-label', visible: false});
        this._layer.add_child(this._sizeLabel);

        this._surface = new Surface(this);
        setCursor(this._surface, 'CROSSHAIR');
        this._layer.add_child(this._surface);

        this._controls = new St.Widget();
        this._layer.add_child(this._controls);

        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
    }

    get scale() {
        return this._scale;
    }

    get rect() {
        return this._rect;
    }

    get layer() {
        return this._editLayer;
    }

    get controls() {
        return this._controls;
    }

    get surface() {
        return this._surface;
    }

    get settings() {
        return this._settings;
    }

    get iconsPath() {
        return `${this._path}/icons`;
    }

    get accent() {
        return this._accent;
    }

    setRect(rect) {
        this._rect = rect;
        this._shade.setHole(rect);
        if (!rect) {
            this._frame.hide();
            this._sizeLabel.hide();
            return;
        }
        this._frame.set_position(rect.x - FRAME, rect.y - FRAME);
        this._frame.set_size(rect.w + 2 * FRAME, rect.h + 2 * FRAME);
        this._frame.show();
        this._sizeLabel.text = `${Math.round(rect.w * this._scale)} × ${Math.round(rect.h * this._scale)}`;
        this._sizeLabel.show();
        const [, , lw, lh] = this._sizeLabel.get_preferred_size();
        let ly = rect.y - lh - 8;
        if (ly < 0)
            ly = rect.y + 8;
        this._sizeLabel.set_position(Math.round(Math.max(rect.x, 0)), Math.round(ly));
        if (lw > rect.w && rect.x + lw > global.stage.width)
            this._sizeLabel.x = global.stage.width - lw;
    }

    // Selection chrome off for the final capture, then back on.
    setChromeVisible(visible) {
        this._frame.visible = visible && !!this._rect;
        this._sizeLabel.visible = visible && !!this._rect;
        this._controls.visible = visible;
    }

    onKey(event) {
        const key = event.get_key_symbol();
        if (this._mode === 'edit')
            return this._editor.onKey(event);
        if (key === Clutter.KEY_Escape) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        if (this._mode === 'armed' && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter)) {
            this._startRecording();
            return Clutter.EVENT_STOP;
        }
        if (this._mode === 'ask' && (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || key === Clutter.KEY_e)) {
            this._startEdit();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    onPress(event) {
        const button = event.get_button();
        if (this._mode === 'edit')
            return this._editor.onPress(event);
        if (this._mode === 'ask') {
            // A click beside the card dismisses it.
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        if (button === Clutter.BUTTON_SECONDARY) {
            this.destroy();
            return Clutter.EVENT_STOP;
        }
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this._mode === 'armed') {
            // Dragging again picks another area before recording.
            this._card?.destroy();
            this._card = null;
            this._mode = 'select';
        }
        const [x, y] = event.get_coords();
        this._drag = {x0: Math.floor(x), y0: Math.floor(y)};
        return Clutter.EVENT_STOP;
    }

    onMotion(event) {
        if (this._mode === 'edit')
            return this._editor.onMotion(event);
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        this.setRect(dragRect(this._drag.x0, this._drag.y0, x, y));
        return Clutter.EVENT_STOP;
    }

    onRelease(event) {
        if (this._mode === 'edit')
            return this._editor.onRelease(event);
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const rect = dragRect(this._drag.x0, this._drag.y0, x, y);
        this._drag = null;
        if (rect.w < MIN_SIZE || rect.h < MIN_SIZE) {
            this.setRect(null);
            return Clutter.EVENT_STOP;
        }
        this.setRect(rect);
        if (this._onArea) {
            this._arm();
            return Clutter.EVENT_STOP;
        }
        this._captureSelection().catch(e => {
            logError(e, 'RicingScreenshots: capture failed');
            this.destroy();
        });
        return Clutter.EVENT_STOP;
    }

    // The area for a recording is picked; nothing records until Rec.
    _arm() {
        this._mode = 'armed';
        const card = new St.BoxLayout({style_class: 'rs-card rs-rec-card', reactive: true});
        const rec = new St.Button({style_class: 'rs-card-button rs-rec-button', accessible_name: 'Start recording (Enter)'});
        const recBox = new St.BoxLayout({style_class: 'rs-rec-box'});
        recBox.add_child(new St.Widget({style_class: 'rs-rec-dot', y_align: Clutter.ActorAlign.CENTER}));
        recBox.add_child(new St.Label({text: 'Rec', y_align: Clutter.ActorAlign.CENTER}));
        rec.child = recBox;
        rec.connect('clicked', () => this._startRecording());
        const cancel = new St.Button({style_class: 'rs-card-button', label: 'Cancel', accessible_name: 'Cancel (Esc)'});
        cancel.connect('clicked', () => this.destroy());
        card.add_child(rec);
        card.add_child(cancel);
        card.add_child(new St.Label({
            text: 'Enter · Esc · drag again to change',
            style_class: 'rs-card-hint',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._controls.add_child(card);
        placeNear(card, this._rect);
        this._card = card;
    }

    _startRecording() {
        if (this._mode !== 'armed')
            return;
        const {_onArea: onArea, _rect: rect} = this;
        this.destroy();
        onArea(rect);
    }

    async _captureSelection() {
        this._mode = 'busy';
        const {x, y, w, h} = this._rect;
        const s = this._scale;
        const stream = Gio.MemoryOutputStream.new_resizable();
        const pixbuf = await Shell.Screenshot.composite_to_stream(
            this._content.get_texture(),
            Math.round(x * s), Math.round(y * s), Math.round(w * s), Math.round(h * s),
            s, null, 0, 0, 1, stream);
        stream.close(null);
        if (this._destroyed)
            return;
        this._store(stream.steal_as_bytes(), pixbuf, 'Screenshot captured');
        if (!this._settings.get_boolean('ask-to-edit')) {
            this.destroy();
            return;
        }
        this._ask(pixbuf);
    }

    // Copies the PNG, plays the shutter and tells the user.
    _store(bytes, pixbuf, title) {
        St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);
        if (this._settings.get_boolean('play-sound')) {
            global.display.get_sound_player().play_from_theme(
                'screen-capture', 'Screenshot taken', null);
        }
        if (this._settings.get_boolean('show-notification')) {
            const source = getSource();
            const notification = new MessageTray.Notification({
                source,
                title,
                body: 'Copied to the clipboard',
                gicon: imageContent(shrink(pixbuf, 256, 256)),
                isTransient: true,
            });
            source.addNotification(notification);
        }
        console.log(`RicingScreenshots: copied ${pixbuf.width}x${pixbuf.height}`);
    }

    // The live screen comes back with a small card by the captured area.
    _ask(pixbuf) {
        this._mode = 'ask';
        this._frozen.hide();
        this._shade.visible = false;
        this.setChromeVisible(false);
        this._controls.show();
        setCursor(this._surface, 'DEFAULT');

        const card = new St.BoxLayout({style_class: 'rs-card', reactive: true});
        // The thumbnail takes the capture's shape, never wider or taller
        // than the box and never blown up more than twice.
        const k = Math.min(THUMB_W / pixbuf.width, THUMB_H / pixbuf.height, 2);
        const thumb = new St.Widget({
            style_class: 'rs-thumb',
            width: Math.max(1, Math.round(pixbuf.width * k)),
            height: Math.max(1, Math.round(pixbuf.height * k)),
            y_align: Clutter.ActorAlign.CENTER,
        });
        thumb.set_content(imageContent(shrink(pixbuf, THUMB_W * this._scale * 2, THUMB_H * this._scale * 2)));
        card.add_child(thumb);

        const side = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'rs-card-side'});
        side.add_child(new St.Label({text: 'Copied to the clipboard', style_class: 'rs-card-title'}));
        const buttons = new St.BoxLayout({style_class: 'rs-card-buttons'});
        const edit = new St.Button({
            style_class: 'rs-card-button rs-card-edit',
            label: 'Edit',
            style: `background-color: ${css(this._accent)}; color: ${textOn(this._accent)};`,
        });
        edit.connect('clicked', () => this._startEdit());
        const close = new St.Button({style_class: 'rs-card-button', label: 'Close'});
        close.connect('clicked', () => this.destroy());
        buttons.add_child(edit);
        buttons.add_child(close);
        side.add_child(buttons);
        card.add_child(side);
        this._controls.add_child(card);
        placeNear(card, this._rect);
        this._card = card;
    }

    _startEdit() {
        if (this._mode !== 'ask')
            return;
        this._card?.destroy();
        this._card = null;
        this._frozen.show();
        this._shade.visible = true;
        this.setRect(this._rect);
        this.setChromeVisible(true);
        setCursor(this._surface, 'CROSSHAIR');
        this._mode = 'edit';
        this._editor = new Editor(this);
    }

    // The editor's result: the frozen screen and the drawing, as shown.
    async finishEdit() {
        this._mode = 'busy';
        this.setChromeVisible(false);
        this._editor.setHandlesVisible(false);
        const {x, y, w, h} = this._rect;
        const stream = Gio.MemoryOutputStream.new_resizable();
        const shooter = new Shell.Screenshot();
        await shooter.screenshot_area(x, y, w, h, stream);
        stream.close(null);
        const bytes = stream.steal_as_bytes();
        const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(bytes), null);
        if (!this._destroyed)
            this._store(bytes, pixbuf, 'Edited screenshot');
        this.destroy();
    }

    destroy() {
        if (this._destroyed)
            return;
        this._destroyed = true;
        this._editor?.destroy();
        this._editor = null;
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._layer?.destroy();
        this._layer = null;
        resetCursor();
        this._content = null;
        this._onClosed();
    }
}

function dragRect(x0, y0, x1, y1) {
    const {width: W, height: H} = global.stage;
    x1 = Math.min(Math.max(Math.round(x1), 0), W);
    y1 = Math.min(Math.max(Math.round(y1), 0), H);
    return {
        x: Math.min(x0, x1),
        y: Math.min(y0, y1),
        w: Math.abs(x1 - x0),
        h: Math.abs(y1 - y0),
    };
}
