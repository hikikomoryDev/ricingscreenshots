// Print and Shift+Super+S both start a capture once GNOME's keys are free.
export default async function (t) {
    const {Clutter, Gio} = t;
    await t.wait(1000);
    const gnome = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
    for (const k of ['show-screenshot-ui', 'screenshot', 'screenshot-window'])
        gnome.set_strv(k, []);
    t.settings().set_strv('shortcut', ['<Shift><Super>s', 'Print']);
    await t.wait(500);
    await t.key(Clutter.KEY_Print, [], 900);
    t.log(`Print: session=${!!t.session()} gnome ui open=${!!t.Main.screenshotUI?._shooter}`);
    await t.key(Clutter.KEY_Escape, [], 400);
    t.log(`Esc: session=${!!t.session()}`);
    await t.key(Clutter.KEY_s, [Clutter.KEY_Shift_L, Clutter.KEY_Super_L], 900);
    t.log(`Shift+Super+S: session=${!!t.session()}`);
    await t.key(Clutter.KEY_Escape, [], 400);
}
