'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { runInNewContext } = require('node:vm');
const kit = require('../kit/runtime/diag');
const { ProfileDiag, decodeReply, loginRequest, renameRequest, piaRequest } = require('../apps/offline_profile_manager/diag');
const { decodeAccounts, decodeCreationResult, decodeIdentity } = require('../apps/offline_profile_manager/profiles');
const { Workflow } = require('../apps/offline_profile_manager/workflow');
const { Vehicle, parkingIssue } = require('../apps/offline_profile_manager/vehicle');
const { start } = require('../apps/offline_profile_manager/ui');
const spec = require('../apps/offline_profile_manager/app.json');

test('Selector signals only request subscriptions in the installation manifest', () => {
    const selector = spec.signals['de.bmw.infrastructure.VehicleInformation'];
    assert.equal(selector.statusGearboxDrive, 's');
    assert.equal(selector.DataPowerTrain2, 's');
});

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
    const state = { speedKnown: true, parked: true, active: user, visible: true };
    const vehicle = {
        parkingIssue: () => !state.speedKnown ? 'Speed sample missing or stale' :
            state.parked ? null : 'A selector signal reports a position other than P',
        activeAccount: async () => state.active ? {
            id: state.active, reference: state.reference, name: state.name, type: state.type
        } : null,
        stillActive: (x) => x.id === state.active
    };
    let time = 0;
    const stages = [];
    const workflow = new Workflow(diag, vehicle, {
        visible: () => state.visible,
        changed: () => stages.push(workflow.state),
        wait: async (ms) => { time += ms; },
        now: () => time,
        ...overrides.options
    });
    transport.on('available', (up) => { if (!up) workflow.disconnected(); });
    return { signal, diag, workflow, state, stages, messages };
}

test('PRG account format: fixed field order, UTF-8 names, empty slots and guest', () => {
    assert.deepEqual(decodeAccounts(empty).profiles, [
        { id: user, name: 'Zoë', slot: 1, type: null },
        { id: guest, name: 'Guest', slot: null, type: 'guest' }
    ]);
    assert.deepEqual(decodeAccounts(empty).nameFields[0], { name: 'Zoë', bytes: [0x5a, 0x6f, 0xc3, 0xab] });
    const cyrillic = Array.from(Buffer.from([user, 'БМВ', '', '', '', '', guest].join('\0') + '\0'));
    assert.deepEqual(decodeAccounts(cyrillic).nameFields[0], {
        name: 'БМВ', bytes: [0xd0, 0x91, 0xd0, 0x9c, 0xd0, 0x92]
    });
    assert.equal(decodeAccounts(full.slice(0, -1)).profiles[1].slot, 2);
    assert.deepEqual(decodeAccounts([0, 0, 0, 0, 0, 0]), {
        profiles: [], extraBytes: 0,
        nameFields: Array.from({ length: 3 }, () => ({ name: '', bytes: [] }))
    });
    assert.throws(() => decodeAccounts(empty.slice(0, 5)), { code: 'payload' });
    assert.deepEqual(decodeAccounts(empty.concat(0, 0, 0)), decodeAccounts(empty));
    assert.deepEqual(decodeAccounts(empty.concat(0, 65)), { ...decodeAccounts(empty), extraBytes: 2 });
    assert.throws(() => decodeAccounts([65, 0, 0xc0, 0, 0, 0, 0, 0, 0]), { code: 'payload' });
    assert.throws(() => decodeAccounts(Array.from(Buffer.from('A\0x\0A\0y\0\0\0\0'))), { code: 'payload' });
});

test('A malformed fresh profile list blocks writes even after a valid refresh', async () => {
    let reads = 0;
    const h = await harness(() => listReply(++reads === 1 ? full : empty.slice(0, 5)));
    assert.equal(await h.workflow.refresh(), true);
    assert.equal(await h.workflow.rename(user, 'Other Name'), false);
    assert.equal(h.workflow.detail.reason, 'Missing profile field separator');
    assert.deepEqual(h.signal.requests, [ident, list, list]);
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
    assert.deepEqual(renameRequest('БМВ'), [0x2e, 0xe3, 0x35, 0xd0, 0x91, 0xd0, 0x9c, 0xd0, 0x92, 0]);
    assert.deepEqual(renameRequest('Ёё'), [0x2e, 0xe3, 0x35, 0xd0, 0x81, 0xd1, 0x91, 0]);
    assert.equal(renameRequest('Я'.repeat(12)).length, 28);
    assert.equal(renameRequest('A'.repeat(24)).length, 28);
    assert.deepEqual(piaRequest(10, 2), [0x31, 1, 2, 8, 4, 10, 2]);
    assert.throws(() => loginRequest('SHORT'), { code: 'id' });
    assert.throws(() => loginRequest('A\0B0001'), { code: 'id' });
    assert.throws(() => piaRequest(15, 2), { code: 'argument' });
});

test('Rename counts UTF-8 bytes after stripping controls and keeps script joiners', () => {
    for (const name of ['Zoë 日本語', 'العربية', 'می\u200cروم', '👩\u200d💻', '字'.repeat(8)]) {
        const nameBytes = Buffer.from(name, 'utf8');
        assert.deepEqual(renameRequest('\ufeff' + name + '\0\n\u0085\u202e\ud800'), [0x2e, 0xe3, 0x35, ...nameBytes, 0]);
    }
    assert.deepEqual(renameRequest(' A\u200b\0B '), [0x2e, 0xe3, 0x35, 0x20, 0x41, 0x42, 0x20, 0]);
    assert.throws(() => renameRequest(' \u200d\u202e\0'), { code: 'name' });
    for (const name of ['A'.repeat(25), 'Я'.repeat(13), '字'.repeat(8) + 'A']) {
        assert.throws(() => renameRequest(name), { code: 'nameTooLong' });
    }
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

test('Creation waits for a delayed account list update after the ECU reports success', async () => {
    let reads = 0;
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(++reads <= 7 ? empty : full);
        if (bytes[2] === 0x02) return permanentReply;
        if (bytes[1] === 3) return routineReply(2, added);
        return [0x71, 1, 0xa1, 0x9a];
    });
    await h.workflow.refresh();
    assert.equal(await h.workflow.create(), true);
    assert.equal(h.workflow.detail.id, added);
    assert.deepEqual(h.signal.requests, [ident, list, list, create, result, ...Array(6).fill(list), permanent]);
});

test('Creation is unconfirmed if the ECU finishes but the new ID is missing or mismatched', async () => {
    for (const [response, reason] of [
        [empty, 'No new account ID appeared in the list'],
        [full, 'The new account ID differs from the routine result']
    ]) {
        let reading = 0;
        const h = await harness((bytes) => {
            if (bytes[0] === 0x22) return listReply(reading++ < 2 ? empty : response);
            return bytes[1] === 1 ? [0x71, 1, 0xa1, 0x9a] : routineReply(2, 'OTHER01');
        });
        await h.workflow.refresh();
        assert.equal(await h.workflow.create(), false);
        assert.equal(h.workflow.detail.code, 'createMissing');
        assert.equal(h.workflow.detail.request, '22 E3 33');
        assert.equal(h.workflow.detail.reason, 'Creation result 0x02 · ' + reason);
        assert.equal(h.workflow.detail.afterAcceptance, true);
        assert.equal(h.workflow.pendingPiaId, null);
        assert.equal(h.signal.requests.filter((b) => b[0] === 0x31 && b[1] === 1).length, 1);
        assert.equal(h.signal.requests.some((b) => b[0] === 0x2e), false);
    }
});

test('Activation requires an independent exact active-account match before rename', async () => {
    let activeName = 'TEST_NAME', change = false, elapsed = 0;
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(Array.from(Buffer.from([user, 'Zoë', added, activeName, '', '', guest].join('\0') + '\0')));
        if (bytes[2] === 0x34) {
            if (change) elapsed = 0;
            return [0x6e, 0xe3, 0x34];
        }
        activeName = 'My Driver';
        return [0x6e, 0xe3, 0x35];
    }, { options: {
        now: () => elapsed,
        wait: async (ms) => {
            elapsed += ms;
            if (change && elapsed >= 2500) h.state.active = added;
        }
    } });
    await h.workflow.refresh();
    assert.equal(await h.workflow.rename(added, 'My Driver'), false);
    assert.equal(h.workflow.detail.code, 'active');
    assert.ok(h.signal.requests.every((b) => b[0] === 0x22));
    assert.equal(await h.workflow.login(added), true);
    assert.equal(h.workflow.state, 'activationUnverified');
    assert.equal(h.workflow.detail.request, '2E E3 34');
    assert.equal(h.workflow.detail.reason, 'A different profile is still active');
    change = true;
    assert.equal(await h.workflow.login(added), true);
    assert.equal(elapsed, 2500);
    assert.equal(await h.workflow.rename(added, 'My Driver'), true);
    assert.deepEqual(h.signal.requests.filter((b) => b[0] === 0x2e), [
        loginRequest(added), loginRequest(added), renameRequest('My Driver')
    ]);
});

test('Activation can match a distinct system ID by exact reference, and rejects conflicting matches', async () => {
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(full);
        h.state.active = 'SYSTEM002';
        h.state.reference = added;
        return [0x6e, 0xe3, 0x34];
    });
    await h.workflow.refresh();
    assert.equal(await h.workflow.login(added), true);
    assert.equal(h.workflow.state, 'confirmed');
    assert.equal(h.workflow.active.id, added);
    assert.equal(h.workflow.systemAccount.id, 'SYSTEM002');

    h.state.active = user; // The system ID and reference now point to different rows.
    h.state.name = 'TEST_NAME';
    await h.workflow.refresh();
    assert.equal(h.workflow.active, null);
    assert.equal(await h.workflow.rename(added, 'New Name'), false);
    assert.deepEqual(h.signal.requests.filter((b) => b[0] === 0x2e), [loginRequest(added)]);
});

test('Matches G05 SessionManager instances to padded E333 IDs despite duplicate names', async () => {
    const first = 'i01    ', second = 'i02    ';
    const prefix = 'de.bmw.infotainment.personalization.UserAccountManager.';
    const duplicateName = 'ЭЮЯ';
    const accounts = Array.from(Buffer.from([first, duplicateName, second, duplicateName, '', '', guest].join('\0') + '\0'));
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(accounts);
        assert.deepEqual(bytes, [0x2e, 0xe3, 0x34, 0x69, 0x30, 0x32, 0x20, 0x20, 0x20, 0x20]);
        h.state.active = 'SYSTEM2';
        h.state.reference = prefix + 'i02';
        return [0x6e, 0xe3, 0x34];
    });
    h.state.active = 'SYSTEM1';
    h.state.reference = prefix + 'i01';
    h.state.name = duplicateName;

    await h.workflow.refresh();
    assert.equal(h.workflow.active.id, first);
    assert.equal(h.workflow.active.matchedByReference, true);
    assert.deepEqual(h.workflow.accountMatches, { ids: 1, names: 2 });
    assert.equal(await h.workflow.login(second), true);
    assert.equal(h.workflow.state, 'confirmed');
    assert.equal(h.workflow.active.id, second);

    h.state.active = first;
    await h.workflow.refresh();
    assert.deepEqual(h.workflow.accountMatches, { ids: 2, names: 2 });
    assert.equal(h.workflow.active, null);
    assert.equal(await h.workflow.rename(second, 'Another name'), false);

    h.state.active = 'SYSTEM2';
    h.state.reference = 'unrelated.i02';
    await h.workflow.refresh();
    assert.equal(h.workflow.active, null);
    h.state.reference = prefix + 'i02';
    h.state.type = 'guest';
    await h.workflow.refresh();
    assert.equal(h.workflow.active, null);
    assert.deepEqual(h.signal.requests.filter((bytes) => bytes[0] === 0x2e), [loginRequest(second)]);
});

test('Duplicate names leave ECU acceptance without identifying a profile', async () => {
    const duplicates = Array.from(Buffer.from([user, 'TEST_NAME', added, 'TEST_NAME', '', '', guest].join('\0') + '\0'));
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(duplicates);
        h.state.active = 'SYSTEM002';
        h.state.reference = 'ACCOUNT002';
        h.state.name = 'TEST_NAME';
        return [0x6e, 0xe3, 0x34];
    });
    await h.workflow.refresh();
    assert.equal(await h.workflow.login(added), true);
    assert.equal(h.workflow.state, 'activationUnverified');
    assert.equal(h.workflow.lastIssue.reason, 'No unique profile match');
    assert.equal(h.workflow.active, null);
    assert.equal(h.workflow.systemAccount.name, 'TEST_NAME');
    await h.workflow.refresh();
    assert.equal(h.workflow.lastIssue.code, 'activationUnverified');
    assert.equal(await h.workflow.rename(added, 'New Name'), false);
    assert.deepEqual(h.signal.requests.filter((b) => b[0] === 0x2e), [loginRequest(added)]);
});

test('A unique system name identifies the active row and rename checks the same system account', async () => {
    let profileName = 'TEST_NAME';
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) {
            return listReply(Array.from(Buffer.from([user, 'Zoë', added, profileName, '', '', guest].join('\0') + '\0')));
        }
        if (bytes[2] === 0x34) {
            h.state.active = 'SYSTEM002';
            h.state.reference = 'ACCOUNT002';
            h.state.name = 'TEST_NAME';
            return [0x6e, 0xe3, 0x34];
        }
        profileName = 'New Name';
        return [0x6e, 0xe3, 0x35];
    });
    await h.workflow.refresh();
    assert.equal(await h.workflow.login(added), true);
    assert.equal(h.workflow.state, 'confirmed');
    assert.equal(h.workflow.active.id, added);
    assert.equal(h.workflow.active.matchedByName, true);
    const expected = h.workflow.systemAccount;
    h.state.reference = 'OTHER_ACCOUNT';
    assert.equal(await h.workflow.rename(added, 'New Name', expected), false);
    assert.equal(h.workflow.detail.code, 'active');
    h.state.reference = expected.reference;
    h.signal.beforeCall = (sid) => { if (sid === 0x2e) h.state.active = 'OTHER_SYSTEM'; };
    assert.equal(await h.workflow.rename(added, 'New Name', expected), false);
    assert.equal(h.workflow.detail.code, 'active');

    h.state.active = expected.id;
    h.signal.beforeCall = null;
    assert.equal(await h.workflow.rename(added, 'New \u202eName', expected), true);
    assert.equal(h.workflow.profiles.find((p) => p.id === added).name, 'New Name');
    assert.deepEqual(h.signal.requests.filter((b) => b[0] === 0x2e), [loginRequest(added), renameRequest('New Name')]);
});

test('Creates a profile, sets PIA, and renames it with extended account replies', async () => {
    let accounts = empty;
    const h = await harness((bytes) => {
        if (bytes[0] === 0x22) return listReply(accounts.concat(0xa5, 0x5a));
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
    });
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

test('An unrecognized SGBD index blocks profile commands', async () => {
    const h = await harness(() => listReply(full), { identity: [0x62, 0xf1, 0x50, 0x0f, 0x25, 0xb1] });
    assert.equal(await h.workflow.refresh(), false);
    assert.equal(await h.workflow.login(added), false);
    assert.equal(h.workflow.detail.code, 'variant');
    assert.deepEqual(h.signal.requests, [ident]);
});

test('PIA requires the pending profile, an unchanged driver slot and Park at dispatch', async () => {
    const h = await harness(() => listReply(full), { options: { pendingPiaId: added } });
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
    assert.equal(h.workflow.detail.request, '31 01 02 08 04');
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
        assert.equal(h.workflow.detail.request, '31 01 A1 9A');
        assert.deepEqual(h.signal.requests, [ident, list, list, create]);
    }
});

test('Failures identify result polling, PIA, activation and rename without recording arguments', async () => {
    const cases = [
        [(diag) => diag.creationResult(), '31 03 A1 9A', 0x31],
        [(diag) => diag.setPermanentPia(0, () => {}), '31 01 02 08 04', 0x31],
        [(diag) => diag.login(added, () => {}), '2E E3 34', 0x2e],
        [(diag) => diag.rename('Private Name', () => {}), '2E E3 35', 0x2e]
    ];
    for (const [send, request, service] of cases) {
        const h = await harness(() => [0x7f, service, 0x22]);
        await assert.rejects(send(h.diag), { code: 'nrc', nrc: 0x22, request, replyLength: 3 });
    }
});

test('Motion, unknown speed, stale samples and interrupted confirmation block dispatch', async () => {
    const zero = { value: { speedVehicleCentreOfGravity: 0 }, at: 100 };
    const gear = { value: 'P', at: 100 };
    const alternate = { value: 3, at: 100 };
    assert.equal(parkingIssue(zero, gear, 200), null);
    assert.equal(parkingIssue(zero, null, 200, alternate), null);
    assert.equal(parkingIssue(zero, null, 200, { ...alternate, value: 'NP' }), 'No fresh selector reading confirming P');
    assert.match(parkingIssue(zero, gear, 200, { ...alternate, value: 1 }), /other than P/);
    assert.match(parkingIssue(zero, gear, 3101), /stale/);
    assert.match(parkingIssue(null, gear, 100), /missing/);
    assert.match(parkingIssue(zero, { value: 'N', at: 100 }, 100), /other than P/);
    assert.match(parkingIssue({ value: { speedVehicleCentreOfGravity: 65535 }, at: 100 }, gear, 100), /invalid/);
    for (const [field, value, code] of [
        ['parked', false, 'parked'], ['speedKnown', false, 'parked'],
        ['visible', false, 'writeDisabled']
    ]) {
        const h = await harness(() => listReply(empty));
        await h.workflow.refresh();
        h.state[field] = value;
        assert.equal(await h.workflow.create(), false);
        assert.equal(h.workflow.detail.code, code);
        assert.deepEqual(h.signal.requests, [ident, list]);
    }
    const h = await harness(() => listReply(empty));
    await h.workflow.refresh();
    h.signal.beforeCall = (sid) => { if (sid === 0x31) h.state.parked = false; };
    assert.equal(await h.workflow.create(), false);
    assert.equal(h.workflow.detail.request, '31 01 A1 9A');
    assert.match(h.workflow.detail.reason, /other than P/);
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

test('SOME/IP waits for UserAccount and invalidates a rename lease on the SDK change broadcast', async () => {
    let notify, swapped = false, refs = 0, time = 10, accountWaits = 0;
    const signals = {
        async proxy(iface) {
            let available = iface.endsWith('SessionManager');
            return {
                isAvailable: () => available,
                waitUntilAvailable: async () => { accountWaits++; available = true; },
                getValue: async (key) => key === 'currentUserAccountReference' ?
                    { [key]: (swapped && ++refs === 2 ? 'new' : 'current') } :
                    { [key]: key === 'id' ? user : 'LOCAL' }
            };
        },
        async on(p, name, handler) {
            assert.equal(name, 'currentUserOnChange');
            notify = handler;
        },
        async onAvailable(p, handler) { handler(true); }
    };
    const vehicle = new Vehicle(signals, '1', () => time);
    await vehicle.initSession();
    const active = await vehicle.activeAccount();
    assert.equal(accountWaits, 1);
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

test('Paused vehicle signal polling stops its timer and ignores a read already in progress', async () => {
    const signalsPath = require.resolve('../kit/runtime/signals');
    const signalModule = { exports: {} };
    const reads = [], intervals = new Set(), samples = [];
    const proxy = {
        init: async () => {}, subscribeToAvailability: async () => {}, subscribe: async () => {},
        isAvailable: () => true,
        getValue: () => new Promise((resolve) => reads.push(resolve))
    };
    runInNewContext(readFileSync(signalsPath, 'utf8'), {
        __dirname: require('node:path').dirname(signalsPath), module: signalModule, setImmediate,
        require(name) {
            if (name === 'someip') return { buildProxy: async () => proxy };
            if (name === 'fs') return { readFileSync: () => '{"fields":{"speed":{"getter":true}}}' };
            return require(name);
        },
        setInterval(callback) { intervals.add(callback); return callback; },
        clearInterval(callback) { intervals.delete(callback); }
    });
    const link = await signalModule.exports.watch('Vehicle2', '1', { speed: (value) => samples.push(value) },
        null, { polling: false, pollMs: 1000 });
    const tick = () => new Promise(setImmediate);
    await tick();
    assert.equal(reads.length, 0);
    assert.equal(intervals.size, 0);
    link.setPolling(true);
    await tick();
    assert.equal(intervals.size, 1);
    assert.equal(reads.length, 1);

    link.setPolling(false);
    assert.equal(intervals.size, 0);
    reads[0](10);
    await tick();
    assert.deepEqual(samples, []);

    link.setPolling(true);
    await tick();
    assert.equal(reads.length, 2);
    reads[1](0);
    await tick();
    assert.deepEqual(samples, [0]);
    await link.shutdown();
    assert.equal(intervals.size, 0);
});

test('Create opens one confirmation and can be cancelled before sending a command', async () => {
    let screen = null, onVisible;
    const clicks = {}, labels = {}, enabled = {};
    function enter(name) {
        const previous = screen;
        screen = name;
        if (previous) onVisible(previous, false);
        onVisible(name, true);
    }
    const ui = {
        isVisible: (name) => screen === name, hasFocus: () => true,
        onVisible: (f) => { onVisible = f; }, onFocus() {},
        onClick: (name, f) => { clicks[name] = f; },
        text: async (name, text) => { labels[name] = text; },
        cells: async (name, row, fields) => { labels[name] = fields.Text1stRow; },
        visible: async () => {},
        enabled: async (name, on) => { enabled[name] = on; },
        open: async (name) => enter(name), close: async () => enter('MAIN')
    };
    const settings = { get: () => null, set: () => assert.fail('No write setting is required') };
    const signals = new FakeSignals((bytes) => bytes[1] === 0xf1 ? identReply : listReply(empty));
    await start({ ui, settings, signals, spec }, kit, {});
    await new Promise(setImmediate);
    assert.deepEqual(signals.requests, []);
    enter('MAIN');
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.deepEqual(signals.requests, [ident, list]);
    assert.equal(labels.PROFILE_0, 'Zoë');
    assert.equal(enabled.CREATE, true);
    assert.equal(clicks.OPEN_SETTINGS, undefined);
    await clicks.CREATE();
    await new Promise(setImmediate);
    assert.equal(screen, 'CONFIRM');
    assert.match(labels.CONFIRM_TEXT, /Create a local profile\?.*physical key/);
    assert.equal(labels.APPLY, 'Create profile');
    assert.deepEqual(signals.requests, [ident, list]);
    await clicks.CANCEL_CONFIRM();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(screen, 'MAIN');
    assert.deepEqual(signals.requests, [ident, list, ident, list]);

    await clicks.CREATE();
    signals.setAvailable(false);
    for (let i = 0; i < 3; i++) await new Promise(setImmediate);
    assert.match(labels.CONFIRM_TEXT, /connection to HU_MGU lost/i);
    assert.equal(labels.APPLY, 'Back to profiles');
    signals.setAvailable(true);
    await clicks.APPLY();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(labels.STATUS, 'Profiles refreshed.');
    assert.deepEqual(signals.requests, [ident, list, ident, list, ident, list]);
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
    assert.equal(labels.PROFILE_CAPACITY, 'Driver profiles · Up to 3');

    const extraBytes = 55 - listReply(empty).length;
    accounts = empty.concat(Array(extraBytes).fill(0xa5));
    await clicks.REFRESH();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(labels.STATUS, 'Profiles refreshed.');
    assert.equal(labels.NRC, 'Last error · 22 E3 33 · 8 UDS bytes · Missing profile field separator');
    assert.equal(labels.PROFILE_CAPACITY, 'Driver profiles · 1 of 3');

    accounts = Array.from(Buffer.from(['', '', '', '', '', '', guest].join('\0') + '\0'));
    await clicks.REFRESH();
    for (let i = 0; i < 5; i++) await new Promise(setImmediate);
    assert.equal(labels.PROFILE_CAPACITY, 'Driver profiles · 0 of 3');
    assert.deepEqual(signals.requests, [ident, list, ident, list, ident, list]);
});

test('UI renders account details without Array.flatMap and still supports profile actions', async () => {
    const uiPath = require.resolve('../apps/offline_profile_manager/ui');
    const appModule = { exports: {} };
    runInNewContext('delete Array.prototype.flatMap;\n' + readFileSync(uiPath, 'utf8'), {
        module: appModule, require: createRequire(uiPath), Buffer,
        setImmediate, setInterval, clearInterval, setTimeout, clearTimeout
    }, { filename: uiPath });
    const software = { version: 'L18_22w18.3-1-7', variantId: 'mgu-low' };
    let activeId = user, userName = 'Zoë', denyActivation = true, sessionChanged;
    let reference = 'current', diagnosticNameBytes, systemName;
    let thirdProfile = ['', ''];
    const speedPolling = [];
    class ProfileSignals extends FakeSignals {
        async proxy(iface) {
            if (iface.endsWith('SessionManager')) return { isAvailable: () => true, getValue: async () => reference };
            if (iface.endsWith('UserAccount')) {
                return { isAvailable: () => true, getValue: async (key) => ({
                    id: activeId, type: 'LOCAL', name: systemName || (activeId === user ? userName : 'TEST_NAME')
                })[key] };
            }
            return super.proxy();
        }

        async onAvailable(proxy, handler) {
            if (proxy.isAvailable) handler(true);
            else await super.onAvailable(proxy, handler);
        }

        async on(proxy, name, handler) {
            if (name === 'currentUserOnChange') sessionChanged = handler;
            else await super.on(proxy, name, handler);
        }

        async watch(iface, instance, handlers, log, opts) {
            if (iface.endsWith('Vehicle2')) {
                assert.equal(opts.polling, false);
                return { available: true, setPolling(enabled) {
                    speedPolling.push(enabled);
                    if (enabled) handlers.statusCarSpeed2({ speedVehicleCentreOfGravity: 0 });
                } };
            }
            handlers.DataPowerTrain2({ statusGearSelectionDrive: 'P' });
            return { available: true };
        }
    }
    const signals = new ProfileSignals((bytes) => {
        if (bytes[1] === 0xf1) return identReply;
        if (bytes[0] === 0x22) {
            const accounts = Array.from(Buffer.concat([
                Buffer.from(user + '\0'), diagnosticNameBytes || Buffer.from(userName),
                Buffer.from('\0' + [added, 'TEST_NAME', ...thirdProfile, guest].join('\0') + '\0')
            ]));
            return listReply(accounts.concat(0xa5));
        }
        if (bytes[2] === 0x34) {
            if (denyActivation) return [0x7f, 0x2e, 0x22];
            activeId = added;
            sessionChanged();
            return [0x6e, 0xe3, 0x34];
        }
        assert.equal(activeId, user);
        assert.equal(bytes[bytes.length - 1], 0);
        userName = Buffer.from(bytes.slice(3, -1)).toString('utf8');
        return [0x6e, 0xe3, 0x35];
    });
    let screen = null, onVisible;
    const clicks = {}, labels = {}, enabled = {}, shown = {}, values = {};
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
        cells: async (name, row, fields) => { labels[name] = fields.Text1stRow; },
        visible: async (name, value) => { shown[name] = value; }, selected: async () => {},
        enabled: async (name, value) => { enabled[name] = value; },
        open: async (name) => enter(name), close: async (name) => enter(spec.screens.find((s) => s.name === name).parent || 'MAIN')
    };
    const settings = {
        get: (key) => values[key],
        set: (key, value) => { values[key] = value; }
    };
    let spellerNotify, spellerStarts = 0, failSpeller = false;
    const spellerProxy = {
        init: async () => {}, waitUntilAvailable: async () => {},
        interactionState: { getValue: async () => 'READY' },
        notify: {
            subscribe: async (listener) => { spellerNotify = listener; return 1; },
            unsubscribe: async (id) => { assert.equal(id, 1); spellerNotify = null; }
        },
        start: async ({ token, startParameters }) => {
            assert.equal(token, 'text-token');
            assert.equal(startParameters.get(4), 'New profile name');
            spellerStarts++;
        }
    };
    const app = {
        async getUseCaseFactory() {
            if (failSpeller) throw new Error('Text input unavailable');
            return { create: async (id) => {
                assert.equal(id, '02076b22-d19b-4aef-9e8c-0d7305d8b88c');
                return { token: 'text-token', proxy: spellerProxy };
            } };
        }
    };
    const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(setImmediate); };
    await appModule.exports.start({ app, ui, settings, signals, spec }, kit,
        { config: { get: () => '1' }, runtimeVariant: { getSoftwareVersion: () => software } });
    enter('MAIN');
    await settle();
    assert.deepEqual(speedPolling, [false, true]);
    assert.equal(labels.PARK, 'Parked · Verified');
    assert.equal(labels.PROFILE_CAPACITY, 'Driver profiles · 2 of 3');
    assert.equal(enabled.CREATE, true);
    assert.equal(labels.NRC, '22 E3 33 · Skipped 1 bytes after guest ID.');
    assert.equal(labels.PROFILE_0, 'Active · Zoë');
    assert.equal(labels.PROFILE_1, 'TEST_NAME');
    assert.equal(enabled.PROFILE_0, false);
    assert.equal(enabled.PROFILE_1, true);
    await clicks.PROFILE_1();
    assert.equal(labels.CONFIRM_TEXT, 'Activate profile “TEST_NAME”?');
    assert.ok(signals.requests.every((bytes) => bytes[0] === 0x22));
    await clicks.APPLY();
    assert.match(labels.CONFIRM_TEXT, /NRC 0x22/);
    await clicks.APPLY();
    await settle();
    assert.equal(labels.NRC, 'Last error · 2E E3 34 · ECU rejected the request. NRC 0x22.');

    denyActivation = false;
    await clicks.PROFILE_1();
    await clicks.APPLY();
    assert.equal(labels.CONFIRM_TEXT, 'Active profile confirmed.');
    await clicks.APPLY();
    await settle();
    assert.equal(enabled.PROFILE_1, false);
    assert.equal(labels.PROFILE_0, 'Zoë');
    assert.equal(labels.PROFILE_1, 'Active · TEST_NAME');

    activeId = 'UNKNOWN ';
    reference = 'Account Ω';
    sessionChanged();
    await settle();
    assert.equal(labels.ACTIVE, 'Active account · Matched by name');
    assert.equal(labels.PROFILE_1, 'Active · TEST_NAME');
    assert.equal(enabled.PROFILE_1, false);
    assert.equal(enabled.RENAME, true);
    await clicks.DIAGNOSTICS();
    await settle();
    assert.equal(labels.SYSTEM_ACCOUNT_ID, undefined);
    const beforeOpeningIds = signals.requests.length;
    await clicks.SHOW_ACCOUNT_IDS();
    await settle();
    assert.equal(screen, 'ACCOUNT_IDS');
    assert.equal(labels.ACCOUNT_MATCHES, 'Matches · ID/reference 0 · Exact name 1');
    assert.equal(labels.OPEN_SLOT_1, 'Slot 1 · Zoë');
    assert.equal(labels.OPEN_SLOT_2, 'Slot 2 · TEST_NAME');
    assert.equal(labels.OPEN_SLOT_3, 'Slot 3 · Empty');
    assert.equal(labels.SYSTEM_ACCOUNT_ID, undefined);
    const navigate = async (button, target) => {
        await clicks[button]();
        await settle();
        assert.equal(screen, target);
    };
    await navigate('OPEN_SYSTEM_ACCOUNT', 'ACCOUNT_SYSTEM');
    assert.equal(labels.SYSTEM_ACCOUNT_ID, 'UserAccount.id · 8 bytes · "UNKNOWN\\x20"');
    assert.equal(labels.SESSION_REFERENCE, 'SessionManager reference · 10 bytes · "Account\\x20\\u03A9"');
    assert.equal(labels.SYSTEM_ACCOUNT_NAME, 'UserAccount.name · 9 bytes · "TEST_NAME"');
    await navigate('ACCOUNT_SYSTEM_BACK', 'ACCOUNT_IDS');
    assert.equal(labels.SYSTEM_ACCOUNT_ID, '');
    assert.equal(labels.SESSION_REFERENCE, '');
    await navigate('OPEN_SLOT_1', 'ACCOUNT_SLOT');
    assert.equal(labels.SLOT_DETAIL_ID, 'E333 slot 1 · 7 bytes · "USER001"');
    assert.equal(labels.SLOT_DETAIL_NAME, 'Name · 4 bytes · "Zo\\u00EB"');
    assert.equal(labels.SLOT_DETAIL_HEX, 'Name HEX · 4 bytes · 5A 6F C3 AB');
    await navigate('ACCOUNT_SLOT_BACK', 'ACCOUNT_IDS');
    assert.equal(labels.SLOT_DETAIL_ID, '');
    assert.equal(labels.SLOT_DETAIL_HEX, '');
    await navigate('OPEN_SLOT_2', 'ACCOUNT_SLOT');
    assert.equal(labels.SLOT_DETAIL_ID, 'E333 slot 2 · 7 bytes · "NEW0002"');
    await navigate('ACCOUNT_SLOT_BACK', 'ACCOUNT_IDS');
    await navigate('OPEN_SLOT_3', 'ACCOUNT_SLOT');
    assert.equal(labels.SLOT_DETAIL_ID, 'E333 slot 3 · Empty');
    await navigate('ACCOUNT_SLOT_BACK', 'ACCOUNT_IDS');
    await navigate('OPEN_GUEST_ACCOUNT', 'ACCOUNT_SLOT');
    assert.equal(labels.SLOT_DETAIL_ID, 'E333 guest · 7 bytes · "GUEST00"');
    assert.equal(shown.SLOT_DETAIL_NAME, false);
    assert.equal(shown.SLOT_DETAIL_HEX, false);
    await navigate('ACCOUNT_SLOT_BACK', 'ACCOUNT_IDS');
    assert.deepEqual(signals.requests.slice(beforeOpeningIds), [ident, list]);

    diagnosticNameBytes = Buffer.from('TEST_NAME');
    sessionChanged();
    await settle();
    assert.equal(labels.ACCOUNT_MATCHES, 'Matches · ID/reference 0 · Exact name 2');

    systemName = 'TEST_NAME\0';
    sessionChanged();
    await settle();
    assert.equal(labels.ACCOUNT_MATCHES, 'Matches · ID/reference 0 · Exact name Unavailable');
    await navigate('OPEN_SYSTEM_ACCOUNT', 'ACCOUNT_SYSTEM');
    assert.equal(labels.SYSTEM_ACCOUNT_NAME, 'UserAccount.name · 10 bytes · "TEST_NAME\\u0000"');
    await navigate('ACCOUNT_SYSTEM_BACK', 'ACCOUNT_IDS');

    systemName = undefined;
    diagnosticNameBytes = Buffer.from([0xc1, 0xcc, 0xc2]);
    sessionChanged();
    await settle();
    assert.equal(labels.ACCOUNT_MATCHES, 'Matches · Unavailable');
    await navigate('OPEN_SYSTEM_ACCOUNT', 'ACCOUNT_SYSTEM');
    assert.equal(labels.SYSTEM_ACCOUNT_NAME, 'UserAccount.name · 9 bytes · "TEST_NAME"');
    await navigate('ACCOUNT_SYSTEM_BACK', 'ACCOUNT_IDS');
    await navigate('OPEN_SLOT_1', 'ACCOUNT_SLOT');
    assert.equal(labels.SLOT_DETAIL_NAME, 'Name · Invalid text encoding');
    assert.equal(labels.SLOT_DETAIL_HEX, 'Name HEX · 3 bytes · C1 CC C2');
    assert.equal(shown.SLOT_DETAIL_NAME, true);
    assert.equal(shown.SLOT_DETAIL_HEX, true);
    await navigate('ACCOUNT_SLOT_BACK', 'ACCOUNT_IDS');
    await navigate('OPEN_SLOT_2', 'ACCOUNT_SLOT');
    assert.equal(labels.SLOT_DETAIL_NAME, 'Name · 9 bytes · "TEST_NAME"');
    await navigate('ACCOUNT_SLOT_BACK', 'ACCOUNT_IDS');
    assert.equal(enabled.RENAME, false);

    diagnosticNameBytes = undefined;
    await clicks.ACCOUNT_IDS_BACK();
    await settle();
    assert.equal(screen, 'DETAILS');
    assert.equal(labels.SYSTEM_ACCOUNT_ID, '');
    assert.equal(labels.SESSION_REFERENCE, '');
    assert.equal(labels.SYSTEM_ACCOUNT_NAME, '');
    assert.equal(labels.SLOT_DETAIL_ID, '');
    assert.equal(labels.SLOT_DETAIL_HEX, '');
    await clicks.DETAILS_BACK();
    await settle();

    activeId = user; // The driver switched profiles in the stock UI.
    reference = 'current';
    sessionChanged();
    await settle();
    assert.equal(labels.PROFILE_0, 'Active · Zoë');
    assert.equal(labels.PROFILE_1, 'TEST_NAME');
    assert.equal(enabled.RENAME, true);
    await clicks.DIAGNOSTICS();
    assert.equal(screen, 'DETAILS');
    await clicks.DETAILS_BACK();
    await settle();
    assert.equal(screen, 'MAIN');

    failSpeller = true;
    await clicks.RENAME();
    await settle();
    assert.equal(labels.STATUS, 'iDrive text input is unavailable.');
    assert.equal(screen, 'MAIN');
    failSpeller = false;

    let enteringName = clicks.RENAME();
    await settle();
    assert.equal(spellerStarts, 1);
    await clicks.RENAME();
    assert.equal(spellerStarts, 1);
    spellerNotify({ interactionState: 'ABORTED' });
    await enteringName;
    await settle();
    assert.equal(screen, 'MAIN');
    assert.equal(spellerNotify, null);

    enteringName = clicks.RENAME();
    await settle();
    enter(null);
    await settle();
    assert.equal(speedPolling[speedPolling.length - 1], false);
    const requestsWhileHidden = signals.requests.length;
    await settle();
    assert.equal(signals.requests.length, requestsWhileHidden);
    enter('MAIN');
    await enteringName;
    await settle();
    assert.equal(screen, 'MAIN');
    assert.equal(spellerNotify, null);
    assert.equal(enabled.RENAME, true);
    assert.equal(speedPolling[speedPolling.length - 1], true);

    enteringName = clicks.RENAME();
    await settle();
    spellerNotify({ interactionParameters: new Map([[102, '\0\u202e '], [105, true]]) });
    await enteringName;
    await settle();
    assert.equal(screen, 'MAIN');
    assert.equal(labels.STATUS, 'Enter a profile name with visible characters.');

    enteringName = clicks.RENAME();
    await settle();
    spellerNotify({ interactionParameters: new Map([[102, '字'.repeat(8) + 'A'], [105, true]]) });
    await enteringName;
    await settle();
    assert.equal(screen, 'MAIN');
    assert.equal(labels.STATUS, 'Name is too long. Maximum 24 UTF-8 bytes.');

    enteringName = clicks.RENAME();
    await settle();
    enter(null); // The native input screen temporarily covers the app.
    spellerNotify({ interactionParameters: new Map([[102, 'A']]) });
    assert.equal(screen, null);
    enter('MAIN');
    spellerNotify({ interactionParameters: new Map([[105, true]]) });
    await enteringName;
    assert.equal(screen, 'CONFIRM');
    assert.equal(labels.CONFIRM_TEXT, 'Rename active profile “Zoë” to “A”?');
    assert.ok(!signals.requests.some((bytes) => bytes[0] === 0x2e && bytes[2] === 0x35));
    await clicks.APPLY();
    assert.equal(labels.CONFIRM_TEXT, 'New name confirmed.');
    await clicks.APPLY();
    await settle();

    enteringName = clicks.RENAME();
    await settle();
    const internationalName = 'БМВ 日本語界 Zoë';
    assert.equal(Buffer.byteLength(internationalName, 'utf8'), 24);
    spellerNotify({ interactionParameters: new Map([[102, '\u202e' + internationalName + '\0'], [105, true]]) });
    await enteringName;
    assert.equal(screen, 'CONFIRM');
    assert.equal(labels.CONFIRM_TEXT, 'Rename active profile “A” to “' + internationalName + '”?');
    assert.equal(userName, 'A');
    await clicks.APPLY();
    assert.equal(labels.CONFIRM_TEXT, 'New name confirmed.');
    assert.equal(userName, internationalName);
    assert.deepEqual(signals.requests.filter((b) => b[0] === 0x2e), [
        loginRequest(added), loginRequest(added), renameRequest('A'), renameRequest(internationalName)
    ]);

    await clicks.APPLY();
    thirdProfile = ['THIRD03', 'Third driver'];
    await settle();
    assert.equal(labels.PROFILE_CAPACITY, 'Driver profiles · 3 of 3');
    assert.equal(enabled.CREATE, false);
    await clicks.CREATE();
    assert.equal(screen, 'MAIN');
    assert.ok(!signals.requests.some((bytes) => bytes[0] === 0x31));
});
