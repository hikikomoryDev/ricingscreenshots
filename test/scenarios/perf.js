// Cost of the extension: shell CPU while idle, time to freeze the screen and
// to copy, and memory after many captures and edits.
export default async function (t) {
    const {GLib, Clutter} = t;
    const System = (await import('system')).default;
    const read = f => new TextDecoder().decode(GLib.file_get_contents(f)[1]);
    const cpu = () => {
        const f = read('/proc/self/stat').split(') ')[1].split(' ');
        return (Number(f[11]) + Number(f[12])) * 10;
    };
    const rss = () => Number(/VmRSS:\s+(\d+)/.exec(read('/proc/self/status'))[1]) / 1024;
    const until = async (cond, limit = 5000) => {
        const t0 = GLib.get_monotonic_time();
        while (!cond() && GLib.get_monotonic_time() - t0 < limit * 1000)
            await t.wait(5);
        return (GLib.get_monotonic_time() - t0) / 1000;
    };
    const {width: W, height: H} = global.stage;
    await t.wait(2000);

    let c0 = cpu();
    await t.wait(10000);
    t.log(`idle 10 s: shell CPU ${((cpu() - c0) / 100).toFixed(2)} %`);

    System.gc();
    await t.wait(500);
    const m0 = rss();
    const opens = [], copies = [];
    for (let i = 0; i < 20; i++) {
        t.ext().capture();
        opens.push(await until(() => t.session()?._layer));
        await t.move(W * 0.2, H * 0.2, 40);
        await t.press();
        await t.move(W * 0.6, H * 0.6, 40);
        const t0 = GLib.get_monotonic_time();
        await t.release(Clutter.BUTTON_PRIMARY, 0);
        await until(() => t.session()?._mode === 'ask');
        copies.push((GLib.get_monotonic_time() - t0) / 1000);
        await t.key(Clutter.KEY_Escape, [], 150);
    }
    const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1].toFixed(0);
    t.log(`screen ${W}x${H}: freeze median ${med(opens)} ms, copy median ${med(copies)} ms`);
    for (let i = 0; i < 5; i++) {
        t.ext().capture();
        await until(() => t.session()?._layer);
        await t.drag(W * 0.2, H * 0.2, W * 0.7, H * 0.7, 6, 60);
        await until(() => t.session()?._mode === 'ask');
        await t.key(Clutter.KEY_Return, [], 200);
        await t.drag(W * 0.3, H * 0.3, W * 0.5, H * 0.5, 20, 300);
        c0 = cpu();
        await t.drag(W * 0.3, H * 0.5, W * 0.6, H * 0.35, 60, 1000);
        const drawCpu = (cpu() - c0) / 1.0;
        if (i === 0)
            t.log(`drawing a 1 s pen stroke: shell CPU ${(drawCpu / 10).toFixed(0)} % of one core`);
        await t.key(Clutter.KEY_Return, [], 200);
        await until(() => !t.session());
    }
    await t.wait(1000);
    System.gc();
    await t.wait(1500);
    System.gc();
    await t.wait(500);
    t.log(`memory: before ${m0.toFixed(0)} MB, after 20 captures + 5 edits ${rss().toFixed(0)} MB`);
    c0 = cpu();
    await t.wait(10000);
    t.log(`idle 10 s after: shell CPU ${((cpu() - c0) / 100).toFixed(2)} %`);
}
