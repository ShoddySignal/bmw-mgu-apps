'use strict';

const { strict: assert } = require('node:assert');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const diagKit = require('../kit/runtime/diag');
const { MirrorDiag, DIDS, decodeRead } = require('../apps/mirror_heat_check/protocol');
const { Monitor } = require('../apps/mirror_heat_check/monitor');
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
    let heaterOutput = 0;
    link.available = true;
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
            const seconds = (bytes[5] << 8) | bytes[6];
            assert.equal(monitor.remaining(), seconds);
            if (options.hideBeforeWriteReply) monitor.setVisible(false);
            if (options.refuse) reply = [0x7f, 0x2e, 0x22];
            else {
                heaterOutput = bytes[4] * 25;
                heatedUntil = clock + seconds * 1000;
                reply = options.loseAck ? [0x6e, 0xd3, 0x2d, 0xff] : [0x6e, 0xd3, 0x2d];
            }
        } else if (frame.serviceID === 0x19) {
            assert.deepEqual(bytes, FAULTS);
            link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x40, 0, 0, 0x59, 0x01, 0xff, 0, 0, 0] });
            reply = options.faultReply || [0x59, 0x02, 0xff];
        } else {
            const did = bytes[1] * 256 + bytes[2];
            if (did === DIDS.heating) {
                reply = clock < heatedUntil ? [...ON.slice(0, -1), heaterOutput] : options.alreadyOn ? ON : OFF;
                if (options.heatingReply) reply = options.heatingReply(reply, clock);
            }
            else if (did === DIDS.counter) reply = [0x62, 0x23, 5, 0, 0];
            else reply = data[did];
        }
        link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x63, 0, 0, ...reply] });
        link._onResponse({ udsResponse: [0, 0, 0, 0, 0, 0, 0x40, 0, 0, ...reply] });
        return 'NO_ERROR';
    };
    const diag = new MirrorDiag(link, diagKit);
    monitor = new Monitor(diag, () => clock, async (ms) => {
        clock += ms;
        if (options.hideWhileWaiting) monitor.setVisible(false);
    });
    monitor.setVisible(true);
    return {
        monitor, diag, data, calls, link,
        before(fn) { beforeNative = fn; },
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

test('reads a snapshot and sends one timed activation with TASU as its only signal dependency', async () => {
    assert.deepEqual(Object.keys(signals), ['com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu']);
    const h = harness();
    await h.monitor.refresh();
    assert.match(labels(h.monitor).HEATING, /OFF/);
    assert.deepEqual(h.writes(), []);
    assert.deepEqual(h.calls.at(-1), FAULTS);
    await Promise.all([h.monitor.start(100, 240), h.monitor.start(100, 240)]);
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
    await h.monitor.start(100, 240);
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

test('rejects writes for a different ECU schema, protection, or disabled heater coding', async () => {
    const h = harness();
    h.data[DIDS.ident] = [0x62, 0xf1, 0x50, 0x0f, 0x25, 0x90];
    await h.monitor.start(100, 240);
    assert.match(h.monitor.message, /Different BDC/);
    assert.deepEqual(h.calls, [[0x22, 0xf1, 0x50]]);
    h.data[DIDS.ident] = [0x62, 0xf1, 0x50, 0x0f, 0x26, 0x80];
    h.data[DIDS.protection] = [0x62, 0xd3, 0x21, 0, 1];
    await h.monitor.start(100, 240);
    assert.match(h.monitor.message, /Protection is active/);
    assert.match(labels(h.monitor).R_TEST, /Not sent.*Protection is active/);
    h.data[DIDS.protection] = [0x62, 0xd3, 0x21, 0, 0];
    h.data[DIDS.equipment][6] = 0;
    await h.monitor.start(100, 240);
    assert.match(h.monitor.message, /mirror heating is not coded/);
    assert.deepEqual(h.writes(), []);
});

test('checks visibility again at the native send boundary', async () => {
    const h = harness();
    h.before((frame) => { if (frame.serviceID === 0x2e) h.monitor.setVisible(false); });
    await h.monitor.start(100, 240);
    assert.deepEqual(h.writes(), []);
    assert.match(labels(h.monitor).R_TEST, /Not sent/);
});

test('observes an ambiguous acknowledgement, shows refusal, and stays single-shot when the page is left', async () => {
    const uncertain = harness({ loseAck: true });
    await uncertain.monitor.start(100, 240);
    assert.deepEqual(uncertain.writes(), [WRITE]);
    assert.match(uncertain.monitor.message, /acknowledgement was unavailable/);
    assert.match(labels(uncertain.monitor).R_TEST, /Unconfirmed/);
    const refused = harness({ refuse: true });
    await refused.monitor.start(100, 240);
    assert.match(refused.monitor.message, /NRC 22/);
    assert.match(labels(refused.monitor).R_TEST, /Declined · NRC 22 · 7F 2E 22/);
    assert.equal(refused.monitor.remaining(), 0);
    assert.equal(refused.monitor.lockUntil, 0);
    const closed = harness({ hideWhileWaiting: true });
    await closed.monitor.start(100, 240);
    assert.match(closed.monitor.message, /Observation stopped/);
    await closed.monitor.setVisible(true);
    const sent = closed.calls.length;
    await closed.monitor.start(25, 30);
    assert.equal(closed.calls.length, sent);
    assert.deepEqual(closed.writes(), [WRITE]);
});

test('refreshes on screen return and again when an interrupted test expires', async () => {
    for (const elapsed of [10000, 33000]) {
        const h = harness({ hideWhileWaiting: true });
        await h.monitor.start(50, 30);
        assert.match(labels(h.monitor).HEATING, /Unavailable/);
        assert.match(labels(h.monitor).DURING, /ON · 50%/);
        h.advance(elapsed);
        await h.monitor.setVisible(true);
        const returnedBeforeExpiry = elapsed < 30000;
        assert.match(labels(h.monitor).HEATING, returnedBeforeExpiry ? /ON · 50%/ : /OFF · 0%/);

        if (returnedBeforeExpiry) {
            h.advance(30000);
            await h.monitor.refreshIfPending();
            assert.match(labels(h.monitor).HEATING, /OFF · 0%/);
        }
        const count = h.calls.length;
        await h.monitor.refreshIfPending();
        assert.equal(h.calls.length, count);
        assert.deepEqual(h.writes(), [[0x2e, 0xd3, 0x2d, 0, 2, 0, 30]]);
    }
});

test('refreshes once after a TASU reconnect while an interrupted request is still unwinding', async () => {
    const h = harness();
    await h.monitor.refresh();
    assert.match(labels(h.monitor).HEATING, /OFF/);
    let reconnect = true;
    h.before((frame) => {
        if (!reconnect || frame.udsData[0] !== 0xe4) return;
        reconnect = false;
        h.link.available = false;
        h.monitor.disconnected();
        assert.match(labels(h.monitor).HEATING, /Unavailable/);
        h.link.available = true;
        assert.equal(h.monitor.refreshIfPending(), undefined);
    });
    const begin = h.calls.length;
    await h.monitor.refresh();
    assert.deepEqual(h.calls.slice(begin).filter((bytes) => bytes[1] === 0xf1), [[0x22, 0xf1, 0x50], [0x22, 0xf1, 0x50]]);
    assert.match(labels(h.monitor).HEATING, /OFF/);
    assert.deepEqual(h.writes(), []);
});

test('records the latest valid power during an accepted test', async () => {
    const h = harness({
        alreadyOn: true,
        heatingReply(reply, time) {
            if (time < 2000) return ON;
            if (time === 28000) return [...ON.slice(0, -1), 0xff];
            return reply;
        }
    });
    await h.monitor.start(50, 30);
    const text = labels(h.monitor);
    assert.match(text.BEFORE, /ON · 100%/);
    assert.match(text.DURING, /ON · 50%/);
    assert.match(text.AFTER, /ON · 100%/);
});

test('keeps the reply when Diagnostics is opened before the write acknowledgement arrives', async () => {
    const h = harness({ hideBeforeWriteReply: true });
    await h.monitor.start(100, 240);
    assert.deepEqual(h.writes(), [WRITE]);
    assert.deepEqual(h.calls.at(-1), WRITE);
    assert.match(h.monitor.message, /Observation stopped/);
    assert.match(labels(h.monitor).R_TEST, /Accepted · 6E D3 2D/);
    assert.equal(labels(h.monitor).DURING, 'During test: —');
});

test('transport rejects other services, heater power steps and durations outside the test range', async () => {
    const h = harness();
    for (const [sid, data] of [[0x2e, [0xd3, 0x2d, 0, 4, 0, 241]], [0x2e, [0xd3, 0x2d, 0, 4, 1, 0]],
        [0x2e, [0xd3, 0x2d, 0, 4, 0, 0]], [0x2e, [0xd3, 0x2d, 0, 0, 0, 30]],
        [0x2e, [0xd3, 0x2d, 0, 5, 0, 30]], [0x2e, [0xd3, 0x2d, 1, 2, 0, 30]], [0x2e, [0xd3, 0x21, 0, 2, 0, 30]],
        [0x10, [3]], [0x22, [0xf1, 0x90]], [0x19, [0x02, 0xff]], [0x14, [0xff, 0xff, 0xff]]]) {
        await assert.rejects(h.diag.request(sid, data, () => {}), /Request blocked/);
    }
    await assert.rejects(h.diag.activate(100, 240), /Request blocked/);
    await assert.rejects(h.diag.activate(40, 60, () => {}), /Invalid heater test settings/);
    await assert.rejects(h.diag.activate(50, 60.5, () => {}), /Invalid heater test settings/);
    assert.equal(h.calls.length, 0);
});

test('RHMI reads status and starts tests directly using the selected duration and power rows', async () => {
    assert.equal(screens.find(({ name }) => name === 'DETAILS').items[0][1], 'R_TEST');
    const items = screens.find(({ name }) => name === 'MAIN').items;
    assert.deepEqual(items.find(([, name]) => name === 'DURATION')[3], ['4 min', '3 min', '2 min', '1 min', '30 s']);
    assert.deepEqual(items.find(([, name]) => name === 'POWER')[3], ['100%', '75%', '50%', '25%']);
    const h = harness();
    const click = {}, text = {};
    let screen = 'MAIN';
    let focused = true;
    let visibilityChanged;
    let focusChanged;
    const app = new EventEmitter();
    bindUi({
        app, log: { warn: (e) => assert.fail(e) },
        ui: {
            onClick: (key, fn) => { click[key] = fn; },
            onVisible: (fn) => { visibilityChanged = fn; },
            onFocus: (fn) => { focusChanged = fn; },
            isVisible: (name) => name === screen,
            hasFocus: () => focused,
            text: async (key, value) => { text[key] = value; },
            visible: async () => {},
            enabled: async () => {},
            open: (name) => {
                screen = name;
                return visibilityChanged();
            }
        }
    }, h.monitor);
    try {
        await click.READ();
        assert.match(text.HEATING, /OFF · 0% requested/);
        assert.deepEqual(h.writes(), []);

        focused = false;
        focusChanged();
        await click.START();
        assert.deepEqual(h.writes(), []);
        focused = true;
        focusChanged();

        await click.START();
        assert.deepEqual(h.writes(), [WRITE]);
        for (const [row, seconds, powerRow, step] of [
            [1, 180, 1, 3], [2, 120, 3, 1], [3, 60, 2, 2], [4, 30, 0, 4]
        ]) {
            await click.DURATION({ row });
            await click.POWER({ row: powerRow });
            await click.POWER({ row: 99 });
            await click.START();
            assert.deepEqual(h.writes().at(-1), [0x2e, 0xd3, 0x2d, 0, step, 0, seconds]);
            assert.match(labels(h.monitor).DURING, new RegExp('ON · ' + step * 25 + '%'));
            assert.equal(labels(h.monitor).TEST_SETTINGS, 'Last test settings: ' + seconds + ' s · ' + step * 25 + '%');
            assert.match(text.STATUS, /Test elapsed/);
        }
        assert.equal(h.writes().length, 5);

        const previousCalls = h.calls.length;
        await click.DETAILS_OPEN();
        assert.equal(h.calls.length, previousCalls);
        screen = 'MAIN';
        await visibilityChanged();
        assert.deepEqual(h.calls[previousCalls], [0x22, 0xf1, 0x50]);
        assert.match(text.HEATING, /OFF · 0% requested/);
        assert.equal(h.writes().length, 5);
    } finally {
        app.emit('shutdown');
    }
});
