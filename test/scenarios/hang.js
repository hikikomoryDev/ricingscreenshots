// A recording service that never answers "stop" is ended after 15 s, the
// panel pill goes away and the card still offers the video.
export default async function (t) {
    const {Clutter, Gio, GLib} = t;
    await t.wait(1000);
    const rec = t.ext()._recorder;
    t.ext().record();
    await t.wait(600);
    await t.drag(400, 300, 1000, 700);
    await t.key(Clutter.KEY_Return, [], 200);
    for (let i = 0; i < 200 && !rec.recording; i++)
        await t.wait(20);
    for (let i = 0; i < 6; i++)
        await t.move(500 + i * 40, 400, 250);
    const owner = () => new Promise(resolve => Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'NameHasOwner', new GLib.Variant('(s)', ['org.gnome.Shell.Screencast']),
        null, Gio.DBusCallFlags.NONE, -1, null, (c, r) => resolve(c.call_finish(r).deepUnpack()[0])));
    t.log(`service running: ${await owner()}`);
    // The service stops answering.
    rec._proxy.StopScreencastAsync = () => new Promise(() => {});
    const t0 = GLib.get_monotonic_time();
    t.ext().record();
    for (let i = 0; i < 400 && !['card', 'idle'].includes(rec._state); i++)
        await t.wait(100);
    t.log(`card after ${((GLib.get_monotonic_time() - t0) / 1e6).toFixed(1)} s: state=${rec._state}`);
    await t.wait(1500);
    t.log(`service running after: ${await owner()} pill=${!!t.Main.panel.statusArea['ricingscreenshots-recording']}`);
    await t.key(Clutter.KEY_Return, [], 1500);
    t.log(`saved: state=${rec._state} ${t.notifications().join(' | ')}`);
}
