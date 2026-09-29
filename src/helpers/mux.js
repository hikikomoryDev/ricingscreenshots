// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

// Puts the recorded sound next to the recorded picture in one file, without
// re-encoding either, in its own process. Started by recorder.js:
//   gjs -m mux.js <video.webm|mp4> <audio.mka> <audio delay, µs> <output>
// The delay places the sound where it started relative to the first frame.
// Exits 0 when the output is complete.
import GLib from 'gi://GLib';
import Gst from 'gi://Gst?version=1.0';

Gst.init(null);
const [video, audio, delay, out] = ARGV;
const mp4 = video.endsWith('.mp4');
const loop = new GLib.MainLoop(null, false);
let status = 1;

const pipeline = Gst.parse_launch(
    `filesrc name=vsrc ! ${mp4 ? 'qtdemux' : 'matroskademux'} name=vdemux ` +
    `vdemux.video_0 ! queue ! ${mp4 ? 'h264parse ! ' : ''}mux.video_%u ` +
    'filesrc name=asrc ! matroskademux name=ademux ' +
    'ademux.audio_0 ! identity name=shift ! queue ! mux.audio_%u ' +
    `${mp4 ? 'mp4mux' : 'webmmux'} name=mux ! filesink name=sink`);
pipeline.get_by_name('vsrc').location = video;
pipeline.get_by_name('asrc').location = audio;
pipeline.get_by_name('sink').location = out;
// Shifts the sound's running time; the muxer places it by that.
pipeline.get_by_name('shift').get_static_pad('src').set_offset(Math.max(0, Number(delay)) * 1000);

const bus = pipeline.get_bus();
bus.add_signal_watch();
bus.connect('message', (_b, message) => {
    if (message.type === Gst.MessageType.EOS) {
        status = 0;
        loop.quit();
    } else if (message.type === Gst.MessageType.ERROR) {
        const [error] = message.parse_error();
        printerr(`mux: ${error.message}`);
        loop.quit();
    }
});
// A long recording remuxes in seconds; a minute means something is wrong.
GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 600, () => {
    printerr('mux: timed out');
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
pipeline.set_state(Gst.State.PLAYING);
loop.run();
pipeline.set_state(Gst.State.NULL);
imports.system.exit(status);
