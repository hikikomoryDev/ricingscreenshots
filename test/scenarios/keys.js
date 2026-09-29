// Out of the box Print opens RicingScreenshots; with the switch off, or with
// the extension off, it is GNOME's again. GNOME's settings stay untouched.
export default async function (t) {
    const {Clutter, Gio, Main} = t;
    await t.wait(1000);
    const gnome = new Gio.Settings({schema_id: 'org.gnome.shell.keybindings'});
    const gnomeOpen = () => Main.screenshotUI.visible;
    const print = async label => {
        await t.key(Clutter.KEY_Print, [], 900);
        t.log(`${label}: ours=${!!t.session()} gnome=${gnomeOpen()}`);
        await t.key(Clutter.KEY_Escape, [], 700);
    };
    t.log(`GNOME key before: ${gnome.get_strv('show-screenshot-ui')}`);
    await print('default Print');
    await t.key(Clutter.KEY_s, [Clutter.KEY_Shift_L, Clutter.KEY_Super_L], 900);
    t.log(`Shift+Super+S: ours=${!!t.session()}`);
    await t.key(Clutter.KEY_Escape, [], 500);
    t.settings().set_boolean('take-print', false);
    await t.wait(300);
    await print('switch off');
    t.settings().set_boolean('take-print', true);
    await t.wait(300);
    await print('switch on');
    const ext = t.ext();
    ext.disable();
    await t.wait(300);
    await print('extension off');
    ext.enable();
    await t.wait(300);
    await print('extension on');
    t.log(`GNOME key after: ${gnome.get_strv('show-screenshot-ui')}`);
}
