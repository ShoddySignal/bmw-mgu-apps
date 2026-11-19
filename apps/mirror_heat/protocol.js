'use strict';

const ADDRESS = 0x40;
const INDEX = '0F2680';
const DIDS = Object.freeze({ ident: 0xf150, heating: 0xd32d, protection: 0xd321, counter: 0x2305, equipment: 0xe450 });
const TEST_SECONDS = 30;
const ACTIVATE = Object.freeze([0xd3, 0x2d, 0x00, 0x04, 0x00, TEST_SECONDS]);

const lengths = {
    [DIDS.ident]: 3,
    [DIDS.heating]: 4,
    [DIDS.protection]: 2,
    [DIDS.counter]: 2,
    [DIDS.equipment]: 8
};

const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
const bit = (value) => value === 0 ? false : value === 1 ? true : null;

class MirrorError extends Error {
    constructor(code, raw) {
        super(code);
        this.code = code;
        this.raw = raw || '';
    }
}

function payload(uds, sid, did, length) {
    if (!uds) throw new MirrorError('No reply');
    const bytes = Array.from(uds);
    if (bytes.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new MirrorError('Invalid bytes');
    const raw = hex(bytes);
    if (bytes.length === 3 && bytes[0] === 0x7f && bytes[1] === sid) {
        throw new MirrorError('NRC ' + hex(bytes.slice(2)), raw);
    }
    const expectedLength = did === DIDS.ident && sid === 0x22 ? bytes.length >= length + 3 : bytes.length === length + 3;
    if (!expectedLength || bytes[0] !== sid + 0x40 ||
        bytes[1] !== (did >> 8) || bytes[2] !== (did & 0xff)) {
        throw new MirrorError('Unexpected reply', raw);
    }
    return Buffer.from(bytes.slice(3, 3 + length));
}

function decodeRead(did, uds) {
    const value = payload(uds, 0x22, did, lengths[did]);
    if (did === DIDS.ident) return hex(value).replace(/ /g, '');
    if (did === DIDS.heating) {
        const demand = value.readInt16BE(2);
        return { on: bit(value.readInt16BE(0)), demand: demand >= 0 && demand <= 100 ? demand : null };
    }
    if (did === DIDS.protection) return bit(value.readInt16BE(0));
    if (did === DIDS.counter) return value.readUInt16BE(0);
    if (did === DIDS.equipment) return bit(value[3]);
    throw new MirrorError('Unexpected identifier');
}

class MirrorDiag {
    constructor(link, replyTo) {
        this.link = link;
        this.replyTo = replyTo;
    }

    get available() { return this.link.available; }

    async request(sid, data, guard) {
        if (!Array.isArray(data) || !data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
            throw new MirrorError('Request blocked');
        }
        const allowedRead = sid === 0x22 && data.length === 2 &&
            Object.values(DIDS).includes((data[0] << 8) | data[1]);
        const allowedTest = sid === 0x2e && data.length === ACTIVATE.length &&
            ACTIVATE.every((byte, index) => data[index] === byte);
        if ((!allowedRead && !allowedTest) || typeof guard !== 'function') throw new MirrorError('Request blocked');
        const accept = this.replyTo(sid, data);
        try {
            return await this.link.physical(ADDRESS, sid, data, 1300, accept, {
                maxRetries: 0,
                callTimeoutMs: 1500,
                pendingTimeoutMs: 1800,
                hardTimeoutMs: 2400,
                beforeSend: () => {
                    if (!this.available) throw new MirrorError('TASU unavailable');
                    guard();
                }
            });
        } catch (error) {
            if (error instanceof MirrorError) throw error;
            throw new MirrorError(/timeout|timed out/i.test(String(error)) ? 'Transport timeout' : 'TASU request failed');
        }
    }

    async read(did, guard) {
        if (!Object.values(DIDS).includes(did)) throw new MirrorError('Unexpected identifier');
        const uds = await this.request(0x22, [did >> 8, did & 0xff], guard);
        return { value: decodeRead(did, uds), raw: hex(uds) };
    }

    async activate(guard) {
        const uds = await this.request(0x2e, ACTIVATE.slice(), guard);
        payload(uds, 0x2e, DIDS.heating, 0);
        return hex(uds);
    }
}

module.exports = { INDEX, DIDS, TEST_SECONDS, MirrorDiag, MirrorError, decodeRead };
