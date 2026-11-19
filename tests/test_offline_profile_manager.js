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
const permanent = [0x31, 0x01, 0x02, 0x08, 0x04, 0x01, 0x02];
const permanentReply = [0x71, 0x01, 0x02, 0x08];
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
        verified: [{
            index: '0F25B0', version: version.version, variantId: version.variantId,
            actions: overrides.actions || ['create', 'pia', 'login', 'rename']
        }],
        changed: () => stages.push(workflow.state),
        wait: async (ms) => { time += ms; },
        now: () => time,
        ...overrides.options
    });
    transport.on('available', (up) => { if (!up) workflow.disconnected(); });
    return { signal, diag, workflow, state, stages, messages, version };
}

test('PRG account format: fixed field order, UTF-8 names, empty slots and guest', () => {
    assert.deepEqual(decodeAccounts(empty).profiles, [
        { id: user, name: 'Zoë', slot: 1, type: null },
        { id: guest, name: 'Guest', slot: null, type: 'guest' }
    ]);
    assert.equal(decodeAccounts(full.slice(0, -1)).profiles[1].slot, 2);
    assert.deepEqual(decodeAccounts([0, 0, 0, 0, 0, 0]), { profiles: [], extraBytes: 0 });
    assert.throws(() => decodeAccounts(empty.slice(0, 5)), { code: 'payload' });
    assert.deepEqual(decodeAccounts(empty.concat(0, 0, 0)), decodeAccounts(empty));
    assert.throws(() => decodeAccounts(empty.concat(0, 65)), { code: 'payload', reason: 'Extra data after guest ID' });
    assert.throws(() => decodeAccounts([65, 0, 0xc0, 0, 0, 0, 0, 0, 0]), { code: 'payload' });
    assert.throws(() => decodeAccounts(Array.from(Buffer.from('A\0x\0A\0y\0\0\0\0'))), { code: 'payload' });
});

test('Unknown E333 trailing data is accepted for display and rejected before writes', async () => {
    const extended = full.concat(0xa5, 0x5a);
    const h = await harness(() => listReply(extended));
    assert.equal(await h.workflow.refresh(), true);
    assert.deepEqual(h.workflow.profiles, decodeAccounts(full).profiles);
    assert.equal(h.workflow.extraAccountBytes, 2);
    assert.equal(h.workflow.approved('create'), false);
    assert.equal(h.workflow.approved('login'), false);
    assert.equal(h.workflow.approved('pia'), false);
    assert.equal(await h.workflow.rename(user, 'Other Name'), false);
    assert.equal(h.workflow.detail.code, 'firmware');
    assert.deepEqual(h.signal.requests, [ident, list]);

    let reads = 0;
    const changed = await harness(() => listReply(++reads === 1 ? full : extended));
    assert.equal(await changed.workflow.refresh(), true);
    assert.equal(changed.workflow.approved('rename'), true);
    assert.equal(await changed.workflow.rename(user, 'Other Name'), false);
    assert.equal(changed.workflow.detail.reason, 'Extra data after guest ID');
    assert.deepEqual(changed.signal.requests, [ident, list, list]);
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
        if (bytes[2] === 0x02) return permanentReply;
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
    assert.deepEqual(h.signal.requests, [ident, list, list, create, result, result, list, permanent]);
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
        assert.equal(h.workflow.pendingPiaId, null);
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

test('Creates a profile, sets its PIA slot, and renames it after selection in iDrive', async () => {
    let accounts = empty;
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(accounts);
        if (bytes[2] === 0xa1) {
            if (bytes[1] === 1) return [0x71, 1, 0xa1, 0x9a];
            accounts = full;
            return routineReply(2, added);
        }
        if (bytes[0] === 0x31) {
            assert.deepEqual(bytes, permanent);
            return permanentReply;
        }
        accounts = Array.from(Buffer.from([user, 'Zoë', added, 'Driver 2', '', '', guest].join('\0') + '\0'));
        return [0x6e, 0xe3, 0x35];
    }, { actions: ['create', 'pia', 'rename'] });
    assert.equal(await h.workflow.refresh(), true);
    assert.equal(await h.workflow.create(), true);
    assert.equal(h.workflow.detail.id, added);
    assert.equal(h.workflow.detail.name, 'TEST_NAME');
    assert.equal(h.state.active, user);
    assert.equal(h.workflow.pendingPiaId, null);
    assert.equal(await h.workflow.rename(added, 'Driver 2'), false);
    assert.equal(h.workflow.detail.code, 'active');

    h.state.active = added; // The driver selected the account in iDrive.
    assert.equal(await h.workflow.refresh(), true);
    assert.equal(await h.workflow.rename(added, 'Driver 2'), true);
    assert.deepEqual(h.signal.requests.filter((b) => b[0] !== 0x22), [
        create, result, permanent, renameRequest('Driver 2')
    ]);
});

test('PIA requires its own firmware approval, an unchanged driver slot and Park at dispatch', async () => {
    const locked = await harness(() => listReply(empty), { actions: ['create', 'login', 'rename'] });
    await locked.workflow.refresh();
    assert.equal(await locked.workflow.create(), false);
    assert.equal(locked.workflow.detail.code, 'firmware');
    assert.deepEqual(locked.signal.requests, [ident, list]);

    const h = await harness(() => listReply(full), { actions: ['pia'], options: { pendingPiaId: added } });
    await h.workflow.refresh();
    assert.equal(await h.workflow.resumePia(guest, null), false);
    assert.equal(h.workflow.detail.code, 'profileMissing');
    assert.equal(await h.workflow.resumePia(user, 1), false);
    assert.equal(h.workflow.detail.code, 'profileMissing');
    assert.equal(await h.workflow.resumePia(added, 1), false);
    assert.equal(h.workflow.detail.code, 'slotChanged');
    h.signal.beforeCall = (sid) => { if (sid === 0x31) h.state.parked = false; };
    assert.equal(await h.workflow.resumePia(added, 2), false);
    assert.equal(h.workflow.detail.code, 'parked');
    assert.ok(h.signal.requests.every((b) => b[0] === 0x22));
});

test('A failed PIA step preserves the new profile and resumes after restart without creating again', async () => {
    let accounts = empty, savedId = null;
    const savePendingPia = (id) => { savedId = id; };
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(accounts);
        if (bytes[1] === 3) {
            accounts = full;
            return routineReply(2, added);
        }
        return bytes[2] === 0xa1 ? [0x71, 1, 0xa1, 0x9a] : [0x7f, 0x31, 0x22];
    }, { options: { savePendingPia } });
    await h.workflow.refresh();
    assert.equal(await h.workflow.create(), false);
    assert.equal(h.workflow.detail.code, 'nrc');
    assert.equal(savedId, added);
    assert.equal(await h.workflow.create(), false);
    assert.equal(h.workflow.detail.code, 'piaPending');
    assert.deepEqual(h.signal.requests.filter((b) => b[0] === 0x31), [create, result, permanent]);

    const restarted = await harness((bytes) => bytes[0] === 0x22 ? listReply(accounts) : permanentReply,
        { options: { pendingPiaId: savedId, savePendingPia } });
    await restarted.workflow.refresh();
    assert.equal(await restarted.workflow.resumePia(added, 2), true);
    assert.equal(savedId, null);
    assert.deepEqual(restarted.signal.requests.filter((b) => b[0] === 0x31), [permanent]);
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

test('Transport rejects raw PIA, delete, key and security requests', async () => {
    const h = await harness(() => listReply(empty));
    for (const bytes of [piaRequest(0, 1), piaRequest(0, 2), piaRequest(10, 2),
        [0x31, 1, 0xa1, 0x9b], [0x31, 1, 0xa1, 0xbd], [0x27, 1], [0x11, 1]]) {
        await assert.rejects(h.diag.request(bytes, () => {}), { code: 'writeDisabled' });
    }
    assert.throws(() => h.diag.setPermanentPia(10, () => {}), { code: 'argument' });
    assert.throws(() => h.diag.setPermanentPia(0), { code: 'writeDisabled' });
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
    assert.equal(enabled.PROFILE_0, false);
    value = true;
    await clicks.CREATE();
    await clicks.PROFILE_0();
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

test('Diagnostics identifies a malformed startup reply and displays a 55-byte profile reply with extra data', async () => {
    let visible = false, onVisible;
    const labels = {}, clicks = {};
    const ui = {
        isVisible: (name) => visible && name === 'MAIN', hasFocus: () => true,
        onVisible: (listener) => { onVisible = listener; }, onFocus() {},
        onClick: (name, listener) => { clicks[name] = listener; },
        text: async (name, text) => { labels[name] = text; },
        cells: async () => {}, visible: async () => {}, enabled: async () => {}
    };
    const settings = { get: () => false, set() {}, onChange() {} };
    const truncated = empty.slice(0, 5);
    let accounts = truncated;
    const signals = new FakeSignals((bytes) => bytes[1] === 0xf1 ? identReply : listReply(accounts));
    await start({ ui, settings, signals, spec }, kit, {});
    visible = true;
    onVisible('MAIN', true);
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(labels.ID_INDEX, 'SGBD index · 0F25B0');
    assert.equal(labels.STATUS, 'Unexpected reply to 22 E3 33. See Diagnostics.');
    assert.equal(labels.NRC, '22 E3 33 · 8 UDS bytes · Missing profile field separator');

    const extraBytes = 55 - listReply(empty).length;
    accounts = empty.concat(Array(extraBytes).fill(0xa5));
    await clicks.REFRESH();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(labels.STATUS, 'Profiles refreshed.');
    assert.equal(labels.NRC, '22 E3 33 · Skipped ' + extraBytes + ' bytes after guest ID.');
    assert.deepEqual(signals.requests, [ident, list, ident, list]);
});

test('UI activates from the profile list and renames the active account after returning from iDrive', async (t) => {
    const verified = require('../apps/offline_profile_manager/verified-firmware');
    const software = { version: 'ui-test-firmware', variantId: 'test-variant' };
    verified.push({ index: '0F25B0', ...software, actions: ['login', 'rename'] });
    t.after(() => verified.pop());

    let activeId = user, userName = 'Zoë';
    class ProfileSignals extends FakeSignals {
        async proxy(iface) {
            if (iface.endsWith('SessionManager')) return { isAvailable: () => true, getValue: async () => 'current' };
            if (iface.endsWith('UserAccount')) {
                return { isAvailable: () => true, getValue: async (key) => key === 'id' ? activeId : 'LOCAL' };
            }
            return super.proxy();
        }

        async onAvailable(proxy, handler) {
            if (proxy.isAvailable) handler(true);
            else await super.onAvailable(proxy, handler);
        }

        async watch(iface, instance, handlers) {
            if (iface.endsWith('Vehicle2')) handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
            else handlers.statusGearboxDrive({ statusActualStageDrive: 'P' });
            return { available: true };
        }
    }
    const signals = new ProfileSignals((bytes) => {
        if (bytes[1] === 0xf1) return identReply;
        if (bytes[0] === 0x22) {
            return listReply(Array.from(Buffer.from([user, userName, added, 'TEST_NAME', '', '', guest].join('\0') + '\0')));
        }
        if (bytes[2] === 0x34) {
            activeId = added;
            return [0x6e, 0xe3, 0x34];
        }
        assert.equal(activeId, user);
        userName = 'A';
        return [0x6e, 0xe3, 0x35];
    });
    let screen = null, onVisible, onSetting;
    const clicks = {}, labels = {}, enabled = {}, values = {};
    function enter(name) {
        const previous = screen;
        screen = name;
        if (previous) onVisible(previous, false);
        if (name) onVisible(name, true);
    }
    const ui = {
        isVisible: (name) => screen === name, hasFocus: () => true,
        onVisible: (f) => { onVisible = f; }, onFocus() {},
        onClick: (name, f) => { clicks[name] = f; },
        text: async (name, value) => { labels[name] = value; },
        cells: async () => {}, visible: async () => {}, selected: async () => {},
        enabled: async (name, value) => { enabled[name] = value; },
        open: async (name) => enter(name), close: async () => enter('MAIN')
    };
    const settings = {
        get: (key) => values[key],
        set: (key, value) => { values[key] = value; if (onSetting) onSetting(); },
        onChange: (f) => { onSetting = f; }
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    await start({ ui, settings, signals, spec }, kit,
        { config: { get: () => '1' }, runtimeVariant: { getSoftwareVersion: () => software } });
    settings.set('writes', true);
    enter('MAIN');
    await settle();
    assert.equal(enabled.PROFILE_0, false);
    assert.equal(enabled.PROFILE_1, true);
    await clicks.PROFILE_1();
    assert.equal(labels.CONFIRM_TEXT, 'Activate profile “TEST_NAME”?');
    await clicks.APPLY();
    assert.equal(labels.CONFIRM_TEXT, 'Active profile confirmed.');
    await clicks.APPLY();
    await settle();
    assert.equal(enabled.PROFILE_1, false);

    enter(null);
    activeId = user; // The driver switched profiles in the stock UI.
    enter('MAIN');
    await settle();
    await clicks.RENAME();
    assert.equal(labels.CURRENT_PROFILE, 'Current profile · Zoë');
    clicks.ADD_CHARACTER();
    await clicks.RENAME_NEXT();
    assert.equal(labels.CONFIRM_TEXT, 'Rename active profile “Zoë” to “A”?');
    await clicks.APPLY();
    assert.equal(labels.CONFIRM_TEXT, 'New name confirmed.');
    assert.deepEqual(signals.requests.filter((b) => b[0] === 0x2e), [loginRequest(added), renameRequest('A')]);
});
