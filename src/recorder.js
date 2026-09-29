// SPDX-License-Identifier: GPL-2.0-or-later
// SPDX-FileCopyrightText: 2026 hikikomoriDev

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {loadInterfaceXML} from 'resource:///org/gnome/shell/misc/fileUtils.js';

import {placeNear} from './place.js';
import {css, parseColor, textOn} from './util.js';

Gio._promisify(Gio.File.prototype, 'copy_async');
Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');

const ScreencastProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.gnome.Shell.Screencast'));
const FRAME = 2;
// Space between the area and its frame: at fractional scales (125 %) the
// recorded area is rounded out to whole pixels and would catch a frame
// drawn right against it.
const FRAME_GAP = 4;
const RED = 'rgb(255,59,48)';

// Past this, a stop that hangs is ended by force so a recording never runs
// on unseen (it once kept going for an hour).
const STOP_TIMEOUT = 15;

Gio._promisify(Gio.Subprocess.prototype, 'wait_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');

function gjs() {
    return GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
}

function sleep(seconds) {
    return new Promise(resolve => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        resolve('timeout');
        return GLib.SOURCE_REMOVE;
    }));
}

// Ends GNOME's recording service when it no longer answers, and resolves
// once it is gone, so what it wrote so far can still be kept. D-Bus starts
// a fresh one the next time.
function killScreencastService() {
    return new Promise(resolve => Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus',
        'org.freedesktop.DBus', 'GetConnectionUnixProcessID', new GLib.Variant('(s)', ['org.gnome.Shell.Screencast']),
        new GLib.VariantType('(u)'), Gio.DBusCallFlags.NONE, -1, null, async (c, res) => {
            try {
                const [pid] = c.call_finish(res).deepUnpack();
                console.warn(`RicingScreenshots: recording service ${pid} did not stop, ending it`);
                await Gio.Subprocess.new(['kill', String(pid)], Gio.SubprocessFlags.NONE).wait_async(null);
                for (let i = 0; i < 20 && GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS); i++)
                    await sleepMs(100);
            } catch (e) {
                logError(e, 'RicingScreenshots: ending the recording service');
            }
            resolve();
        }));
}

// GNOME's recorder notes a pipeline as "crashed" when it starts one and
// clears the note when it stops cleanly. Ending it by force would leave the
// note, and GNOME would skip that pipeline from then on (with no other one,
// all recording breaks, GNOME's own included), so the note is put back as
// it was before the recording.
const BLOCKLIST = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'gnome-shell-screencast-pipeline-blocklist']);

async function readBlocklist() {
    try {
        const [contents] = await Gio.File.new_for_path(BLOCKLIST).load_contents_async(null);
        return contents;
    } catch {
        return null;
    }
}

async function restoreBlocklist(contents) {
    const file = Gio.File.new_for_path(BLOCKLIST);
    try {
        if (contents?.length) {
            await file.replace_contents_async(contents, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } else {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
        }
    } catch {
    }
}

function sleepMs(ms) {
    return new Promise(done => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        done();
        return GLib.SOURCE_REMOVE;
    }));
}

// The system sound, recorded by helpers/audio.js in its own process (the
// helpers are run with gjs, not imported, so GStreamer never loads into
// the shell): GNOME
// films the picture, this adds what you hear. Nothing here can hang the
// recording; at worst the video is saved without sound.
class SoundRecorder {
    constructor(helper, file) {
        this.file = file;
        this.firstUs = 0;
        this.failed = false;
        this._proc = Gio.Subprocess.new([gjs(), '-m', helper, file.get_path()],
            Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._readLines(new Gio.DataInputStream({base_stream: this._proc.get_stdout_pipe()}));
    }

    async _readLines(stream) {
        try {
            for (;;) {
                // GNOME Shell may have promisified this already, returning
                // bytes instead of text.
                const [raw] = await stream.read_line_async(GLib.PRIORITY_DEFAULT, null);
                if (raw === null)
                    return;
                const line = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
                if (line.startsWith('FIRST '))
                    this.firstUs = Number(line.slice(6));
                else if (line.startsWith('ERROR'))
                    this.failed = true;
            }
        } catch {
        }
    }

    async stop() {
        try {
            const stdin = this._proc.get_stdin_pipe();
            stdin.write_all(new TextEncoder().encode('stop\n'), null);
            stdin.close(null);
        } catch {
        }
        const result = await Promise.race([this._proc.wait_async(null), sleep(8)]);
        if (result === 'timeout')
            this._proc.force_exit();
    }

    get ok() {
        return !this.failed && this.firstUs > 0 && sizeOf(this.file) > 0;
    }
}

function videosDir() {
    return GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir();
}

function stamp() {
    return GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
}

function formatTime(seconds) {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
    if (bytes < 1024 * 1024)
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function sizeOf(file) {
    try {
        return file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
    } catch {
        return 0;
    }
}

function remove(file) {
    try {
        file?.delete(null);
    } catch {
    }
}

// A free name in dir: "Recording 2026-09-29 17-40-12.webm", then " (2)"...
function freeFile(dir, base, ext) {
    for (let i = 1; ; i++) {
        const name = i === 1 ? `${base}.${ext}` : `${base} (${i}).${ext}`;
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, name]));
        if (!file.query_exists(null))
            return file;
    }
}

let notificationSource = null;
function notify(title, body, file) {
    if (!notificationSource) {
        notificationSource = new MessageTray.Source({
            title: 'RicingScreenshots',
            iconName: 'screencast-recorded-symbolic',
        });
        notificationSource.connect('destroy', () => (notificationSource = null));
        Main.messageTray.add(notificationSource);
    }
    const notification = new MessageTray.Notification({source: notificationSource, title, body});
    if (file) {
        const launch = target => {
            try {
                Gio.app_info_launch_default_for_uri(target.get_uri(), global.create_app_launch_context(0, -1));
            } catch (e) {
                logError(e, 'RicingScreenshots: could not open the recording');
            }
            Main.overview.hide();
            Main.panel.closeCalendar();
        };
        notification.connect('activated', () => launch(file));
        notification.addAction('Show in Files', () => launch(file.get_parent()));
    }
    notificationSource.addNotification(notification);
}

// The red pill with the running time in the top bar; a click stops.
const RecordingIndicator = GObject.registerClass(
class RicingScreenshotsRecordingIndicator extends PanelMenu.Button {
    _init(onStop) {
        super._init(0.5, 'Stop recording', true);
        // GNOME's own recording pill, so it looks like the system one.
        this.add_style_class_name('screen-recording-indicator');
        const box = new St.BoxLayout();
        this._label = new St.Label({text: '0:00', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._label);
        box.add_child(new St.Icon({icon_name: 'screencast-stop-symbolic', style_class: 'system-status-icon'}));
        this.add_child(box);
        const click = new Clutter.ClickGesture();
        click.set_recognize_on_press(true);
        click.connect('recognize', () => onStop());
        this.add_action(click);
    }

    setSeconds(seconds) {
        this._label.text = formatTime(seconds);
    }
});

// Full-screen modal layer for the save card; clicks beside it do nothing,
// so a recording is never thrown away by accident.
const CardLayer = GObject.registerClass(
class RicingScreenshotsCardLayer extends St.Widget {
    _init(onKey) {
        super._init({reactive: true, can_focus: true});
        this._onKey = onKey;
        this.add_constraint(new Clutter.BindConstraint({
            source: global.stage,
            coordinate: Clutter.BindCoordinate.ALL,
        }));
    }

    vfunc_key_press_event(event) {
        return this._onKey(event);
    }
});

export class Recorder {
    constructor(settings, path) {
        this._settings = settings;
        this._helpers = `${path}/helpers`;
        this._state = 'idle';
        this._muted = false;
    }

    // Starting, recording, stopping, waiting for a save decision or saving.
    get busy() {
        return this._state !== 'idle';
    }

    get recording() {
        return this._state === 'recording';
    }

    // Built asynchronously: a synchronous proxy would freeze the whole shell
    // while D-Bus starts the recording service.
    _getProxy() {
        this._proxyPromise ??= new Promise((resolve, reject) => {
            const proxy = new ScreencastProxy(Gio.DBus.session,
                'org.gnome.Shell.Screencast', '/org/gnome/Shell/Screencast',
                (_p, error) => {
                    if (error) {
                        this._proxyPromise = null;
                        reject(error);
                        return;
                    }
                    // The first start of the service can take a while.
                    proxy.set_default_timeout(60 * 1000);
                    this._proxy = proxy;
                    this._errorId = proxy.connectSignal('Error', (_q, _s, [name, message]) => {
                        console.error(`RicingScreenshots: recording failed: ${name} ${message}`);
                        if (this._state === 'recording')
                            this._finish(true).catch(e => logError(e));
                    });
                    resolve(proxy);
                }, null, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
        });
        return this._proxyPromise;
    }

    async start(rect) {
        if (this._state !== 'idle')
            return;
        this._state = 'starting';
        this._rect = rect;
        const options = {
            'draw-cursor': new GLib.Variant('b', this._settings.get_boolean('record-cursor')),
            'framerate': new GLib.Variant('i', 30),
        };
        // Let the picker's layer go away before the first frame.
        await new Promise(resolve => GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        this._blocklist = await readBlocklist();
        const base = GLib.build_filenamev([videosDir(),
            `.ricingscreenshots-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`]);
        try {
            // GNOME's own recorder, as it is: it picks the encoder (hardware
            // H.264 where there is one) and its stop is well proven.
            const [ok, path] = await (await this._getProxy()).ScreencastAreaAsync(
                rect.x, rect.y, rect.w, rect.h, base, options);
            if (!ok)
                throw new Error('the screencast service said no');
            const video = Gio.File.new_for_path(path);
            this._take = {video, ext: video.get_basename().split('.').pop(), startUs: GLib.get_real_time(), sound: null};
        } catch (e) {
            logError(e, 'RicingScreenshots: could not start recording');
            this._state = 'idle';
            notify('Recording failed to start', e.message ?? String(e));
            return;
        }
        try {
            this._take.sound = new SoundRecorder(`${this._helpers}/audio.js`,
                Gio.File.new_for_path(`${base}-sound.mka`));
        } catch (e) {
            logError(e, 'RicingScreenshots: no system sound for this recording');
        }
        console.log(`RicingScreenshots: recording ${rect.w}x${rect.h} ${this._take.ext}, sound ${!!this._take.sound}`);
        if (this._state !== 'starting') {
            // Stopped (or turned off) while starting: nothing worth keeping.
            await this._stopEverything();
            this._dropTake();
            this._state = 'idle';
            return;
        }
        this._state = 'recording';
        this._seconds = 0;
        this._showFrame(rect);
        this._indicator = new RecordingIndicator(() => this.stop());
        Main.panel.addToStatusArea('ricingscreenshots-recording', this._indicator, 0, 'right');
        this._showStopButton(rect);
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._seconds++;
            this._indicator?.setSeconds(this._seconds);
            if (this._stopLabel)
                this._stopLabel.text = `Stop · ${formatTime(this._seconds)}`;
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Stop by the area, outside it so it never shows in the video; when the
    // area leaves no room around it, the top bar pill and the shortcut do.
    _showStopButton(rect) {
        const button = new St.Button({style_class: 'rs-stop', can_focus: true, accessible_name: 'Stop recording'});
        const box = new St.BoxLayout({style_class: 'rs-stop-box'});
        box.add_child(new St.Widget({style_class: 'rs-stop-square', y_align: Clutter.ActorAlign.CENTER}));
        this._stopLabel = new St.Label({text: 'Stop · 0:00', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(this._stopLabel);
        button.child = box;
        button.connect('clicked', () => this.stop().catch(e => logError(e)));
        Main.layoutManager.addTopChrome(button);
        if (!placeNear(button, rect, 10))
            button.hide();
        this._stopButton = button;
    }

    // A thin red frame a little outside the area, so it is never in the video.
    _showFrame(rect) {
        const out = FRAME + FRAME_GAP;
        this._frame = new St.Widget({
            style: `border: ${FRAME}px solid ${RED};`,
            reactive: false,
            x: rect.x - out,
            y: rect.y - out,
            width: rect.w + 2 * out,
            height: rect.h + 2 * out,
        });
        Main.layoutManager.uiGroup.add_child(this._frame);
    }

    async stop() {
        if (this._state === 'starting') {
            this._state = 'cancelled';
            return;
        }
        if (this._state !== 'recording')
            return;
        await this._finish(false);
    }

    // Stops the picture and the sound. A service that doesn't answer within
    // STOP_TIMEOUT seconds is ended, so nothing keeps recording in secret.
    async _stopEverything(serviceStopped = false) {
        const picture = serviceStopped ? Promise.resolve() : (async () => {
            try {
                const proxy = await this._getProxy();
                const result = await Promise.race([proxy.StopScreencastAsync(), sleep(STOP_TIMEOUT)]);
                if (result === 'timeout') {
                    await killScreencastService();
                    await restoreBlocklist(this._blocklist);
                }
            } catch (e) {
                logError(e, 'RicingScreenshots: stopping the recording');
                await killScreencastService();
                await restoreBlocklist(this._blocklist);
            }
        })();
        await Promise.all([picture, this._take?.sound?.stop()]);
    }

    _clearRecordingUi() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
        this._indicator?.destroy();
        this._indicator = null;
        this._frame?.destroy();
        this._frame = null;
        this._stopButton?.destroy();
        this._stopButton = null;
        this._stopLabel = null;
    }

    _dropTake() {
        remove(this._take?.video);
        remove(this._take?.sound?.file);
        this._take = null;
    }

    async _finish(failed) {
        this._state = 'stopping';
        this._clearRecordingUi();
        await this._stopEverything(failed);
        if (!this._take?.video.query_exists(null) || sizeOf(this._take.video) === 0) {
            this._dropTake();
            this._state = 'idle';
            notify('Recording failed', 'Nothing was saved');
            return;
        }
        const {sound, startUs} = this._take;
        if (sound && !sound.ok) {
            remove(sound.file);
            this._take.sound = null;
        }
        // Where the sound starts relative to the first frame.
        this._take.delayUs = this._take.sound ? Math.max(0, sound.firstUs - startUs) : 0;
        this._muted = false;
        if (this._disabled) {
            this._saveToVideos();
            return;
        }
        this._showCard();
    }

    _showCard() {
        this._state = 'card';
        const accent = parseColor(this._settings.get_string('accent-color'));
        this._layer = new CardLayer(event => this._onCardKey(event));
        Main.layoutManager.screenshotUIGroup.add_child(this._layer);
        Main.layoutManager.screenshotUIGroup.show();

        const card = new St.BoxLayout({
            style_class: 'rs-card rs-save-card',
            reactive: true,
            orientation: Clutter.Orientation.VERTICAL,
        });
        card.add_child(new St.Label({text: 'Recording stopped', style_class: 'rs-card-title'}));
        card.add_child(new St.Label({
            text: `${formatTime(this._seconds)} · ${formatSize(sizeOf(this._take.video))}` +
                (this._take.sound ? '' : ' · no sound'),
            style_class: 'rs-card-info',
        }));
        if (this._take.sound) {
            // Sound stays unless switched off here, before choosing where.
            const icon = new St.Icon({icon_size: 16});
            const label = new St.Label({y_align: Clutter.ActorAlign.CENTER});
            const box = new St.BoxLayout({style_class: 'rs-sound'});
            box.add_child(icon);
            box.add_child(label);
            const sound = new St.Button({child: box, toggle_mode: true, x_align: Clutter.ActorAlign.START, style_class: 'rs-sound-button'});
            const sync = () => {
                this._muted = sound.checked;
                icon.icon_name = this._muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic';
                label.text = this._muted ? 'Without sound' : 'With system sound';
                box.style = this._muted ? 'color: #ff6b61;' : null;
            };
            sound.checked = this._muted;
            sound.connect('notify::checked', sync);
            sync();
            this._soundButton = sound;
            card.add_child(sound);
        }
        const buttons = new St.BoxLayout({style_class: 'rs-card-buttons'});
        const save = new St.Button({
            style_class: 'rs-card-button rs-card-edit',
            label: 'Save to Videos',
            style: `background-color: ${css(accent)}; color: ${textOn(accent)};`,
        });
        save.connect('clicked', () => this._saveToVideos());
        const saveAs = new St.Button({style_class: 'rs-card-button', label: 'Save as…'});
        saveAs.connect('clicked', () => this._saveAs());
        const discard = new St.Button({style_class: 'rs-card-button rs-card-discard', label: 'Discard'});
        discard.connect('clicked', () => this._discard());
        buttons.add_child(save);
        buttons.add_child(saveAs);
        buttons.add_child(discard);
        card.add_child(buttons);
        this._layer.add_child(card);
        placeNear(card, this._rect);
        this._card = card;
        this._grab = Main.pushModal(this._layer, {actionMode: Shell.ActionMode.POPUP});
    }

    _closeCard() {
        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }
        this._layer?.destroy();
        this._layer = null;
        this._card = null;
        this._soundButton = null;
    }

    _onCardKey(event) {
        const key = event.get_key_symbol();
        if (key === Clutter.KEY_Return || key === Clutter.KEY_KP_Enter) {
            this._saveToVideos();
            return Clutter.EVENT_STOP;
        }
        if (key === Clutter.KEY_m && this._soundButton) {
            this._soundButton.checked = !this._soundButton.checked;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Writes the final file: the picture with the sound joined in by
    // helpers/mux.js (no re-encoding), or the picture alone when muted.
    // Falls back to the picture alone if joining fails.
    async _write(target) {
        const {video, sound, delayUs} = this._take;
        let joined = false;
        if (sound && !this._muted) {
            try {
                const proc = Gio.Subprocess.new([gjs(), '-m', `${this._helpers}/mux.js`,
                    video.get_path(), sound.file.get_path(), String(delayUs), target.get_path()],
                Gio.SubprocessFlags.STDERR_SILENCE);
                await proc.wait_async(null);
                joined = proc.get_successful() && sizeOf(target) > 0;
            } catch (e) {
                logError(e, 'RicingScreenshots: joining the sound');
            }
            if (!joined)
                remove(target);
        }
        if (joined) {
            remove(video);
        } else {
            try {
                // A rename when it stays on the same disk...
                video.move(target, Gio.FileCopyFlags.OVERWRITE | Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE, null, null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED))
                    throw e;
                // ...otherwise a copy that doesn't block the desktop.
                await video.copy_async(target, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
                await video.delete_async(GLib.PRIORITY_DEFAULT, null);
            }
        }
        remove(sound?.file);
        return sound && !this._muted && !joined ? 'the sound could not be added' : null;
    }

    async _save(target, shownAs) {
        this._state = 'saving';
        try {
            const problem = await this._write(target);
            notify('Recording saved', problem ? `${shownAs} (${problem})` : shownAs, target);
            console.log(`RicingScreenshots: saved ${target.get_path()}${problem ? `, ${problem}` : ''}`);
            this._take = null;
            this._state = 'idle';
            return true;
        } catch (e) {
            logError(e, 'RicingScreenshots: saving the recording');
            notify('Could not save the recording', e.message);
            return false;
        }
    }

    async _saveToVideos() {
        this._closeCard();
        const target = freeFile(videosDir(), `Recording ${stamp()}`, this._take.ext);
        if (!await this._save(target, `Videos/${target.get_basename()}`))
            this._state = 'idle';
    }

    async _saveAs() {
        this._closeCard();
        this._state = 'choosing';
        let uri = null;
        try {
            uri = await chooseSaveFile(`Recording ${stamp()}.${this._take.ext}`, videosDir());
        } catch (e) {
            logError(e, 'RicingScreenshots: file chooser');
            notify('Could not open the file chooser', e.message);
        }
        if (this._disabled) {
            await this._saveToVideos();
            return;
        }
        if (!uri) {
            // Cancelled: ask again rather than lose the video.
            this._showCard();
            return;
        }
        const target = Gio.File.new_for_uri(uri);
        if (!await this._save(target, target.get_path() ?? uri))
            this._showCard();
    }

    _discard() {
        this._closeCard();
        this._dropTake();
        this._state = 'idle';
    }

    // Turning off (the lock screen does too) never loses a recording: it is
    // stopped and kept in Videos.
    destroy() {
        this._disabled = true;
        switch (this._state) {
        case 'starting':
            this._state = 'cancelled';
            break;
        case 'recording':
            this._finish(false).catch(e => logError(e));
            break;
        case 'card':
            this._saveToVideos().catch(e => logError(e));
            break;
        }
        if (this._proxy && this._errorId)
            this._proxy.disconnectSignal(this._errorId);
    }
}

// Asks where to save through the desktop's file chooser portal; resolves to
// the chosen URI, or null when cancelled.
function chooseSaveFile(name, folder) {
    return new Promise((resolve, reject) => {
        const bus = Gio.DBus.session;
        const token = `ricingscreenshots${GLib.random_int()}`;
        const sender = bus.get_unique_name().slice(1).replaceAll('.', '_');
        const handle = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
        const id = bus.signal_subscribe('org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request', 'Response', handle, null, Gio.DBusSignalFlags.NONE,
            (_c, _s, _p, _i, _n, params) => {
                bus.signal_unsubscribe(id);
                const [code, results] = params.deepUnpack();
                const uris = results.uris?.deepUnpack() ?? [];
                resolve(code === 0 && uris.length ? uris[0] : null);
            });
        const options = {
            'handle_token': new GLib.Variant('s', token),
            'current_name': new GLib.Variant('s', name),
            'current_folder': new GLib.Variant('ay', new TextEncoder().encode(`${folder}\0`)),
            'modal': new GLib.Variant('b', true),
        };
        bus.call('org.freedesktop.portal.Desktop', '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.FileChooser', 'SaveFile',
            new GLib.Variant('(ssa{sv})', ['', 'Save recording', options]),
            // The call only waits for the portal to start, which can be slow
            // the first time; the answer itself comes later as a signal.
            new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, 60 * 1000, null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    bus.signal_unsubscribe(id);
                    reject(e);
                }
            });
    });
}
