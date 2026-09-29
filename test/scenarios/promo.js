// Screenshots for the README and extensions.gnome.org: the card after a
// capture, and the editor with a few marks. Run with RSTEST_WALL set to
// test/promo-wallpaper.png.
export default async function (t) {
    const {Clutter} = t;
    await t.wait(1000);
    t.launch('org.gnome.Calculator.desktop');
    await t.wait(2500);
    const win = global.get_window_actors().map(a => a.meta_window).find(w => w.get_wm_class() === 'org.gnome.Calculator');
    win?.move_frame(true, 760, 260);
    await t.move(1500, 900);
    await t.wait(1500);
    const f = win.get_frame_rect();
    t.ext().capture();
    await t.wait(600);
    await t.drag(f.x - 40, f.y - 30, f.x + f.width + 40, f.y + f.height + 30, 20, 600);
    await t.wait(1200);
    await t.move(f.x + f.width + 400, f.y + 200);
    await t.shot('promo-card');
    await t.key(Clutter.KEY_Return);
    await t.wait(400);
    const ed = t.session()._editor;
    ed.setColor('rgb(255,59,48)');
    ed.setWidth(4);
    ed.setTool('rect');
    await t.drag(f.x + 20, f.y + 60, f.x + f.width - 20, f.y + 160, 10);
    ed.setTool('arrow');
    ed.setColor('rgb(255,214,10)');
    await t.drag(f.x + f.width + 30, f.y + f.height - 20, f.x + f.width - 60, f.y + f.height - 90, 12);
    ed.setTool('marker');
    ed.setColor('rgb(52,199,89)');
    await t.drag(f.x + 30, f.y + f.height - 120, f.x + 200, f.y + f.height - 120, 12);
    ed.setTool('pen');
    ed.setColor('rgb(255,59,48)');
    await t.move(f.x + f.width + 300, f.y + 300);
    await t.wait(400);
    await t.shot('promo-editor');
    await t.key(Clutter.KEY_Escape);
}
