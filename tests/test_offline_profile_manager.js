'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kit = require('../kit/runtime/diag');
const { ProfileDiag, decodeReply, loginRequest, renameRequest, piaRequest } = require('../apps/offline_profile_manager/diag');
const { decodeAccounts, decodeCreationResult, decodeIdentity } = require('../apps/offline_profile_manager/profiles');
const { Workflow } = require('../apps/offline_profile_manager/workflow');
const { Vehicle, stopped } = require('../apps/offline_profile_manager/vehicle');
const { start } = require('../apps/offline_profile_manager/ui');
const spec = require('../apps/offline_profile_manager/app.json');

const ident = [0x22, 0xf1, 0x50];
const list = [0x22, 0xe3, 0x33];
const create = [0x31, 1, 0xa1, 0x9a];
const result = [0x31, 3, 0xa1, 0x9a];
const user = 'USER001', added = 'NEW0002', guest = 'GUEST00';
const empty = Array.from(Buffer.from([user, 'Zoë', '', '', '', '', guest].join('\0') + '\0'));
const full = Array.from(Buffer.from([user, 'Zoë', added, 'TEST_NAME', '', '', guest].join('\0') + '\0'));
const listReply = (payload) => [0x62, 0xe3, 0x33].concat(payload);
const identReply = [0x62, 0xf1, 0x50, 0x0f, 0x25, 0xb0];
const routineReply = (status, id) => [0x71, 3, 0xa1, 0x9a, status].concat(id ? Array.from(Buffer.from(id + '\0')) : []);

class FakeSignals {
    constructor(exchange) {
        this.available = true;
        this.requests = [];
        this.exchange = exchange;
    }

    async proxy() { return {}; }
    async on(proxy, name, receive) {
        if (name === 'sendTasuResponse') this.receive = receive;
    }
    async onAvailable(proxy, handler) {
        this.availability = handler;
        handler(this.available);
    }
    async watch() { return { available: false }; }
    setAvailable(up) {
        this.available = up;
        this.availability(up);
    }
    frame(uds, ecu = 0x63) {
        this.receive({ errorCode: 'NO_ERROR', udsResponse: [0, 0, 0, 0, 0, 0, ecu, 0, 0].concat(uds) });
    }

    async call(proxy, method, value, timeout, before) {
        if (this.beforeCall) this.beforeCall(value.serviceID);
        if (before) before();
        assert.equal(method, 'sendTasuRequest');
        assert.equal(value.targetAddress, 0x63);
        const bytes = [value.serviceID].concat(Array.from(value.udsData));
        this.requests.push(bytes);
        const reply = await this.exchange(bytes, this);
        if (Array.isArray(reply)) this.frame(reply);
        return typeof reply === 'string' ? reply : 'NO_ERROR';
    }
}

async function harness(exchange, overrides = {}) {
    const signal = new FakeSignals((bytes, s) => {
        if (bytes.join() === ident.join()) return overrides.identity || identReply;
        return exchange(bytes, s);
    });
    const messages = [];
    const transport = new kit.Diag(signal, {
        info: (line) => messages.push(line), warn: (line) => messages.push(line)
    });
    transport.quiet = true;
    transport.busyLog = false;
    await transport.init();
    const diag = new ProfileDiag(transport, kit.replyTo);
    const state = { speedKnown: true, parked: true, enabled: true, active: user, visible: true };
    const vehicle = {
        stationary: () => state.speedKnown && state.parked,
        activeAccount: async () => state.active ? { id: state.active } : null,
        stillActive: (x) => x.id === state.active
    };
    let time = 0;
    const version = { version: 'test-firmware', variantId: 'test-variant' };
    const stages = [];
    const workflow = new Workflow(diag, vehicle, {
        writeEnabled: () => state.enabled,
        visible: () => state.visible,
        firmware: () => version,
        verified: [{ index: '0F25B0', version: version.version, variantId: version.variantId, actions: ['create', 'login', 'rename'] }],
        changed: () => stages.push(workflow.state),
        wait: async (ms) => { time += ms; },
        now: () => time,
        ...overrides.options
    });
    transport.on('available', (up) => { if (!up) workflow.disconnected(); });
    return { signal, diag, workflow, state, stages, messages, version };
}

test('PRG account format: fixed field order, UTF-8 names, empty slots and guest', () => {
    assert.deepEqual(decodeAccounts(empty), [
        { id: user, name: 'Zoë', slot: 1, type: null },
        { id: guest, name: 'Guest', slot: null, type: 'guest' }
    ]);
    assert.equal(decodeAccounts(full.slice(0, -1))[1].slot, 2);
    assert.deepEqual(decodeAccounts([0, 0, 0, 0, 0, 0]), []);
    assert.throws(() => decodeAccounts(empty.slice(0, 5)), { code: 'payload' });
    assert.throws(() => decodeAccounts(empty.concat(0)), { code: 'payload' });
    assert.throws(() => decodeAccounts([65, 0, 0xc0, 0, 0, 0, 0, 0, 0]), { code: 'payload' });
    assert.throws(() => decodeAccounts(Array.from(Buffer.from('A\0x\0A\0y\0\0\0\0'))), { code: 'payload' });
});

test('Identity and RRR decode fail closed on partial or unknown values', () => {
    assert.deepEqual(decodeIdentity([0x0f, 0x25, 0xb0]), { index: '0F25B0', isMgu: true });
    assert.equal(decodeIdentity([0x0f, 0x25, 0xb1]).isMgu, false);
    assert.throws(() => decodeIdentity([0x0f, 0x25]), { code: 'payload' });
    assert.deepEqual(decodeCreationResult([1]), { status: 1, id: null });
    assert.deepEqual(decodeCreationResult([2, 65, 0]), { status: 2, id: 'A' });
    assert.throws(() => decodeCreationResult([4]), { code: 'payload' });
    assert.throws(() => decodeCreationResult([2, 0, 65]), { code: 'payload' });
});

test('Exact account and PIA request bytes, no guessed padding', () => {
    assert.deepEqual(loginRequest(user), [0x2e, 0xe3, 0x34, 85, 83, 69, 82, 48, 48, 49]);
    assert.deepEqual(renameRequest('Test 1'), [0x2e, 0xe3, 0x35, 84, 101, 115, 116, 32, 49, 0]);
    assert.deepEqual(piaRequest(10, 2), [0x31, 1, 2, 8, 4, 10, 2]);
    assert.throws(() => loginRequest('SHORT'), { code: 'id' });
    assert.throws(() => loginRequest('A\0B0001'), { code: 'id' });
    assert.throws(() => renameRequest('Zoë'), { code: 'name' });
    assert.throws(() => piaRequest(15, 2), { code: 'argument' });
});

test('UDS decodes echo, NRC and response pending separately', () => {
    assert.deepEqual(decodeReply(create, [0x7f, 0x31, 0x78]), { pending: true });
    assert.throws(() => decodeReply(create, [0x7f, 0x31, 0x33]), { code: 'nrc', nrc: 0x33 });
    assert.throws(() => decodeReply(create, [0x7f, 0x31, 0x78, 0]), { code: 'payload' });
    assert.throws(() => decodeReply(list, [0x62, 0xe3]), { code: 'payload' });
    assert.throws(() => decodeReply(list, [0x62, 0xe3, 0x34]), { code: 'payload' });
});

test('Creates precisely one new account after RRR and list verification', async () => {
    let reading = 0, polling = 0;
    const h = await harness((bytes, signals) => {
        if (bytes[0] === 0x22) return listReply(reading++ < 2 ? empty : full);
        if (bytes[1] === 3) return routineReply(++polling === 1 ? 1 : 2, added);
        signals.frame([0x71, 1, 0xa1, 0x9a], 0x62);
        signals.frame([0x71, 1, 0xa1, 0x9b]);
        signals.frame([0x7f, 0x31, 0x78]);
        setImmediate(() => signals.frame([0x71, 1, 0xa1, 0x9a]));
    });
    assert.equal(await h.workflow.refresh(), true);
    assert.equal(await h.workflow.create(), true);
    assert.equal(h.workflow.detail.id, added);
    assert.ok(h.stages.indexOf('accepted') < h.stages.indexOf('confirmed'));
    assert.deepEqual(h.signal.requests, [ident, list, list, create, result, result, list]);
    assert.ok(h.messages.every((line) => !line.includes(user) && !line.includes(added)));
});

test('Creation is unconfirmed if the ECU finishes but the new ID is missing or mismatched', async () => {
    for (const response of [empty, full]) {
        let reading = 0;
        const h = await harness((bytes) => {
            if (bytes[0] === 0x22) return listReply(reading++ < 2 ? empty : response);
            return bytes[1] === 1 ? [0x71, 1, 0xa1, 0x9a] : routineReply(2, 'OTHER01');
        });
        await h.workflow.refresh();
        assert.equal(await h.workflow.create(), false);
        assert.equal(h.workflow.detail.code, 'createMissing');
        assert.equal(h.signal.requests.filter((b) => b[0] === 0x31 && b[1] === 1).length, 1);
        assert.equal(h.signal.requests.some((b) => b[0] === 0x2e), false);
    }
});

test('Activation requires an independent exact active-account match before rename', async () => {
    let activeName = 'TEST_NAME', change = false;
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(Array.from(Buffer.from([user, 'Zoë', added, activeName, '', '', guest].join('\0') + '\0')));
        if (bytes[2] === 0x34) {
            if (change) h.state.active = added;
            return [0x6e, 0xe3, 0x34];
        }
        activeName = 'My Driver';
        return [0x6e, 0xe3, 0x35];
    });
    await h.workflow.refresh();
    assert.equal(await h.workflow.rename(added, 'My Driver'), false);
    assert.equal(h.workflow.detail.code, 'active');
    assert.ok(h.signal.requests.every((b) => b[0] === 0x22));
    assert.equal(await h.workflow.login(added), false);
    assert.equal(h.workflow.detail.code, 'active');
    change = true;
    assert.equal(await h.workflow.login(added), true);
    assert.equal(await h.workflow.rename(added, 'My Driver'), true);
    assert.deepEqual(h.signal.requests.filter((b) => b[0] === 0x2e), [
        loginRequest(added), loginRequest(added), renameRequest('My Driver')
    ]);
});

test('Rejects a rename if the active account changes before TASU dispatch', async () => {
    const h = await harness(() => listReply(full));
    await h.workflow.refresh();
    h.signal.beforeCall = (sid) => { if (sid === 0x2e) h.state.active = added; };
    assert.equal(await h.workflow.rename(user, 'Other Name'), false);
    assert.equal(h.workflow.detail.code, 'active');
    assert.ok(h.signal.requests.every((b) => b[0] === 0x22));
});

test('Errors, transport busy and timeout never repeat a write or advance to RRR', async () => {
    for (const [value, code] of [
        [[0x7f, 0x31, 0x33], 'nrc'], [[0x71, 1], 'payload'],
        ['APP_REQUEST_TEMPORARILY_NOT_ACCEPTED', 'transport'], [new Error('ETIMEDOUT'), 'timeout']
    ]) {
        const h = await harness((bytes) => {
            if (bytes[0] === 0x22) return listReply(empty);
            if (value instanceof Error) throw value;
            return value;
        });
        await h.workflow.refresh();
        assert.equal(await h.workflow.create(), false);
        assert.equal(h.workflow.detail.code, code);
        assert.deepEqual(h.signal.requests, [ident, list, list, create]);
    }
});

test('Motion, unknown speed, stale samples, unknown firmware and disabled writes block dispatch', async () => {
    const zero = { value: { speedVehicleCentreOfGravity: 0 }, at: 100 };
    const gear = { value: 'P', at: 100 };
    assert.equal(stopped(zero, gear, 200), true);
    assert.equal(stopped(zero, gear, 3101), false);
    assert.equal(stopped(null, gear, 100), false);
    assert.equal(stopped(zero, { value: 'N', at: 100 }, 100), false);
    assert.equal(stopped({ value: { speedVehicleCentreOfGravity: 65535 }, at: 100 }, gear, 100), false);
    for (const [field, value, code] of [
        ['parked', false, 'parked'], ['speedKnown', false, 'parked'], ['enabled', false, 'writeDisabled'],
        ['visible', false, 'writeDisabled'], ['version', 'other', 'firmware']
    ]) {
        const h = await harness(() => listReply(empty));
        await h.workflow.refresh();
        (field === 'version' ? h.version : h.state)[field] = value;
        assert.equal(await h.workflow.create(), false);
        assert.equal(h.workflow.detail.code, code);
        assert.deepEqual(h.signal.requests, [ident, list]);
    }
    const h = await harness(() => listReply(empty));
    await h.workflow.refresh();
    h.signal.beforeCall = (sid) => { if (sid === 0x31) h.state.parked = false; };
    assert.equal(await h.workflow.create(), false);
    assert.deepEqual(h.signal.requests, [ident, list, list]);
});

test('Read-only mode rejects prohibited PIA, delete, key and security requests', async () => {
    const h = await harness(() => listReply(empty));
    for (const bytes of [piaRequest(0, 1), [0x31, 1, 0xa1, 0x9b], [0x31, 1, 0xa1, 0xbd], [0x27, 1], [0x11, 1]]) {
        await assert.rejects(h.diag.request(bytes, () => {}), { code: 'writeDisabled' });
    }
    assert.deepEqual(h.signal.requests, []);
});

test('Repeated actions are serialized and transport loss clears the cached list', async () => {
    let resolve;
    let pending = new Promise((r) => { resolve = r; });
    const h = await harness(() => pending);
    const refresh = h.workflow.refresh();
    assert.equal(await h.workflow.create(), false);
    assert.equal(await h.workflow.refresh(), false);
    await new Promise(setImmediate);
    h.signal.setAvailable(false);
    resolve(listReply(empty));
    assert.equal(await refresh, false);
    assert.equal(h.workflow.profiles, null);
    assert.equal(h.workflow.detail.code, 'offline');
    h.signal.setAvailable(true);
    pending = Promise.resolve(listReply(empty));
    assert.equal(await h.workflow.refresh(), true);
    assert.equal(h.workflow.profiles[0].id, user);
});

test('SOME/IP reads the session reference twice and invalidates an active-account lease', async () => {
    let notify, swapped = false, refs = 0, time = 10;
    const signals = {
        async proxy(iface) {
            return {
                isAvailable: () => true,
                getValue: async (key) => key === 'currentUserAccountReference' ?
                    { [key]: (swapped && ++refs === 2 ? 'new' : 'current') } :
                    { [key]: key === 'id' ? user : 'LOCAL' }
            };
        },
        async on(p, name, handler) { notify = handler; },
        async onAvailable(p, handler) { handler(true); }
    };
    const vehicle = new Vehicle(signals, '1', () => time);
    await vehicle.initSession();
    const active = await vehicle.activeAccount();
    assert.equal(active.id, user);
    assert.equal(active.type, 'local');
    assert.equal(vehicle.stillActive(active), true);
    time += 751;
    assert.equal(vehicle.stillActive(active), false);
    time = 10;
    notify();
    assert.equal(vehicle.stillActive(active), false);
    swapped = true;
    assert.equal(await vehicle.activeAccount(), null);
});

test('UI starts without UDS, opens in read-only mode, and recovers after link loss', async () => {
    let visible = false, onVisible, value = true;
    const clicks = {}, labels = {}, enabled = {};
    const ui = {
        isVisible: (name) => visible && name === 'MAIN', hasFocus: () => true,
        onVisible: (f) => { onVisible = f; }, onFocus() {},
        onClick: (name, f) => { clicks[name] = f; },
        text: async (name, text) => { labels[name] = text; },
        cells: async (name, row, fields) => { labels[name] = fields.Text1stRow; },
        visible: async () => {},
        enabled: async (name, on) => { enabled[name] = on; }
    };
    const settings = { get: () => value, set: (key, v) => { value = v; }, onChange() {} };
    const signals = new FakeSignals((bytes) => bytes[1] === 0xf1 ? identReply : listReply(empty));
    await start({ ui, settings, signals, spec }, kit, {});
    await new Promise(setImmediate);
    assert.equal(value, false);
    assert.deepEqual(signals.requests, []);
    visible = true;
    onVisible('MAIN', true);
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.deepEqual(signals.requests, [ident, list]);
    assert.equal(labels.PROFILE_0, 'Zoë');
    assert.equal(enabled.CREATE, false);
    value = true;
    await clicks.CREATE();
    assert.deepEqual(signals.requests, [ident, list]);
    signals.setAvailable(false);
    for (let i = 0; i < 3; i++) await new Promise(setImmediate);
    assert.equal(value, false);
    assert.match(labels.STATUS, /connection to HU_MGU lost/i);
    signals.setAvailable(true);
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(labels.STATUS, 'Profiles refreshed.');
    assert.deepEqual(signals.requests, [ident, list, ident, list]);
});
