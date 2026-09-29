// Opens the preferences window, photographs it, sets a new shortcut.
export default async function (t) {
    const {Clutter} = t;
    await t.move(960, 400);
    await t.wait(800);
    t.GLib.spawn_command_line_async('gnome-extensions prefs ricingscreenshots@hikikomoriDev');
    let win;
    for (let i = 0; i < 40 && !(win && win.get_frame_rect().width > 0); i++) {
        await t.wait(300);
        win = global.get_window_actors().map(a => a.meta_window)
            .find(w => w.get_title()?.includes('RicingScreenshots'));
    }
    await t.wait(1500);
    const f = win.get_frame_rect();
    t.log(`prefs at ${f.x},${f.y} ${f.width}x${f.height}`);
    await t.shot('prefs');
    // The shortcut row is the first row of the first group.
    await t.click(f.x + 150, f.y + 150);
    await t.wait(800);
    await t.shot('shortcut-dialog');
    await t.key(Clutter.KEY_a, [Clutter.KEY_Control_L, Clutter.KEY_Alt_L]);
    await t.wait(600);
    t.log(`shortcut now: ${t.settings().get_strv('shortcut')}`);
    await t.shot('after');
}
