'use strict';

const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const diagKit = require('../kit/runtime/diag');
const { MirrorDiag, DIDS, decodeRead } = require('../apps/mirror_heat_check/protocol');
const { Monitor } = require('../apps/mirror_heat_check/monitor');
const { Parking, isParked, stage } = require('../apps/mirror_heat_check/parking');
const { labels, bindUi } = require('../apps/mirror_heat_check/ui');
const { signals, screens } = require('../apps/mirror_heat_check/app.json');

const OFF = [0x62, 0xd3, 0x2d, 0, 0, 0, 0];
const ON = [0x62, 0xd3, 0x2d, 0, 1, 0, 100];
const WRITE = [0x2e, 0xd3, 0x2d, 0x00, 0x04, 0x00, 0xf0];
const FAULTS = [0x19, 0x02, 0x0c];

function harness(options = {}) {
    let clock = 0;
    const calls = [];
    const log = { info() {}, warn() {} };
    const link = new diagKit.Diag({}, log);
    let heatedUntil = 0;
    link.available = true;
    let parked = true;
    let beforeNative;
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
            assert.equal(monitor.remaining(), 240);
            if (options.hideBeforeWriteReply) monitor.setVisible(false);
            if (options.refuse) reply = [0x7f, 0x2e, 0x22];
            else {
                heatedUntil = clock + 240000;
                reply = options.loseAck ? [0x6e, 0xd3, 0x2d, 0xff] : [0x6e, 0xd3, 0x2d];
            }
        } else if (frame.serviceID === 0x19) {
            assert.deepEqual(bytes, FAULTS);
            link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0x59, 0x01, 0xff, 0, 0, 0] });
            reply = options.faultReply || [0x59, 0x02, 0xff];
        } else {
            const did = bytes[1] * 256 + bytes[2];
            if (did === DIDS.heating) reply = options.alreadyOn || clock < heatedUntil ? ON : OFF;
            else if (did === DIDS.counter) reply = [0x62, 0x23, 5, 0, 0];
            else reply = data[did];
        }
        link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x63, 0, 0, ...reply] });
        link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x40, 0, 0, ...reply] });
        return 'NO_ERROR';
    };
    const diag = new MirrorDiag(link, diagKit);
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
    assert.deepEqual(h.calls.at(-1), FAULTS);
    h.monitor.review();
    assert.match(h.monitor.message, /240 seconds/);
    await Promise.all([h.monitor.confirm(), h.monitor.confirm()]);
    assert.deepEqual(h.writes(), [WRITE]);
    assert.equal(h.monitor.remaining(), 0);
    const text = labels(h.monitor);
    assert.match(text.R_TEST, /Accepted · 6E D3 2D/);
    assert.match(text.BEFORE, /OFF · 0%/);
    assert.match(text.DURING, /ON · 100%/);
    assert.match(text.AFTER, /OFF · 0%/);
    assert.deepEqual(h.monitor.samples.heating.value, { on: false, demand: 0 });
    assert.equal(h.monitor.samples.counter.value, 0);
    assert.deepEqual(h.calls.at(-1), FAULTS);
});

test('keeps the BDC baseline when heat is already on and after a new status read', async () => {
    const h = harness({ alreadyOn: true });
    await h.monitor.refresh();
    assert.match(labels(h.monitor).HEATING, /ON/);
    assert.match(labels(h.monitor).R_TEST, /No test started/);
    h.monitor.review();
    await h.monitor.confirm();
    await h.monitor.refresh();
    const text = labels(h.monitor);
    assert.match(text.R_TEST, /Accepted · 6E D3 2D/);
    assert.match(text.BEFORE, /ON · 100%/);
    assert.match(text.DURING, /ON · 100%/);
    assert.match(text.AFTER, /ON · 100%/);
});

test('reports only pending or stored mirror DTCs and distinguishes incomplete or refused fault queries', async () => {
    const reply = [0x59, 0x02, 0xff,
        0x80, 0x42, 0x46, 0x09, 0xd9, 0x0d, 0x0d, 0x04, 0x80, 0x43, 0x41, 0x08,
        0x80, 0x42, 0x56, 0x20, 0x12, 0x34, 0x56, 0x09];
    const h = harness({ faultReply: reply });
    await h.monitor.refresh();
    const text = labels(h.monitor);
    assert.match(text.FAULT_STATUS, /3 matching codes/);
    assert.match(text.F_804246, /Left heater.*ACTIVE/);
    assert.match(text.F_D90D0D, /Right mirror missing on LIN.*PENDING/);
    assert.match(text.F_804341, /open circuit or short to positive.*STORED/);
    assert.equal(text.F_804256, undefined);
    assert.equal(text.F_123456, undefined);
    assert.deepEqual(h.writes(), []);

    for (const [faultReply, error] of [
        [[0x59, 0x02, 0xff, 0x80], 'Unexpected fault memory reply'],
        [[0x59, 0x02, 0x01], 'Fault status mask unavailable'],
        [[0x7f, 0x19, 0x11], 'NRC 11']
    ]) {
        const failed = harness({ faultReply });
        await failed.monitor.refresh();
        assert.equal(labels(failed.monitor).FAULT_STATUS, 'Mirror faults: Unavailable · ' + error);
    }
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
    assert.match(labels(h.monitor).R_TEST, /Not sent.*Protection is active/);
    assert.deepEqual(h.writes(), []);
});

test('checks Park, visibility and confirmation again at the native send boundary', async () => {
    for (const invalidate of [h => h.unpark(), h => h.monitor.setVisible(false), h => h.advance(15001)]) {
        const h = harness();
        h.before((frame) => { if (frame.serviceID === 0x2e) invalidate(h); });
        h.monitor.review();
        await h.monitor.confirm();
        assert.deepEqual(h.writes(), []);
        assert.match(labels(h.monitor).R_TEST, /Not sent/);
    }
});

test('observes an ambiguous acknowledgement, shows refusal, and stays single-shot when the page is left', async () => {
    const uncertain = harness({ loseAck: true });
    uncertain.monitor.review();
    await uncertain.monitor.confirm();
    assert.deepEqual(uncertain.writes(), [WRITE]);
    assert.match(uncertain.monitor.message, /acknowledgement was unavailable/);
    assert.match(labels(uncertain.monitor).R_TEST, /Unconfirmed/);
    const refused = harness({ refuse: true });
    refused.monitor.review();
    await refused.monitor.confirm();
    assert.match(refused.monitor.message, /NRC 22/);
    assert.match(labels(refused.monitor).R_TEST, /Declined · NRC 22 · 7F 2E 22/);
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

test('keeps the reply when Diagnostics is opened before the write acknowledgement arrives', async () => {
    const h = harness({ hideBeforeWriteReply: true });
    h.monitor.review();
    await h.monitor.confirm();
    assert.deepEqual(h.writes(), [WRITE]);
    assert.deepEqual(h.calls.at(-1), WRITE);
    assert.match(h.monitor.message, /Observation stopped/);
    assert.match(labels(h.monitor).R_TEST, /Accepted · 6E D3 2D/);
    assert.equal(labels(h.monitor).DURING, 'During test: —');
});

test('transport rejects alternate writes, chassis services and changed test duration', async () => {
    const h = harness();
    for (const [sid, data] of [[0x2e, [0xd3, 0x2d, 0, 4, 0, 30]], [0x2e, [0xd3, 0x2d, 0, 4, 0, 241]],
        [0x2e, [0xd3, 0x2d, 0, 0, 0, 0]],
        [0x10, [3]], [0x22, [0xf1, 0x90]], [0x19, [0x02, 0xff]], [0x14, [0xff, 0xff, 0xff]]]) {
        await assert.rejects(h.diag.request(sid, data, () => {}), /Request blocked/);
    }
    await assert.rejects(h.diag.activate(), /Request blocked/);
    assert.equal(h.calls.length, 0);
});

test('RHMI buttons use review and confirmation and cancel an armed test on focus loss', async () => {
    assert.equal(screens.find(({ name }) => name === 'DETAILS').items[0][1], 'R_TEST');
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
