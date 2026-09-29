// Memory over many capture → Close rounds, with and without notifications.
export default async function (t) {
    const {GLib, Clutter} = t;
    const System = (await import('system')).default;
    const read = f => new TextDecoder().decode(GLib.file_get_contents(f)[1]);
    const rss = () => Number(/VmRSS:\s+(\d+)/.exec(read('/proc/self/status'))[1]) / 1024;
    const until = async cond => {
        for (let i = 0; i < 500 && !cond(); i++)
            await t.wait(10);
    };
    const settle = async () => {
        for (let i = 0; i < 3; i++) {
            System.gc();
            await t.wait(400);
        }
        return rss().toFixed(0);
    };
    const {width: W, height: H} = global.stage;
    await t.wait(2000);
    for (const notify of [false, true]) {
        t.settings().set_boolean('show-notification', notify);
        const marks = [await settle()];
        for (let round = 0; round < 4; round++) {
            for (let i = 0; i < 15; i++) {
                t.ext().capture();
                await until(() => t.session()?._layer);
                await t.move(W * 0.1, H * 0.1, 30);
                await t.press();
                await t.move(W * 0.8, H * 0.8, 30);
                await t.release();
                await until(() => t.session()?._mode === 'ask');
                await t.key(Clutter.KEY_Escape, [], 60);
            }
            marks.push(await settle());
        }
        t.log(`notifications ${notify ? 'on ' : 'off'}: RSS MB after 0/15/30/45/60 captures: ${marks.join(' → ')}`);
        const queued = t.Main.messageTray._notificationQueue?.length;
        t.log(`  queued notifications: ${queued}`);
        await t.wait(1000);
    }
}
