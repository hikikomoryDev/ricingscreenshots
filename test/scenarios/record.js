// Super+V → pick an area on the live screen → record with system sound →
// Super+V stops → card → Save to Videos; then again with "without sound".
// Super+M still opens the notification list.
export default async function (t) {
    const {Clutter, GLib, Gio, Main} = t;
    await t.wait(1000);
    t.launch('org.gnome.clocks.desktop');
    await t.wait(2500);
    const rec = t.ext()._recorder;
    const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
    const list = () => {
        const names = [];
        const e = Gio.File.new_for_path(dir).enumerate_children('standard::name,standard::size', 0, null);
        for (let info; (info = e.next_file(null));)
            names.push(info.get_name());
        return names.sort();
    };
    const take = async (label, mute) => {
        await t.key(Clutter.KEY_v, [Clutter.KEY_Super_L], 700);
        t.log(`${label}: picking=${!!t.session()}`);
        await t.drag(500, 250, 1301, 751);
        for (let i = 0; i < 200 && !rec.recording; i++)
            await t.wait(50);
        t.log(`  recording=${rec.recording} sound=${rec._take?.sound} ext=${rec._take?.ext}`);
        for (let i = 0; i < 12; i++)
            await t.move(600 + i * 50, 400 + (i % 3) * 60, 250);
        if (label === 'first')
            await t.shot('02-recording');
        await t.key(Clutter.KEY_v, [Clutter.KEY_Super_L], 1500);
        t.log(`  after stop: state=${rec._state}`);
        if (mute)
            await t.key(Clutter.KEY_m, [], 300);
        await t.shot(`03-card-${label}`);
        await t.key(Clutter.KEY_Return, [], 800);
        t.log(`  saved: state=${rec._state} Videos: ${list().join(', ')}`);
    };
    await take('first', false);
    await take('muted', true);
    t.log(`notifications: ${t.notifications().join(' | ')}`);
    t.log(`encoder remembered: ${t.settings().get_string('record-pipeline')}`);
    await t.key(Clutter.KEY_m, [Clutter.KEY_Super_L], 800);
    t.log(`Super+M: calendar open=${Main.panel.statusArea.dateMenu.menu.isOpen}`);
    await t.key(Clutter.KEY_Escape, [], 400);
}
