// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

// Records the system sound (the default output's monitor, never the
// microphone) to an Opus file in Matroska, in its own process so the shell never
// runs GStreamer. Started by recorder.js:
//   gjs -m audio.js <output.mka>
// Prints "FIRST <µs wall clock>" once sound is flowing, "DONE" when
// the file is closed. A line on stdin, or stdin closing, stops it cleanly.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import Gst from 'gi://Gst?version=1.0';

Gst.init(null);
const [out] = ARGV;
const loop = new GLib.MainLoop(null, false);
// print() flushes each line, so the extension sees it at once.
const print_ = line => print(line);

const pipeline = Gst.parse_launch(
    'pulsesrc name=src device=@DEFAULT_MONITOR@ ! queue ! audioconvert ! audioresample ! ' +
    'audio/x-raw,rate=48000,channels=2 ! opusenc bitrate=128000 ! matroskamux ! filesink name=sink');
pipeline.get_by_name('sink').location = out;
const source = pipeline.get_by_name('src');

let stopping = false;
const stop = () => {
    if (stopping)
        return;
    stopping = true;
    pipeline.send_event(Gst.Event.new_eos());
    // Never hang: whatever happens, give up after five seconds.
    GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        print_('DONE timeout');
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
};

const bus = pipeline.get_bus();
bus.add_signal_watch();
// Everything here runs on the main loop: GJS can't take callbacks from
// GStreamer's own threads (a pad probe would crash it).
let first = true;
bus.connect('message', (_b, message) => {
    if (first && message.type === Gst.MessageType.STATE_CHANGED && message.src === source) {
        const [, state] = message.parse_state_changed();
        if (state === Gst.State.PLAYING) {
            first = false;
            print_(`FIRST ${GLib.get_real_time()}`);
        }
    } else if (message.type === Gst.MessageType.EOS) {
        print_('DONE');
        loop.quit();
    } else if (message.type === Gst.MessageType.ERROR) {
        const [error] = message.parse_error();
        print_(`ERROR ${error.message}`);
        loop.quit();
    }
});

const stdin = new Gio.DataInputStream({base_stream: new GioUnix.InputStream({fd: 0})});
const readLine = () => stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (s, res) => {
    try {
        s.read_line_finish_utf8(res);
    } catch {
    }
    stop();
});
readLine();

pipeline.set_state(Gst.State.PLAYING);
loop.run();
pipeline.set_state(Gst.State.NULL);
