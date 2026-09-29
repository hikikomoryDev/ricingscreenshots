// Record → stop → Save as… → the desktop's save dialog → Enter.
export default async function (t) {
    const {Clutter, GLib, Gio} = t;
    await t.wait(1000);
    const rec = t.ext()._recorder;
    t.ext().record();
    await t.wait(600);
    await t.drag(400, 300, 1000, 700);
    for (let i = 0; i < 200 && !rec.recording; i++)
        await t.wait(50);
    for (let i = 0; i < 8; i++)
        await t.move(500 + i * 40, 400, 200);
    t.ext().record();
    for (let i = 0; i < 100 && rec._state !== 'card'; i++)
        await t.wait(50);
    t.log(`card: ${rec._state}`);
    rec._saveAs();
    let win;
    for (let i = 0; i < 90 && !win; i++) {
        await t.wait(500);
        win = global.get_window_actors().map(a => a.meta_window).find(w => /Save/.test(w.get_title() ?? ''));
    }
    t.log(`dialog: ${win ? win.get_title() : 'none'} state=${rec._state}`);
    if (!win)
        return;
    await t.wait(1500);
    await t.shot('01-dialog');
    await t.key(Clutter.KEY_Return, [], 3000);
    t.log(`after Enter: state=${rec._state}`);
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
    const names = [];
    const e = Gio.File.new_for_path(dir).enumerate_children('standard::name', 0, null);
    for (let info; (info = e.next_file(null));)
        names.push(info.get_name());
    t.log(`Videos: ${names.join(', ')}`);
    t.log(`notifications: ${t.notifications().join(' | ')}`);
}
