// Capture → Edit → draw with every tool → crop → undo/redo → Copy.
export default async function (t) {
    const {Clutter} = t;
    await t.wait(800);
    t.ext().capture();
    await t.wait(600);
    await t.drag(400, 250, 1100, 700);
    await t.wait(600);
    const first = await t.clipboard('clip-first');
    t.log(`first capture: ${first.width}x${first.height}`);
    await t.key(Clutter.KEY_Return);
    await t.wait(400);
    t.log(`mode after Enter: ${t.session()?._mode}`);
    await t.shot('01-editor');

    const ed = t.session()._editor;
    ed.setTool('pen');
    await t.drag(450, 300, 650, 420, 20);
    ed.setTool('marker');
    ed.setColor('rgb(255,214,10)');
    await t.drag(460, 480, 800, 480, 12);
    ed.setTool('arrow');
    ed.setColor('rgb(10,132,255)');
    ed.setWidth(8);
    await t.drag(1000, 650, 800, 520, 10);
    ed.setTool('rect');
    ed.setColor('rgb(52,199,89)');
    ed.setWidth(4);
    await t.drag(700, 300, 1000, 440, 10);
    t.log(`shapes: ${ed.shapes.map(s => s.type).join(',')}`);
    await t.shot('02-drawn');

    await t.key(Clutter.KEY_z, [Clutter.KEY_Control_L]);
    t.log(`after undo: ${ed.shapes.length}`);
    await t.key(Clutter.KEY_z, [Clutter.KEY_Control_L, Clutter.KEY_Shift_L]);
    t.log(`after redo: ${ed.shapes.length}`);

    await t.key(Clutter.KEY_c);
    t.log(`tool after C: ${ed._tool}`);
    // Pull the left edge in by 100 and the bottom edge up by 50.
    await t.drag(400, 475, 500, 475, 10);
    await t.drag(750, 700, 750, 650, 10);
    const r = t.session().rect;
    t.log(`rect after crop: ${r.x},${r.y} ${r.w}x${r.h}`);
    await t.shot('03-cropped');

    await t.key(Clutter.KEY_Return);
    await t.wait(1200);
    const edited = await t.clipboard('clip-edited');
    t.log(`edited: ${edited ? `${edited.width}x${edited.height}` : 'none'} session open=${!!t.session()}`);
    t.log(`notifications: ${t.notifications().join(' | ')}`);
    // An untouched pixel must match the first capture exactly.
    const px = (pb, x, y) => {
        const d = pb.get_pixels();
        const i = y * pb.rowstride + x * pb.n_channels;
        return [d[i], d[i + 1], d[i + 2]].join(',');
    };
    t.log(`pixel check: first(${px(first, 650, 350)}) edited(${px(edited, 550, 350)})`);
    await t.shot('04-after');
}
