// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// GNOME 50 gives each actor its own cursor; 49 has one for the whole
// display, which must be put back when the session ends.
const PER_ACTOR = !!Clutter.CursorType;

export function setCursor(actor, name) {
    if (PER_ACTOR)
        actor.set_cursor_type(Clutter.CursorType[name]);
    else
        global.display.set_cursor(Meta.Cursor[name]);
}

export function resetCursor() {
    if (!PER_ACTOR)
        global.display.set_cursor(Meta.Cursor.DEFAULT);
}

export function monitorFor(rect) {
    const r = new Mtk.Rectangle({x: rect.x, y: rect.y, width: Math.max(1, rect.w), height: Math.max(1, rect.h)});
    const i = global.display.get_monitor_index_for_rect(r);
    return Main.layoutManager.monitors[i] ?? Main.layoutManager.primaryMonitor;
}

// Puts a floating box under the rectangle, or above it, or inside its
// bottom edge when neither fits, and keeps it on the rectangle's monitor.
export function placeNear(actor, rect, gap = 12) {
    const m = monitorFor(rect);
    const [, , natW, natH] = actor.get_preferred_size();
    let x = rect.x + (rect.w - natW) / 2;
    let y = rect.y + rect.h + gap;
    if (y + natH > m.y + m.height - gap)
        y = rect.y - natH - gap;
    if (y < m.y + gap)
        y = rect.y + rect.h - natH - gap;
    x = Math.min(Math.max(x, m.x + gap), m.x + m.width - natW - gap);
    y = Math.min(Math.max(y, m.y + gap), m.y + m.height - natH - gap);
    actor.set_position(Math.round(x), Math.round(y));
}
