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
Gio._promisify(Gio.File.prototype, 'delete_async');

const ScreencastProxy = Gio.DBusProxy.makeProxyWrapper(loadInterfaceXML('org.gnome.Shell.Screencast'));
const FRAME = 2;
const RED = 'rgb(255,59,48)';

// Encoders, best first. GNOME's recorder films the area and hands the
// frames to this chain; %T (threads) and %F (framerate) are filled in by it.
const MP4 = 'mp4mux fragment-duration=500 fragment-mode=first-moov-then-finalise';
const ENCODERS = [
    {id: 'h264-va', ext: 'mp4', mux: MP4, video: 'vapostproc ! vah264enc ! h264parse'},
    {
        id: 'h264-openh264', ext: 'mp4', mux: MP4,
        video: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=%T ! queue ! ' +
            'openh264enc deblocking=off background-detection=false complexity=low adaptive-quantization=false ' +
            'qp-max=26 qp-min=26 multi-thread=%T slice-mode=auto ! h264parse',
    },
    {
        id: 'vp8', ext: 'webm', mux: 'webmmux',
        video: 'videoconvert chroma-mode=none dither=none matrix-mode=output-only n-threads=%T ! queue ! ' +
            'vp8enc cpu-used=16 max-quantizer=17 deadline=1 keyframe-mode=disabled threads=%T ' +
            'static-threshold=1000 buffer-size=20000',
    },
];
// The system sound: what plays through the default output, no microphone.
const SYSTEM_SOUND = 'pulsesrc device=@DEFAULT_MONITOR@ do-timestamp=true ! queue ! audioconvert ! ' +
    'audioresample ! audio/x-raw,rate=48000,channels=2 ! opusenc bitrate=128000 ! queue';

// One encoding, two files: the video is split after the encoder into the
// file with sound (GNOME's recorder adds its filesink after the last
// element, the muxer) and a silent copy, so "without sound" at save time
// needs no re-encoding.
function pipelineFor(encoder, silentPath) {
    const quoted = silentPath.replaceAll('"', '\\"');
    return `${encoder.video} ! tee name=rsv ` +
        `rsv. ! queue ! rsmux. ` +
        `rsv. ! queue ! ${encoder.mux} ! filesink location="${quoted}" ` +
        `${SYSTEM_SOUND} ! rsmux. ` +
        `${encoder.mux} name=rsmux`;
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
    constructor(settings) {
        this._settings = settings;
        this._state = 'idle';
        this._muted = false;
    }

    // Starting, recording, stopping or waiting for a save decision.
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

    // Tries the encoders (the one that worked last time first), each with
    // the system sound; if none takes, records without sound as GNOME does.
    async _startService(rect, options) {
        const proxy = await this._getProxy();
        const dir = videosDir();
        const base = `.ricingscreenshots-${GLib.DateTime.new_now_local().format('%Y%m%d-%H%M%S')}`;
        const known = this._settings.get_string('record-pipeline');
        const order = [...ENCODERS].sort((a, b) => (b.id === known) - (a.id === known));
        for (const encoder of order) {
            const silent = Gio.File.new_for_path(GLib.build_filenamev([dir, `${base}-silent.${encoder.ext}`]));
            try {
                const [ok, path] = await proxy.ScreencastAreaAsync(rect.x, rect.y, rect.w, rect.h,
                    GLib.build_filenamev([dir, base]),
                    {...options, 'pipeline': new GLib.Variant('s', pipelineFor(encoder, silent.get_path()))});
                if (!ok)
                    throw new Error('refused');
                if (known !== encoder.id)
                    this._settings.set_string('record-pipeline', encoder.id);
                return {file: Gio.File.new_for_path(path), silent, ext: encoder.ext, sound: true};
            } catch (e) {
                console.log(`RicingScreenshots: encoder ${encoder.id} with sound did not start: ${e.message}`);
                remove(silent);
            }
        }
        const [ok, path] = await proxy.ScreencastAreaAsync(rect.x, rect.y, rect.w, rect.h,
            GLib.build_filenamev([dir, base]), options);
        if (!ok)
            throw new Error('the screencast service said no');
        const file = Gio.File.new_for_path(path);
        return {file, silent: null, ext: file.get_basename().split('.').pop(), sound: false};
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
        try {
            this._take = await this._startService(rect, options);
            console.log(`RicingScreenshots: recording ${rect.w}x${rect.h} ${this._take.ext}, sound ${this._take.sound}`);
        } catch (e) {
            logError(e, 'RicingScreenshots: could not start recording');
            this._state = 'idle';
            notify('Recording failed to start', e.message ?? String(e));
            return;
        }
        if (this._state !== 'starting') {
            // Stopped (or turned off) while starting: nothing worth keeping.
            await this._stopService();
            this._dropTake();
            this._state = 'idle';
            return;
        }
        this._state = 'recording';
        this._seconds = 0;
        this._showFrame(rect);
        this._indicator = new RecordingIndicator(() => this.stop());
        Main.panel.addToStatusArea('ricingscreenshots-recording', this._indicator, 0, 'right');
        this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            this._seconds++;
            this._indicator?.setSeconds(this._seconds);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // A thin red frame just outside the area, so it is never in the video.
    _showFrame(rect) {
        this._frame = new St.Widget({
            style: `border: ${FRAME}px solid ${RED};`,
            reactive: false,
            x: rect.x - FRAME,
            y: rect.y - FRAME,
            width: rect.w + 2 * FRAME,
            height: rect.h + 2 * FRAME,
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

    async _stopService() {
        try {
            await (await this._getProxy()).StopScreencastAsync();
        } catch (e) {
            logError(e, 'RicingScreenshots: stopping the recording');
        }
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
    }

    _dropTake() {
        remove(this._take?.file);
        remove(this._take?.silent);
        this._take = null;
    }

    async _finish(failed) {
        this._state = 'stopping';
        this._clearRecordingUi();
        if (!failed)
            await this._stopService();
        if (!this._take?.file.query_exists(null)) {
            this._dropTake();
            this._state = 'idle';
            notify('Recording failed', 'Nothing was saved');
            return;
        }
        if (this._take.silent && !this._take.silent.query_exists(null))
            this._take.silent = null;
        if (this._disabled) {
            this._saveToVideos();
            return;
        }
        this._muted = false;
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
            text: `${formatTime(this._seconds)} · ${formatSize(sizeOf(this._take.file))}` +
                (this._take.sound ? '' : ' · no sound'),
            style_class: 'rs-card-info',
        }));
        if (this._take.silent) {
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

    // The file to keep, per the sound switch; the other one goes.
    _pick() {
        const {file, silent} = this._take;
        if (this._muted && silent) {
            remove(file);
            return silent;
        }
        remove(silent);
        return file;
    }

    _saveToVideos() {
        this._closeCard();
        const source = this._pick();
        const target = freeFile(videosDir(), `Recording ${stamp()}`, this._take.ext);
        try {
            // Same folder: a rename, instant at any size.
            source.move(target, Gio.FileCopyFlags.NONE, null, null);
            notify('Recording saved', `Videos/${target.get_basename()}`, target);
            console.log(`RicingScreenshots: saved ${target.get_path()}`);
        } catch (e) {
            logError(e, 'RicingScreenshots: saving the recording');
            notify('Could not save the recording', e.message);
        }
        this._take = null;
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
            this._saveToVideos();
            return;
        }
        if (!uri) {
            // Cancelled: ask again rather than lose the video.
            this._showCard();
            return;
        }
        const source = this._pick();
        this._take = {...this._take, file: source, silent: null};
        const target = Gio.File.new_for_uri(uri);
        try {
            try {
                // A rename when it stays on the same disk...
                source.move(target, Gio.FileCopyFlags.OVERWRITE | Gio.FileCopyFlags.NO_FALLBACK_FOR_MOVE, null, null);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_SUPPORTED))
                    throw e;
                // ...otherwise a copy that doesn't block the desktop.
                await source.copy_async(target, Gio.FileCopyFlags.OVERWRITE, GLib.PRIORITY_DEFAULT, null, null);
                await source.delete_async(GLib.PRIORITY_DEFAULT, null);
            }
            notify('Recording saved', target.get_path() ?? uri, target);
            console.log(`RicingScreenshots: saved ${target.get_path()}`);
            this._take = null;
            this._state = 'idle';
        } catch (e) {
            logError(e, 'RicingScreenshots: saving the recording');
            notify('Could not save there', e.message);
            this._showCard();
        }
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
            this._saveToVideos();
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
            new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null, (c, res) => {
                try {
                    c.call_finish(res);
                } catch (e) {
                    bus.signal_unsubscribe(id);
                    reject(e);
                }
            });
    });
}
