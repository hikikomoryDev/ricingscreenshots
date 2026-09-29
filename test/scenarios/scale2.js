// At 200 % (as on the author's laptop) the capture keeps physical pixels
// and the edit round-trip stays pixel exact. Run with a 3840x2160 monitor.
export default async function (t) {
    const {Gio, GLib, Clutter} = t;
    await t.wait(800);
    const call = (method, params, sig) => new Promise((resolve, reject) =>
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', method, params, sig ? new GLib.VariantType(sig) : null,
            Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    resolve(c.call_finish(res));
                } catch (e) {
                    reject(e);
                }
            }));
    const state = (await call('GetCurrentState', null, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')).deepUnpack();
    const [serial, monitors] = state;
    const [[connector], modes] = monitors[0];
    const current = modes.find(m => m[6]['is-current']?.deepUnpack?.() ?? m[6]['is-current']) ?? modes[0];
    t.log(`monitor ${connector} mode ${current[0]} scales ${current[5].join(',')}`);
    await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
        serial, 1, [[0, 0, 2.0, 0, true, [[connector, current[0], {}]]]], {},
    ]));
    await t.wait(1500);
    t.log(`stage ${global.stage.width}x${global.stage.height}`);

    t.ext().capture();
    await t.wait(600);
    await t.drag(300, 200, 800, 500);
    await t.wait(600);
    const first = await t.clipboard('clip-first');
    t.log(`capture of 500x300 logical: ${first.width}x${first.height}`);
    await t.key(Clutter.KEY_Return);
    await t.wait(300);
    const ed = t.session()._editor;
    ed.setTool('arrow');
    await t.drag(700, 450, 450, 300, 10);
    await t.shot('01-editor');
    await t.key(Clutter.KEY_Return);
    await t.wait(1200);
    const edited = await t.clipboard('clip-edited');
    t.log(`edited: ${edited.width}x${edited.height}`);
    const px = (pb, x, y) => {
        const d = pb.get_pixels();
        const i = y * pb.rowstride + x * pb.n_channels;
        return [d[i], d[i + 1], d[i + 2]].join(',');
    };
    let same = 0, total = 0;
    for (const [x, y] of [[20, 20], [900, 40], [50, 550], [980, 580], [500, 100], [120, 300]]) {
        total++;
        if (px(first, x, y) === px(edited, x, y))
            same++;
        else
            t.log(`  differs at ${x},${y}: ${px(first, x, y)} vs ${px(edited, x, y)}`);
    }
    t.log(`untouched pixels equal: ${same}/${total}`);
}
