'use strict';

class DiagnosticError extends Error {
    constructor(code, nrc) {
        super(code);
        this.code = code;
        this.nrc = nrc;
    }
}

const malformed = (reason) => Object.assign(new DiagnosticError('payload'), { reason });

function text(bytes, encoding) {
    const value = Buffer.from(bytes).toString(encoding);
    if (!Buffer.from(value, encoding).equals(Buffer.from(bytes))) throw malformed('Invalid text encoding');
    if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(value)) throw malformed('Unsupported text character');
    return value;
}

function accountId(bytes) {
    if (bytes.some((byte) => byte < 0x20 || byte > 0x7e)) throw malformed('Invalid account ID encoding');
    return text(bytes, 'ascii');
}

function decodeAccounts(payload) {
    // PERSONALISATION_ACCOUNT_IDS, 0xC6A68–0xC6FDB. Strip the echoed
    // DID first, then consume six NUL-terminated strings and the guest ID.
    let offset = 0;
    const nameFields = [];
    function next(last) {
        let end = payload.indexOf(0, offset);
        if (end < 0) {
            if (!last) throw malformed('Missing profile field separator');
            end = payload.length;
        }
        const field = payload.slice(offset, end);
        offset = Math.min(end + 1, payload.length);
        return field;
    }
    try {
        const profiles = [];
        let nameError;
        for (let slot = 1; slot <= 3; slot++) {
            const idBytes = next(false);
            const field = { bytes: next(false) };
            nameFields.push(field);
            const id = accountId(idBytes);
            try {
                field.name = text(field.bytes, 'utf8');
            } catch (error) {
                if (!(error instanceof DiagnosticError)) throw error;
                field.issue = error.reason;
                if (!nameError) nameError = error;
                continue;
            }
            if (id) profiles.push({ id, name: field.name, slot, type: null });
            else if (field.name) throw malformed('Profile name without an ID');
        }
        if (nameError) throw nameError;
        const guestId = accountId(next(true));
        if (guestId) profiles.push({ id: guestId, name: 'Guest', slot: null, type: 'guest' });
        // The PRG stops after reading the guest ID. Count extra data for diagnostics.
        const tail = payload.slice(offset);
        const extraBytes = tail.some((byte) => byte !== 0) ? tail.length : 0;
        if (new Set(profiles.map((p) => p.id)).size !== profiles.length) throw malformed('Duplicate account IDs');
        return { profiles, extraBytes, nameFields };
    } catch (error) {
        if (error instanceof DiagnosticError) error.nameFields = nameFields;
        throw error;
    }
}

function decodeCreationResult(payload) {
    // Both fields of RES_0xA19A_R apply to RRR. The ID is optional.
    if (!payload.length || ![0, 1, 2, 3, 255].includes(payload[0])) throw malformed('Invalid creation status');
    const end = payload.indexOf(0, 1);
    if (end !== -1 && end !== payload.length - 1) throw malformed('Extra data after created account ID');
    return { status: payload[0], id: accountId(payload.slice(1, end < 0 ? payload.length : end)) || null };
}

function decodeIdentity(payload) {
    if (payload.length < 3) throw malformed('Missing SGBD index bytes');
    const index = Buffer.from(payload.slice(0, 3)).toString('hex').toUpperCase();
    return { index, isMgu: index === '0F25B0' };
}

function matchCreatedProfile(before, after, reportedId) {
    const ids = new Set(before.map((p) => p.id));
    if (before.some((p) => !after.some((q) => q.id === p.id && q.type === p.type))) {
        return { reason: 'An existing account disappeared or changed type' };
    }
    const added = after.filter((p) => !ids.has(p.id));
    if (added.length === 0) return { reason: 'No new account ID appeared in the list' };
    if (added.length > 1) return { reason: added.length + ' new account IDs appeared in the list' };
    const profile = added[0];
    if (profile.type === 'guest') return { reason: 'The only new account is a guest' };
    if (reportedId && profile.id !== reportedId) return { reason: 'The new account ID differs from the routine result' };
    return { profile };
}

module.exports = { DiagnosticError, malformed, decodeAccounts, decodeCreationResult, decodeIdentity, matchCreatedProfile };
