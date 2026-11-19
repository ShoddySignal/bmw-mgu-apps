'use strict';

const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const Car = require('../kit/runtime/car');
const app = require('../apps/parking_camera_assist/app.json');
const { FIELDS, SOURCES, CAMERAS, MODES, PERSPECTIVES, CLIENT_TYPES, SIMPLE,
    selection, freeView, direct, menuOpen } = require('../apps/parking_camera_assist/plans');
const { Probe } = require('../apps/parking_camera_assist/probe');
const { bindUi } = require('../apps/parking_camera_assist/ui');

async function harness(options = {}) {
    let clock = 100;
    const watchers = {};
    const calls = [];
    const logs = [];
    const writes = [];
    const log = {
        info(line) {
            if (line.startsWith('camera-assist ')) logs.push(JSON.parse(line.slice('camera-assist '.length)));
        },
        warn() {},
    };
    const signals = {
        async watch(iface, instance, receive, logger, opts) {
            const key = Object.keys(SOURCES).find((name) => SOURCES[name].iface === iface);
            assert.equal(instance, '1');
            const link = { proxy: { key }, available: true, async shutdown() {} };
            watchers[key] = { receive, opts, link };
            opts.onAvailable(true);
            return link;
        },
        async on(proxy, event, callback) { watchers[proxy.key].receive[event] = callback; },
        async call(proxy, method, args, timeout, before) {
            if (options.before) options.before(probe, method);
            before();
            calls.push({ key: proxy.key, method, args });
            if (options.reply) return options.reply(probe, method, args);
            return undefined;
        },
    };
    const delay = async (ms) => {
        clock += ms;
        if (options.onDelay) options.onDelay(probe, ms);
    };
    const probe = new Probe(signals, log, Car.selectionOf, () => clock, delay);
    await probe.start();
    const emit = (source, field, value) => watchers[source].receive[field](value);
    const parked = () => {
        emit('speed', 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
        emit('gear', 'DataPowerTrain2', { statusGearSelectionDrive: 3 });
    };
    const ui = {
        screen: 'MAIN',
        handlers: {},
        onVisible() {},
        onFocus() {},
        hasFocus: () => true,
        isVisible: (screen) => ui.screen === screen,
        onClick: (name, handler) => { ui.handlers[name] = handler; },
        open: async (screen) => { ui.screen = screen; },
        text: async (key, value) => { writes.push([key, value]); },
        enabled: async () => {},
        visible: async () => {},
    };
    return { probe, emit, parked, calls, logs, ui, log, writes, advance: (ms) => { clock += ms; } };
}

const front = () => true;
const names = (h) => h.calls.map((step) => step.method);
const media = (probe, source, field, value) => probe.update(source, field, value);

test('manifest covers each request and subscribed field, including all eight free-camera presets', () => {
    for (const key of Object.keys(FIELDS)) {
        const signal = app.signals[SOURCES[key].iface];
        for (const field of FIELDS[key]) assert.match(signal[field], /s/);
        assert.equal(Object.values(signal).includes('w'), false);
    }

    const plans = Object.values(SIMPLE)
        .concat(MODES.flatMap((_, row) => [selection('mode', row, false), selection('mode', row, true)]))
        .concat(CAMERAS.flatMap((_, row) => [selection('camera', row, false), selection('camera', row, true)]))
        .concat(PERSPECTIVES.flatMap((_, row) => [direct(row, 0, 0, false), direct(row, 0, 0, true)]));
    for (const plan of plans) {
        const steps = [plan.build(true, 1)];
        if (plan.attach) steps.push(plan.attach(true));
        for (const { source, method } of steps) {
            assert.ok(app.signals[SOURCES[source].iface]._methods.includes(method), method);
        }
    }

    assert.deepEqual(CAMERAS.map(([name, value], row) => freeView(row) && value).filter(Boolean),
        [7, 8, 9, 10, 11, 12, 13, 14]);
    const options = { MODE_PICK: MODES.map((row) => row[2]), CAMERA_PICK: CAMERAS.map((row) => row[2]),
        RAW_PICK: PERSPECTIVES.map((row) => row[0]), CLIENT_PICK: CLIENT_TYPES.map((row) => row[2]) };
    for (const [, id, , rows] of app.screens.flatMap((screen) => screen.items).filter((item) => item[0] === 'dropdown')) {
        assert.deepEqual(rows, options[id]);
    }
});

test('a camera request requires fresh P and zero speed, rechecked when the native request is about to send', async () => {
    const h = await harness({
        before(probe) {
            probe.update('gear', 'statusGearboxDrive', { statusActualStageDrive: 'R' });
        },
    });
    await h.probe.run(SIMPLE.OPEN_MENU, false, front);
    assert.equal(h.calls.length, 0);
    h.parked();
    h.advance(4000);
    await h.probe.run(SIMPLE.OPEN_MENU, false, front);
    assert.match(h.probe.status, /Waiting for fresh vehicle speed/);
    h.parked();
    await h.probe.run(SIMPLE.OPEN_MENU, false, front);
    assert.equal(h.calls.length, 0);
    assert.match(h.probe.status, /Select P/);
    assert.ok(h.logs.some((line) => line.event === 'call-error' && line.sent === false));
});

test('the Assist route sends the Panorama mode with GPS activation false and logs dispatch separately from state', async () => {
    const h = await harness();
    h.parked();
    await h.probe.run(selection('mode', 1, true), true, front);
    assert.deepEqual(h.calls, [{ key: 'hmi', method: 'assistSelectCameraMode', args: { cameraMode: 7, activationPointReached: false } }]);
    assert.ok(h.logs.some((line) => line.event === 'dispatched' && line.methodId === '0x0016'));
    assert.ok(h.logs.some((line) => line.event === 'test-end' && line.state.hmi.values.selectedCameraMode === undefined));
});

test('chained requests wait for the factory state and continue after the native screen takes focus', async () => {
    let visible = true;
    const h = await harness({ reply(probe, method, args) {
        if (method === 'parkmenuRequestedByUser') {
            visible = false;
            probe.update('menu', 'requestParkmenu', { parkmenuRequest: 1, hmiVisibilityRequest: 1 });
        }
        if (method === 'hmiSelectCameraMode' && args.cameraMode === 'FREE_CAMERA') {
            visible = false;
            probe.update('hmi', 'selectedCameraMode', 3);
        }
    } });
    h.parked();
    await h.probe.run(menuOpen(1), false, () => visible);
    assert.deepEqual(names(h), ['parkmenuRequestedByUser', 'hmiSelectCameraMode']);

    visible = true;
    h.parked();
    await h.probe.run(freeView(14), false, () => visible);
    assert.deepEqual(h.calls.slice(2), [
        { key: 'hmi', method: 'hmiSelectCameraMode', args: { cameraMode: 'FREE_CAMERA' } },
        { key: 'hmi', method: 'hmiSelectCamera', args: { cameraSelection: 'FREE_CAMERA_8' } },
    ]);

    const missing = await harness();
    missing.parked();
    missing.emit('menu', 'requestParkmenu', { parkmenuRequest: 1, hmiVisibilityRequest: 1 });
    await missing.probe.run(menuOpen(0), false, front);
    assert.deepEqual(names(missing), ['parkmenuRequestedByUser']);
    assert.match(missing.probe.status, /No new parking menu visibility request observed/);
});

test('ICAM2 pairs a client cookie with its exact perspective request and releases it after a rejection', async () => {
    const h = await harness({ reply(probe, method) {
        if (method === 'clientAttach') return { cookie: 771 };
        if (method === 'changeState') throw new Error('NOT_OK');
    } });
    h.parked();
    await h.probe.run(direct(5, 7, 0, true), true, front);
    assert.deepEqual(h.calls, [
        { key: 'icam', method: 'clientAttach', args: { type: 1 } },
        { key: 'icam', method: 'changeState', args: { cookie: 771, desiredState: { application: 2, mode: 6, perspective: 7 } } },
        { key: 'icam', method: 'clientDetach', args: { cookie: 771 } },
    ]);
    assert.match(h.probe.status, /NOT_OK/);
});

test('a video player test stops its confirmed playback and leaves factory playback alone', async () => {
    const h = await harness({
        reply(probe, method) {
            if (method === 'startProtectedVideo') media(probe, 'parkPlayer', 'cameraPlayerState', 'VIDEO_ACTIVE');
        },
        onDelay(probe) {
            media(probe, 'speed', 'statusCarSpeed2', { speedVehicleCentreOfGravity: 0 });
            media(probe, 'gear', 'DataPowerTrain2', { statusGearSelectionDrive: 3 });
        },
    });
    h.parked();
    h.emit('parkPlayer', 'cameraPlayerState', 'VIDEO_ACTIVE');
    await h.probe.run(SIMPLE.VIDEO_PROTECTED, false, front);
    assert.deepEqual(names(h), []);
    h.emit('parkPlayer', 'cameraPlayerState', 'VIDEO_IDLE');
    await h.probe.run(SIMPLE.VIDEO_PROTECTED, false, front);
    assert.deepEqual(names(h), ['startProtectedVideo', 'stopVideo']);

    const moved = await harness({
        reply(probe, method) {
            if (method === 'startVideo') media(probe, 'das', 'dasVideoState', 2);
        },
        onDelay(probe) {
            media(probe, 'speed', 'statusCarSpeed2', { speedVehicleCentreOfGravity: 64 });
        },
    });
    moved.parked();
    moved.emit('das', 'dasVideoState', 0);
    await moved.probe.run(SIMPLE.VIDEO_DAS, false, front);
    assert.deepEqual(moved.calls, [{ key: 'das', method: 'startVideo', args: { watchdog: 'WD_ACTIVE' } }]);
    assert.ok(moved.logs.some((line) => line.event === 'video-stop-skipped' && line.reason === 'Vehicle is moving'));
});

test('live trace records state changes without sending anything, and the menu runs the selected probe after confirmation', async (t) => {
    const h = await harness();
    const host = { log: h.log, ui: h.ui, app: new EventEmitter() };
    bindUi(host, h.probe);
    t.after(() => host.app.emit('shutdown'));
    h.parked();
    await h.ui.handlers.TRACE();
    h.ui.screen = 'FACTORY_CAMERA';
    h.emit('hmi', 'selectedCamera', 7);
    h.emit('hmi', 'selectedCamera', 7);
    assert.equal(h.logs.filter((line) => line.event === 'signal' && line.field === 'selectedCamera').length, 1);
    assert.deepEqual(names(h), []);

    await h.ui.handlers.GO_MODES();
    await h.ui.handlers.MODE_PICK({ row: 1 });
    await h.ui.handlers.HMI_MODE();
    assert.equal(h.ui.screen, 'REVIEW');
    assert.ok(h.writes.some(([key, value]) => key === 'REVIEW_REQUEST' && value.includes('PANORAMAVIEW')));
    assert.deepEqual(names(h), []);
    await h.ui.handlers.RUN_NAMES();
    assert.deepEqual(h.calls, [{ key: 'hmi', method: 'hmiSelectCameraMode', args: { cameraMode: 'PANORAMAVIEW' } }]);
});
