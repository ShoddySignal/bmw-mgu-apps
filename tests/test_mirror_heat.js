'use strict';

const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { Diag, replyTo } = require('../kit/runtime/diag');
const { MirrorDiag, DIDS, decodeRead } = require('../apps/mirror_heat/protocol');
const { Monitor } = require('../apps/mirror_heat/monitor');
const { Parking, isParked, stage } = require('../apps/mirror_heat/parking');
const { labels, bindUi } = require('../apps/mirror_heat/ui');
const { signals } = require('../apps/mirror_heat/app.json');

const OFF = [0x62, 0xd3, 0x2d, 0, 0, 0, 0];
const ON = [0x62, 0xd3, 0x2d, 0, 1, 0, 100];
const WRITE = [0x2e, 0xd3, 0x2d, 0, 4, 0, 30];

function harness(options = {}) {
    let clock = 0;
    const calls = [];
    const log = { info() {}, warn() {} };
    const link = new Diag({}, log);
    let heatedUntil = 0;
    link.available = true;
    let parked = true;
    let beforeNative;
    let nsc = 19;
    let monitor;
    const data = {
        [DIDS.ident]: [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80],
        [DIDS.protection]: [0x62, 0xd3, 0x21, 0, 0],
        [DIDS.equipment]: [0x62, 0xe4, 0x50, 0, 0, 0, 1, 0, 0xfd, 0xfd, 0xfd]
    };
    link.p = {};
    link.quiet = true;
    link.signals.call = async (proxy, method, frame, timeout, before) => {
        assert.equal(method, 'sendTasuRequest');
        assert.equal(frame.sourceAddress, 0xf2);
        assert.equal(frame.targetAddress, 0x40);
        assert.equal(frame.subroutineID, 0);
        if (beforeNative) beforeNative(frame);
        before();
        const bytes = [frame.serviceID, ...frame.udsData];
        calls.push(bytes);
        let reply;
        if (frame.serviceID === 0x2e) {
            assert.deepEqual(bytes, WRITE);
            if (options.refuse) reply = [0x7f, 0x2e, 0x22];
            else {
                heatedUntil = clock + 30000;
                nsc = 20;
                reply = options.loseAck ? [0x6e, 0xd3, 0x2d, 0xff] : [0x6e, 0xd3, 0x2d];
            }
        } else {
            const did = bytes[1] * 256 + bytes[2];
            if (did === DIDS.heating) reply = clock < heatedUntil ? ON : OFF;
            else if (did === DIDS.counter) reply = [0x62, 0x23, 5, 0, nsc];
            else reply = data[did];
        }
        link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x63, 0, 0, ...reply] });
        link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x40, 0, 0, ...reply] });
        return 'NO_ERROR';
    };
    const diag = new MirrorDiag(link, replyTo);
    monitor = new Monitor(diag, () => parked, () => clock, async (ms) => {
        clock += ms;
        if (options.hideWhileWaiting) monitor.setVisible(false);
    });
    monitor.setVisible(true);
    return {
        monitor, diag, data, calls,
        before(fn) { beforeNative = fn; },
        unpark() { parked = false; },
        advance(ms) { clock += ms; },
        writes() { return calls.filter((bytes) => bytes[0] === 0x2e); }
    };
}

test('decodes exact BDC response bodies, keeps unknown flags distinct from off, and reports NRC', () => {
    assert.deepEqual(decodeRead(DIDS.heating, ON), { on: true, demand: 100 });
    assert.deepEqual(decodeRead(DIDS.heating, OFF), { on: false, demand: 0 });
    assert.deepEqual(decodeRead(DIDS.heating, [0x62, 0xd3, 0x2d, 0xff, 0xff, 0xff, 0xff]),
        { on: null, demand: null });
    assert.equal(decodeRead(DIDS.ident, [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80, 0]), '0F2680');
    assert.equal(decodeRead(DIDS.protection, [0x62, 0xd3, 0x21, 0, 1]), true);
    assert.equal(decodeRead(DIDS.equipment, [0x62, 0xe4, 0x50, 0, 0, 0, 1, 0, 0xfd, 0xfd, 0xfd]), true);
    assert.equal(decodeRead(DIDS.counter, [0x62, 0x23, 5, 0x12, 0x34]), 0x1234);
    assert.throws(() => decodeRead(DIDS.heating, ON.slice(0, 5)), /Unexpected reply/);
    assert.throws(() => decodeRead(DIDS.protection, [0x7f, 0x22, 0x31]), /NRC 31/);
    assert.throws(() => decodeRead(DIDS.counter, [0x62, 0x23, 6, 0, 1]), /Unexpected reply/);
});

test('parking requires fresh exact zero and unambiguous P selector state', () => {
    const p = { value: 'P', at: 5000 };
    const zero = { value: 0, at: 5000 };
    assert.equal(stage(1, false), 'P');
    assert.equal(stage(3, true), 'P');
    assert.equal(stage(4, true), null);
    assert.equal(stage('NP', true), null);
    assert.equal(stage(undefined, false), null);
    assert.equal(isParked(zero, p, null, 6000), true);
    assert.equal(isParked(zero, null, p, 6000), true);
    assert.equal(isParked(zero, p, null, 8001), false);
    assert.equal(isParked(zero, null, null, 6000), false);
    assert.equal(isParked({ value: 1, at: 5000 }, p, null, 6000), false);
    assert.equal(isParked(zero, p, { value: 'D', at: 5400 }, 6000), false);
});

test('gearbox fields use notifications while speed is polled', async () => {
    const speed = 'de.bmw.infotainment.vehicle.Vehicle2';
    const gearbox = 'de.bmw.infrastructure.VehicleInformation';
    const watches = {};
    const link = { available: true };
    const parking = new Parking({
        watch: async (iface, instance, handlers, log, options) => {
            watches[iface] = { handlers, options };
            return link;
        }
    }, {}, () => 1000);

    await parking.init();
    assert.equal(signals[gearbox].statusGearboxDrive, 's');
    assert.equal(signals[gearbox].DataPowerTrain2, 's');
    assert.equal(watches[gearbox].options.pollMs, undefined);
    assert.equal(watches[speed].options.pollMs, 1200);
    watches[speed].handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
    assert.equal(parking.parked(), false);
    watches[gearbox].handlers.DataPowerTrain2({ statusGearSelectionDrive: 'P' });
    assert.equal(parking.parked(), true);
    watches[gearbox].options.onAvailable(false);
    assert.equal(parking.parked(), false);
});

test('reads a snapshot without writing and sends exactly one fixed write with a timed observation', async () => {
    const h = harness();
    await h.monitor.refresh();
    assert.match(labels(h.monitor).HEATING, /OFF/);
    assert.deepEqual(h.writes(), []);
    h.monitor.review();
    await Promise.all([h.monitor.confirm(), h.monitor.confirm()]);
    assert.deepEqual(h.writes(), [WRITE]);
    assert.equal(h.monitor.write.raw, '6E D3 2D');
    assert.equal(h.monitor.observed, true);
    assert.match(h.monitor.message, /BDC reported heating/);
    assert.deepEqual(h.monitor.samples.heating.value, { on: false, demand: 0 });
    assert.equal(h.monitor.samples.counter.value, 20);
    assert(h.calls.every((bytes) => bytes[0] === 0x22 || bytes[0] === 0x2e));
});

test('rejects writes for a different ECU schema, protection, or missing confirmation', async () => {
    const h = harness();
    await h.monitor.confirm();
    await h.monitor.run(true);
    h.monitor.review();
    h.advance(15001);
    await h.monitor.confirm();
    assert.equal(h.calls.length, 0);

    h.data[DIDS.ident] = [0x62, 0xf1, 0x50, 0x0f, 0x25, 0x90];
    h.monitor.review();
    await h.monitor.confirm();
    assert.match(h.monitor.message, /Different BDC/);
    assert.deepEqual(h.calls, [[0x22, 0xf1, 0x50]]);
    h.data[DIDS.ident] = [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80];
    h.data[DIDS.protection] = [0x62, 0xd3, 0x21, 0, 1];
    h.monitor.review();
    await h.monitor.confirm();
    assert.match(h.monitor.message, /Protection is active/);
    assert.deepEqual(h.writes(), []);
});

test('checks Park, visibility and confirmation again at the native send boundary', async () => {
    for (const invalidate of [h => h.unpark(), h => h.monitor.setVisible(false), h => h.advance(15001)]) {
        const h = harness();
        h.before((frame) => { if (frame.serviceID === 0x2e) invalidate(h); });
        h.monitor.review();
        await h.monitor.confirm();
        assert.deepEqual(h.writes(), []);
        assert.equal(h.monitor.write.attempted, false);
    }
});

test('observes an ambiguous acknowledgement, shows refusal, and stays single-shot when the page is left', async () => {
    const uncertain = harness({ loseAck: true });
    uncertain.monitor.review();
    await uncertain.monitor.confirm();
    assert.deepEqual(uncertain.writes(), [WRITE]);
    assert.match(uncertain.monitor.message, /acknowledgement was unavailable/);
    const refused = harness({ refuse: true });
    refused.monitor.review();
    await refused.monitor.confirm();
    assert.match(refused.monitor.message, /NRC 22/);
    assert.equal(refused.monitor.remaining(), 0);
    const closed = harness({ hideWhileWaiting: true });
    closed.monitor.review();
    await closed.monitor.confirm();
    const sent = closed.calls.length;
    assert.match(closed.monitor.message, /Observation stopped/);
    closed.monitor.setVisible(true);
    closed.monitor.review();
    await closed.monitor.confirm();
    assert.equal(closed.calls.length, sent);
    assert.deepEqual(closed.writes(), [WRITE]);
});

test('transport rejects alternate writes, chassis services and changed test duration', async () => {
    const h = harness();
    for (const [sid, data] of [[0x2e, [0xd3, 0x2d, 0, 4, 0, 31]], [0x2e, [0xd3, 0x2d, 0, 0, 0, 0]], [0x10, [3]], [0x22, [0xf1, 0x90]]]) {
        await assert.rejects(h.diag.request(sid, data, () => {}), /Request blocked/);
    }
    await assert.rejects(h.diag.activate(), /Request blocked/);
    assert.equal(h.calls.length, 0);
});

test('RHMI buttons use review and confirmation and cancel an armed test on focus loss', async () => {
    const h = harness();
    const click = {}, text = {}, visible = {};
    let focused = true;
    let focusChanged;
    const app = new EventEmitter();
    bindUi({
        app, log: { warn: (e) => assert.fail(e) },
        ui: {
            onClick: (key, fn) => { click[key] = fn; },
            onVisible() {},
            onFocus: (fn) => { focusChanged = fn; },
            isVisible: (screen) => screen === 'MAIN',
            hasFocus: () => focused,
            text: async (key, value) => { text[key] = value; },
            visible: async (key, value) => { visible[key] = value; },
            enabled: async () => {}
        }
    }, h.monitor);
    try {
        await click.REVIEW();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(visible.CONFIRM, true);
        focused = false;
        focusChanged();
        await click.CONFIRM();
        assert.deepEqual(h.writes(), []);
        focused = true;
        focusChanged();
        await click.REVIEW();
        await click.CONFIRM();
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(h.writes(), [WRITE]);
        assert.match(text.STATUS, /Test elapsed/);
        assert.equal(visible.CONFIRM, false);
    } finally {
        app.emit('shutdown');
    }
});
