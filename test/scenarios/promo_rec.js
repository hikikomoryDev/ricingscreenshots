// Screenshots of recording: the Rec card after picking an area, a recording
// in progress (frame, Stop, top bar pill) and the save card. Run with
// RSTEST_WALL set to test/promo-wallpaper.png.
export default async function (t) {
    const {Clutter} = t;
    await t.wait(1000);
    t.launch('org.gnome.clocks.desktop');
    await t.wait(2500);
    const win = global.get_window_actors().map(a => a.meta_window).find(w => w.get_wm_class() === 'org.gnome.clocks');
    win?.move_resize_frame(true, 560, 200, 800, 560);
    await t.wait(1200);
    const f = win.get_frame_rect();
    const rec = t.ext()._recorder;
    t.ext().record();
    await t.wait(600);
    await t.drag(f.x - 30, f.y - 30, f.x + f.width + 30, f.y + f.height + 30, 20, 600);
    await t.move(f.x + f.width + 250, f.y + 120, 400);
    await t.wait(800);
    await t.shot('promo-rec-armed');
    await t.key(Clutter.KEY_Return, [], 200);
    for (let i = 0; i < 200 && !rec.recording; i++)
        await t.wait(20);
    for (let i = 0; i < 8; i++)
        await t.move(f.x + 200 + i * 40, f.y + 250, 300);
    await t.move(f.x + f.width + 250, f.y + 120, 300);
    await t.wait(1500);
    await t.shot('promo-recording');
    t.ext().record();
    for (let i = 0; i < 100 && rec._state !== 'card'; i++)
        await t.wait(50);
    await t.wait(600);
    await t.shot('promo-rec-save');
    await t.key(Clutter.KEY_Return, [], 600);
}
