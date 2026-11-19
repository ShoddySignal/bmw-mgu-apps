'use strict';

const { DiagnosticError, malformed, decodeAccounts, decodeCreationResult, decodeIdentity } = require('./profiles');
const ADDRESS = 0x63;
const IDENT = [0x22, 0xf1, 0x50];
const ACCOUNTS = [0x22, 0xe3, 0x33];
const CREATE = [0x31, 0x01, 0xa1, 0x9a];
const CREATION_RESULT = [0x31, 0x03, 0xa1, 0x9a];
const NAME_MAX = 24; // Application limit. The PRG does not specify an ECU maximum.

function loginRequest(id) {
    if (typeof id !== 'string' || id.length !== 7 || /[^ -~]/.test(id)) throw new DiagnosticError('id');
    return [0x2e, 0xe3, 0x34].concat(Array.from(Buffer.from(id, 'ascii')));
}

function validName(name) {
    return typeof name === 'string' && name.length > 0 && name.length <= NAME_MAX &&
        name.trim() === name && !/[^A-Za-z0-9 _-]/.test(name);
}

function renameRequest(name) {
    if (!validName(name)) throw new DiagnosticError('name');
    return [0x2e, 0xe3, 0x35].concat(Array.from(Buffer.from(name, 'ascii')), 0);
}

function piaRequest(slot, mode) {
    if (![0, 1, 2, 10].includes(slot) || ![1, 2].includes(mode)) throw new DiagnosticError('argument');
    return [0x31, 0x01, 0x02, 0x08, 0x04, slot, mode];
}

const PIA_PERMANENT = [0, 1, 2].map((slot) => piaRequest(slot, 2));

function decodeReply(request, uds) {
    if (uds === null) throw new DiagnosticError('timeout');
    if (!uds || !uds.length || Array.from(uds).some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        throw malformed('Invalid UDS frame');
    }
    if (uds[0] === 0x7f) {
        if (uds.length !== 3 || uds[1] !== request[0]) throw malformed('Invalid UDS refusal');
        if (uds[2] === 0x78) return { pending: true };
        throw new DiagnosticError('nrc', uds[2]);
    }
    const end = request[0] === 0x31 ? 4 : 3;
    if (uds.length < end) throw malformed('Truncated UDS header');
    if (uds[0] !== request[0] + 0x40 || request.slice(1, end).some((b, i) => uds[i + 1] !== b)) {
        throw malformed('Unexpected UDS response header');
    }
    if (request[0] === 0x2e && uds.length !== end) throw malformed('Extra data in write response');
    return { payload: Array.from(uds).slice(end) };
}

class ProfileDiag {
    constructor(transport, replyTo) {
        this.link = transport;
        this.replyTo = replyTo;
        this.busy = false;
        this.generation = 0;
        transport.on('available', (up) => { if (!up) this.generation++; });
    }

    async request(bytes, beforeSend, decode) {
        const read = bytes === IDENT || bytes === ACCOUNTS || bytes === CREATION_RESULT;
        const write = bytes === CREATE || PIA_PERMANENT.includes(bytes) || (bytes[0] === 0x2e && bytes[1] === 0xe3 &&
            (bytes[2] === 0x34 || bytes[2] === 0x35));
        if (!read && (!write || typeof beforeSend !== 'function')) throw new DiagnosticError('writeDisabled');
        if (this.busy) throw new DiagnosticError('busy');
        if (!this.link.available) throw new DiagnosticError('offline');
        this.busy = true;
        const generation = this.generation;
        const sid = bytes[0], data = bytes.slice(1);
        const accept = this.replyTo(sid, data);
        const headerLength = sid === 0x31 ? 4 : 3;
        let replyLength;
        try {
            const uds = await this.link.physical(ADDRESS, sid, data, 3500, (frame) => {
                // Let short positive responses from this service reach the decoder.
                return accept(frame) || (frame[0] === sid + 0x40 && frame.length < headerLength);
            }, {
                maxRetries: 0,
                callTimeoutMs: 3500,
                pendingTimeoutMs: 8000,
                hardTimeoutMs: 12000,
                beforeSend: () => {
                    if (!this.link.available || generation !== this.generation) throw new DiagnosticError('offline');
                    if (beforeSend) beforeSend();
                }
            });
            if (!this.link.available || generation !== this.generation) throw new DiagnosticError('offline');
            replyLength = uds && uds.length;
            const result = decodeReply(bytes, uds);
            if (result.pending) throw new DiagnosticError('timeout'); // Kit normally consumes NRC 78.
            return decode ? decode(result.payload) : result.payload;
        } catch (error) {
            if (error instanceof DiagnosticError) {
                if (error.code === 'payload' && Number.isInteger(replyLength)) {
                    // Keep only the service and DID or routine ID. Arguments may contain account data.
                    error.request = bytes.slice(0, headerLength).map((b) => b.toString(16).padStart(2, '0')).join(' ').toUpperCase();
                    error.replyLength = replyLength;
                }
                throw error;
            }
            if (/timeout|timed out|ETIMEDOUT/i.test(String(error))) throw new DiagnosticError('timeout');
            throw new DiagnosticError('transport');
        } finally {
            this.busy = false;
        }
    }

    identify() { return this.request(IDENT, null, decodeIdentity); }
    accounts() { return this.request(ACCOUNTS, null, decodeAccounts); }
    creationResult() { return this.request(CREATION_RESULT, null, decodeCreationResult); }
    create(permit) { return this.write(CREATE, permit); }
    login(id, permit) { return this.write(loginRequest(id), permit); }
    rename(name, permit) { return this.write(renameRequest(name), permit); }
    setPermanentPia(slot, permit) {
        if (!Number.isInteger(slot) || !PIA_PERMANENT[slot]) throw new DiagnosticError('argument');
        return this.write(PIA_PERMANENT[slot], permit);
    }
    write(bytes, permit) {
        if (typeof permit !== 'function') throw new DiagnosticError('writeDisabled');
        return this.request(bytes, permit);
    }
}

module.exports = { ProfileDiag, decodeReply, loginRequest, renameRequest, piaRequest, validName, NAME_MAX };
