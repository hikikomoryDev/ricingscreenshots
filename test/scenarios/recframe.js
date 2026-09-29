// Does any frame (the red recording frame, the mint picking frame) end up
// in the video? Records a plain area, optionally at 200 %.
export default async function (t) {
    const {Clutter, GLib, Gio} = t;
    await t.wait(1000);
    const scale = Number(t.env('RS_SCALE', '1'));
    if (scale !== 1) {
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
        const [serial, monitors] = (await call('GetCurrentState', null, '(ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv})')).deepUnpack();
        const [[connector], modes] = monitors[0];
        await call('ApplyMonitorsConfig', new GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', [
            serial, 1, [[0, 0, scale, 0, true, [[connector, modes[0][0], {}]]]], {}]));
        await t.wait(1500);
    }
    t.log(`stage ${global.stage.width}x${global.stage.height} scale ${scale}`);
    const rec = t.ext()._recorder;
    t.ext().record();
    await t.wait(600);
    // Odd spots, so fractional scales land between pixels.
    await t.drag(301, 203, 901, 603);
    await t.wait(500);
    await t.key(Clutter.KEY_Return, [], 100);
    for (let i = 0; i < 200 && !rec.recording; i++)
        await t.wait(20);
    for (let i = 0; i < 10; i++)
        await t.move(400 + i * 30, 300, 200);
    await t.shot('screen');
    t.ext().record();
    for (let i = 0; i < 100 && rec._state !== 'card'; i++)
        await t.wait(50);
    await t.key(Clutter.KEY_Return, [], 800);
    t.log(`saved: state=${rec._state}`);
}
