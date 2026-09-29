// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';

import {placeNear, setCursor} from './place.js';
import {css, parseColor, textOn} from './util.js';

export const COLORS = [
    'rgb(255,59,48)', 'rgb(255,149,0)', 'rgb(255,214,10)', 'rgb(52,199,89)',
    'rgb(10,132,255)', 'rgb(191,90,242)', 'rgb(255,255,255)', 'rgb(28,28,30)',
];
export const WIDTHS = [2, 4, 8];
const TOOLS = [
    ['pen', 'Pen (P)', 'p'],
    ['marker', 'Highlighter (H)', 'h'],
    ['arrow', 'Arrow (A)', 'a'],
    ['rect', 'Rectangle (R)', 'r'],
    ['crop', 'Crop (C)', 'c'],
];
// How close to an edge of the selection a press counts as grabbing it.
const EDGE = 10;
const MIN_CROP = 8;

const CURSORS = {
    n: 'N_RESIZE', s: 'S_RESIZE', e: 'E_RESIZE', w: 'W_RESIZE',
    ne: 'NE_RESIZE', nw: 'NW_RESIZE', se: 'SE_RESIZE', sw: 'SW_RESIZE',
    move: 'MOVE', new: 'CROSSHAIR',
};

// Annotations are kept in stage coordinates, so cropping never moves them
// against the picture underneath.
export function drawShape(cr, shape) {
    const {r, g, b} = parseColor(shape.color);
    const marker = shape.type === 'marker';
    cr.setSourceRGBA(r / 255, g / 255, b / 255, marker ? 0.4 : 1);
    cr.setLineWidth(marker ? shape.width * 4 : shape.width);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    switch (shape.type) {
    case 'pen':
    case 'marker': {
        const [first, ...rest] = shape.points;
        cr.moveTo(first[0], first[1]);
        if (!rest.length)
            cr.lineTo(first[0] + 0.01, first[1]);
        for (const [x, y] of rest)
            cr.lineTo(x, y);
        cr.stroke();
        break;
    }
    case 'rect': {
        const [x0, y0, x1, y1] = shape.box;
        cr.setLineJoin(Cairo.LineJoin.MITER);
        cr.rectangle(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
        cr.stroke();
        break;
    }
    case 'arrow': {
        const [x0, y0, x1, y1] = shape.box;
        const length = Math.hypot(x1 - x0, y1 - y0);
        if (length < 1)
            break;
        const angle = Math.atan2(y1 - y0, x1 - x0);
        const head = Math.min(Math.max(10, shape.width * 4), length);
        const spread = Math.PI / 7;
        // The shaft stops inside the head so its round cap never pokes out.
        const inset = head * 0.7;
        cr.moveTo(x0, y0);
        cr.lineTo(x1 - Math.cos(angle) * inset, y1 - Math.sin(angle) * inset);
        cr.stroke();
        cr.moveTo(x1, y1);
        cr.lineTo(x1 - head * Math.cos(angle - spread), y1 - head * Math.sin(angle - spread));
        cr.lineTo(x1 - head * Math.cos(angle + spread), y1 - head * Math.sin(angle + spread));
        cr.closePath();
        cr.fill();
        break;
    }
    }
}

export class Editor {
    constructor(session) {
        this._session = session;
        this._settings = session.settings;
        this._tool = this._settings.get_string('tool');
        this._color = this._settings.get_string('pen-color');
        this._width = this._settings.get_int('pen-width');
        this._shapes = [];
        this._undone = [];
        this._current = null;
        this._crop = null;

        this._canvas = new St.DrawingArea();
        this._canvas.connect('repaint', area => this._repaint(area));
        session.layer.add_child(this._canvas);

        this._handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(() => {
            const h = new St.Widget({style_class: 'rs-handle', visible: false});
            session.layer.add_child(h);
            return h;
        });

        this._buildToolbar();
        this._syncRect();
        this._syncTool();
    }

    _icon(name) {
        return new St.Icon({
            gicon: Gio.FileIcon.new(Gio.File.new_for_path(`${this._session.iconsPath}/${name}-symbolic.svg`)),
            icon_size: 18,
        });
    }

    _buildToolbar() {
        const accent = this._session.accent;
        const bar = new St.BoxLayout({style_class: 'rs-toolbar', reactive: true});
        this._bar = bar;
        const group = () => {
            const g = new St.BoxLayout({style_class: 'rs-group'});
            bar.add_child(g);
            return g;
        };

        const tools = group();
        this._toolButtons = new Map();
        for (const [name, title] of TOOLS) {
            const button = new St.Button({style_class: 'rs-tool', child: this._icon(`rs-${name}`), accessible_name: title});
            button.connect('clicked', () => this.setTool(name));
            tools.add_child(button);
            this._toolButtons.set(name, button);
        }

        const colors = group();
        this._colorButtons = new Map();
        for (const color of COLORS) {
            const dot = new St.Widget({style_class: 'rs-swatch-dot', style: `background-color: ${color};`});
            const button = new St.Button({style_class: 'rs-swatch', child: dot, accessible_name: color});
            button.connect('clicked', () => this.setColor(color));
            colors.add_child(button);
            this._colorButtons.set(color, button);
        }

        const widths = group();
        this._widthButtons = new Map();
        WIDTHS.forEach(width => {
            const d = 4 + width * 1.25;
            const dot = new St.Widget({style_class: 'rs-width-dot', style: `width: ${d}px; height: ${d}px; border-radius: ${d}px;`});
            const button = new St.Button({style_class: 'rs-width', child: new St.Bin({child: dot}), accessible_name: `Width ${width}`});
            button.connect('clicked', () => this.setWidth(width));
            widths.add_child(button);
            this._widthButtons.set(width, button);
        });

        const history = group();
        this._undoButton = new St.Button({style_class: 'rs-tool', child: new St.Icon({icon_name: 'edit-undo-symbolic', icon_size: 18}), accessible_name: 'Undo'});
        this._undoButton.connect('clicked', () => this.undo());
        this._redoButton = new St.Button({style_class: 'rs-tool', child: new St.Icon({icon_name: 'edit-redo-symbolic', icon_size: 18}), accessible_name: 'Redo'});
        this._redoButton.connect('clicked', () => this.redo());
        history.add_child(this._undoButton);
        history.add_child(this._redoButton);

        const end = group();
        const close = new St.Button({style_class: 'rs-tool', child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 18}), accessible_name: 'Discard (Esc)'});
        close.connect('clicked', () => this._session.destroy());
        const copy = new St.Button({
            style_class: 'rs-copy',
            label: 'Copy',
            accessible_name: 'Copy (Enter)',
            style: `background-color: ${css(accent)}; color: ${textOn(accent)};`,
        });
        copy.connect('clicked', () => this._finish());
        end.add_child(close);
        end.add_child(copy);

        this._session.controls.add_child(bar);
        this._syncButtons();
    }

    _syncButtons() {
        const accent = this._session.accent;
        const on = `background-color: ${css(accent, 0.9)}; color: ${textOn(accent)};`;
        for (const [name, button] of this._toolButtons) {
            button.style = name === this._tool ? on : null;
            button.checked = name === this._tool;
        }
        for (const [color, button] of this._colorButtons)
            button.style = color === this._color ? `border-color: ${css(accent)};` : null;
        for (const [width, button] of this._widthButtons)
            button.style = width === this._width ? on : null;
        for (const [button, stack] of [[this._undoButton, this._shapes], [this._redoButton, this._undone]]) {
            button.reactive = stack.length > 0;
            button.opacity = stack.length > 0 ? 255 : 90;
        }
    }

    setTool(tool) {
        this._tool = tool;
        this._settings.set_string('tool', tool);
        this._syncTool();
    }

    setColor(color) {
        this._color = color;
        this._settings.set_string('pen-color', color);
        this._syncButtons();
    }

    setWidth(width) {
        this._width = width;
        this._settings.set_int('pen-width', width);
        this._syncButtons();
    }

    undo() {
        if (!this._shapes.length)
            return;
        this._undone.push(this._shapes.pop());
        this._canvas.queue_repaint();
        this._syncButtons();
    }

    redo() {
        if (!this._undone.length)
            return;
        this._shapes.push(this._undone.pop());
        this._canvas.queue_repaint();
        this._syncButtons();
    }

    get shapes() {
        return this._shapes;
    }

    _syncTool() {
        this.setHandlesVisible(this._tool === 'crop');
        if (this._tool !== 'crop')
            setCursor(this._session.surface, 'CROSSHAIR');
        this._syncButtons();
    }

    setHandlesVisible(visible) {
        this._handles.forEach(h => (h.visible = visible));
    }

    // Canvas, handles and toolbar follow the selection.
    _syncRect() {
        const {x, y, w, h} = this._session.rect;
        this._canvas.set_position(x, y);
        this._canvas.set_size(w, h);
        this._canvas.queue_repaint();
        const spots = [[0, 0], [0.5, 0], [1, 0], [1, 0.5], [1, 1], [0.5, 1], [0, 1], [0, 0.5]];
        this._handles.forEach((handle, i) => {
            const [, , hw, hh] = handle.get_preferred_size();
            handle.set_size(hw, hh);
            handle.set_position(Math.round(x + spots[i][0] * w - hw / 2), Math.round(y + spots[i][1] * h - hh / 2));
        });
        placeNear(this._bar, this._session.rect);
    }

    _repaint(area) {
        const cr = area.get_context();
        const {x, y} = this._session.rect;
        cr.translate(-x, -y);
        for (const shape of this._shapes)
            drawShape(cr, shape);
        if (this._current)
            drawShape(cr, this._current);
        cr.$dispose();
    }

    // Which part of the selection a crop drag at (x, y) would take.
    _cropPart(x, y) {
        const {x: rx, y: ry, w, h} = this._session.rect;
        const inY = y > ry - EDGE && y < ry + h + EDGE;
        const inX = x > rx - EDGE && x < rx + w + EDGE;
        let part = '';
        if (inX && Math.abs(y - ry) <= EDGE)
            part += 'n';
        else if (inX && Math.abs(y - ry - h) <= EDGE)
            part += 's';
        if (inY && Math.abs(x - rx) <= EDGE)
            part += 'w';
        else if (inY && Math.abs(x - rx - w) <= EDGE)
            part += 'e';
        if (part)
            return part;
        return x > rx && x < rx + w && y > ry && y < ry + h ? 'move' : 'new';
    }

    onPress(event) {
        const button = event.get_button();
        if (button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        if (this._tool === 'crop') {
            this._crop = {part: this._cropPart(x, y), x0: x, y0: y, start: {...this._session.rect}};
            return Clutter.EVENT_STOP;
        }
        const shape = {type: this._tool, color: this._color, width: this._width};
        if (this._tool === 'pen' || this._tool === 'marker')
            shape.points = [[x, y]];
        else
            shape.box = [x, y, x, y];
        this._current = shape;
        this._canvas.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    onMotion(event) {
        const [x, y] = event.get_coords();
        if (this._crop) {
            this._dragCrop(x, y);
            return Clutter.EVENT_STOP;
        }
        if (!this._current) {
            if (this._tool === 'crop')
                setCursor(this._session.surface, CURSORS[this._cropPart(x, y)]);
            return Clutter.EVENT_PROPAGATE;
        }
        if (this._current.points)
            this._current.points.push([x, y]);
        else
            this._current.box = [this._current.box[0], this._current.box[1], x, y];
        this._canvas.queue_repaint();
        return Clutter.EVENT_STOP;
    }

    onRelease() {
        if (this._crop) {
            this._crop = null;
            return Clutter.EVENT_STOP;
        }
        if (!this._current)
            return Clutter.EVENT_PROPAGATE;
        const shape = this._current;
        this._current = null;
        // A click with the arrow or box tool draws nothing.
        const empty = shape.box && Math.hypot(shape.box[2] - shape.box[0], shape.box[3] - shape.box[1]) < 3;
        if (!empty) {
            this._shapes.push(shape);
            this._undone = [];
        }
        this._canvas.queue_repaint();
        this._syncButtons();
        return Clutter.EVENT_STOP;
    }

    _dragCrop(x, y) {
        const {part, x0, y0, start} = this._crop;
        const {width: W, height: H} = global.stage;
        const dx = Math.round(x - x0), dy = Math.round(y - y0);
        let left = start.x, top = start.y, right = start.x + start.w, bottom = start.y + start.h;
        if (part === 'move') {
            const mx = Math.min(Math.max(dx, -left), W - right);
            const my = Math.min(Math.max(dy, -top), H - bottom);
            left += mx;
            right += mx;
            top += my;
            bottom += my;
        } else if (part === 'new') {
            left = Math.round(x0);
            top = Math.round(y0);
            right = Math.round(x);
            bottom = Math.round(y);
        } else {
            if (part.includes('w'))
                left += dx;
            if (part.includes('e'))
                right += dx;
            if (part.includes('n'))
                top += dy;
            if (part.includes('s'))
                bottom += dy;
        }
        const clampX = v => Math.min(Math.max(v, 0), W);
        const clampY = v => Math.min(Math.max(v, 0), H);
        const rect = {
            x: clampX(Math.min(left, right)),
            y: clampY(Math.min(top, bottom)),
        };
        rect.w = clampX(Math.max(left, right)) - rect.x;
        rect.h = clampY(Math.max(top, bottom)) - rect.y;
        if (rect.w < MIN_CROP || rect.h < MIN_CROP)
            return;
        this._session.setRect(rect);
        this._syncRect();
    }

    onKey(event) {
        const key = event.get_key_symbol();
        const ctrl = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (event.get_state() & Clutter.ModifierType.SHIFT_MASK) !== 0;
        if (key === Clutter.KEY_Escape) {
            this._session.destroy();
        } else if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter || (ctrl && key === Clutter.KEY_c)) {
            this._finish();
        } else if (ctrl && (key === Clutter.KEY_z || key === Clutter.KEY_Z)) {
            if (shift)
                this.redo();
            else
                this.undo();
        } else if (ctrl && key === Clutter.KEY_y) {
            this.redo();
        } else if (!ctrl) {
            const tool = TOOLS.find(t => Clutter[`KEY_${t[2]}`] === key);
            if (!tool)
                return Clutter.EVENT_PROPAGATE;
            this.setTool(tool[0]);
        } else {
            return Clutter.EVENT_PROPAGATE;
        }
        return Clutter.EVENT_STOP;
    }

    _finish() {
        if (this._finishing)
            return;
        this._finishing = true;
        this._session.finishEdit().catch(e => {
            logError(e, 'RicingScreenshots: saving the edit failed');
            this._session.destroy();
        });
    }

    destroy() {
        // The actors go with the session's layer.
        this._canvas = null;
        this._handles = [];
    }
}
