// Shortcut → drag an area → clipboard, notification, card; Close.
export default async function (t) {
    await t.wait(800);
    t.clearClipboard();
    t.ext().capture();
    await t.wait(600);
    await t.shot('01-frozen');
    await t.drag(400, 300, 900, 620);
    await t.wait(700);
    await t.shot('02-card');
    const img = await t.clipboard('clip');
    t.log(`clipboard: ${img ? `${img.width}x${img.height}` : 'none'}`);
    t.log(`notifications: ${t.notifications().join(' | ')}`);
    t.log(`session open: ${!!t.session()} mode=${t.session()?._mode}`);
    await t.key(t.Clutter.KEY_Escape);
    t.log(`after Esc: session open=${!!t.session()}`);
}
