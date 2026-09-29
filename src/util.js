// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

// Colors are stored in settings as CSS strings; St wants them back as CSS,
// but indicators need the same color at several strengths.

export function parseColor(str) {
    const fn = /rgba?\(([^)]+)\)/.exec(str ?? '');
    if (fn) {
        const [r, g, b, a = 1] = fn[1].split(',').map(v => parseFloat(v));
        return {r, g, b, a};
    }
    const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(str ?? '');
    if (hex) {
        const n = parseInt(hex[1], 16);
        const a = hex[2] ? parseInt(hex[2], 16) / 255 : 1;
        return {r: n >> 16, g: (n >> 8) & 255, b: n & 255, a};
    }
    return {r: 255, g: 255, b: 255, a: 1};
}

export function css({r, g, b, a}, alpha = 1) {
    return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${(a * alpha).toFixed(3)})`;
}

// Dark text on light accents, light text on dark ones.
export function textOn({r, g, b}) {
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luma > 150 ? '#1b1d2b' : '#eef0f7';
}
