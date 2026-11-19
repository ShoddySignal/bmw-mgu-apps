'use strict';

const { DiagnosticError, matchCreatedProfile, MAX_DRIVER_PROFILES } = require('./profiles');
const { loginRequest } = require('./diag');
const ACTIVATION_CONFIRMATION_MS = 8000;
const ACTIVATION_POLL_MS = 500;
const CREATION_LIST_CONFIRMATION_MS = 8000;
const CREATION_LIST_POLL_MS = 500;
const ACCOUNT_REFERENCE_PREFIX = 'de.bmw.infotainment.personalization.UserAccountManager.';

function matchingProfiles(profiles, account) {
    const reference = account.reference || '';
    const instance = reference.startsWith(ACCOUNT_REFERENCE_PREFIX) ? reference.slice(ACCOUNT_REFERENCE_PREFIX.length) : '';
    // E333 pads the three-character instance to seven bytes on the tested G05.
    const paddedId = account.type !== 'guest' && instance.length === 3 && /^i[0-9]{2}$/.test(instance) ?
        instance + '    ' : null;
    const byId = profiles.filter((profile) => profile.id === account.id || profile.id === reference ||
        (profile.type !== 'guest' && profile.id === paddedId));
    const byName = account.name ? profiles.filter((profile) => profile.name === account.name) : [];
    return { byId, byName };
}

function matchActiveProfile(profiles, account) {
    if (!account) return null;
    const { byId, byName } = matchingProfiles(profiles, account);
    if (byId.length > 1) return null;
    if (byId.length === 1) {
        const id = byId[0].id;
        return { ...account, id, matchedByReference: id !== account.id && id !== account.reference };
    }
    if (account.type === 'guest') return null;
    return byName.length === 1 && byName[0].type !== 'guest' ?
        { ...account, id: byName[0].id, matchedByName: true } : null;
}

function sameSessionAccount(before, after) {
    return before && after && before.id === after.id && before.reference === after.reference && before.epoch === after.epoch;
}

class Workflow {
    constructor(diag, vehicle, { visible, changed, wait, now,
        pendingPiaId, savePendingPia = () => {} }) {
        this.diag = diag;
        this.vehicle = vehicle;
        this.visible = visible;
        this.changed = changed;
        this.wait = wait;
        this.now = now;
        this.busy = false;
        this.generation = 0;
        this.identity = null;
        this.profiles = null;
        this.extraAccountBytes = 0;
        this.accountNames = [];
        this.active = null;
        this.systemAccount = null;
        this.pendingPiaId = typeof pendingPiaId === 'string' && pendingPiaId ? pendingPiaId : null;
        this.savePendingPia = savePendingPia;
        this.created = new Set(this.pendingPiaId ? [this.pendingPiaId] : []);
        this.state = 'idle';
        this.detail = null;
        this.operation = null;
        this.lastIssue = null;
    }

    stage(state, detail) {
        if (state === 'error') {
            detail.operation = this.operation;
            detail.afterAcceptance = this.state === 'accepted';
        }
        if (state === 'error' || state === 'activationUnverified') this.lastIssue = detail;
        this.state = state;
        this.detail = detail || null;
        this.changed();
    }

    setPendingPia(id) {
        this.pendingPiaId = id;
        this.savePendingPia(id);
    }

    disconnected() {
        this.generation++;
        this.identity = null;
        this.profiles = null;
        this.extraAccountBytes = 0;
        this.accountNames = [];
        this.active = null;
        this.systemAccount = null;
        this.stage('error', new DiagnosticError('offline'));
    }

    async run(operation, action) {
        if (this.busy) return false;
        const generation = this.generation;
        const current = () => {
            if (generation !== this.generation) throw new DiagnosticError('offline');
        };
        this.busy = true;
        this.operation = operation;
        this.stage('waiting');
        try {
            await action(current);
            return true;
        } catch (err) {
            if (generation === this.generation) this.stage('error', err instanceof DiagnosticError ? err : new DiagnosticError('transport'));
            return false;
        } finally {
            this.busy = false;
            this.operation = null;
            this.changed();
        }
    }

    async refresh() {
        return this.run('refresh', async (current) => {
            this.identity = null;
            this.profiles = null;
            this.extraAccountBytes = 0;
            this.accountNames = [];
            this.active = null;
            this.systemAccount = null;
            const identity = await this.diag.identify();
            current();
            this.identity = identity;
            if (!identity.isMgu) throw new DiagnosticError('variant');
            const profiles = await this.readProfiles(current);
            if (this.pendingPiaId && !profiles.some((p) => p.id === this.pendingPiaId && p.type !== 'guest')) {
                this.setPendingPia(null);
                throw new DiagnosticError('profileMissing');
            }
            this.stage('ready');
        });
    }

    async readProfiles(current) {
        const { profiles, extraBytes, nameFields, error } = await this.diag.accounts().catch((error) => ({
            error, nameFields: error.nameFields
        }));
        current();
        const active = !error || nameFields ? await this.vehicle.activeAccount() : null;
        current();
        this.profiles = profiles || null;
        this.extraAccountBytes = extraBytes || 0;
        this.accountNames = nameFields || [];
        this.systemAccount = active;
        this.active = profiles ? matchActiveProfile(profiles, active) : null;
        if (error) {
            delete error.nameFields;
            throw error;
        }
        if (this.active && this.lastIssue && this.lastIssue.code === 'activationUnverified' &&
            this.lastIssue.id === this.active.id) this.lastIssue = null;
        return profiles;
    }

    get accountMatches() {
        if (!this.profiles || !this.systemAccount) return null;
        const { byId, byName } = matchingProfiles(this.profiles, this.systemAccount);
        return { ids: byId.length, names: this.systemAccount.name ? byName.length : null };
    }

    get driverProfileCount() {
        return this.profiles ? this.profiles.filter((profile) => profile.type !== 'guest').length : null;
    }

    permit(current, active) {
        current();
        if (!this.visible()) throw new DiagnosticError('writeDisabled');
        if (!this.identity || !this.identity.isMgu) throw new DiagnosticError('variant');
        const parkingIssue = this.vehicle.parkingIssue();
        if (parkingIssue) throw Object.assign(new DiagnosticError('parked'), { reason: parkingIssue });
        if (active && !this.vehicle.stillActive(active)) throw new DiagnosticError('active');
    }

    async create() {
        return this.run('create', async (current) => {
            this.permit(current);
            if (this.pendingPiaId) throw new DiagnosticError('piaPending');
            const before = await this.readProfiles(current);
            if (this.driverProfileCount >= MAX_DRIVER_PROFILES) throw new DiagnosticError('capacity');

            this.profiles = null;
            this.active = null;
            this.systemAccount = null;
            await this.diag.create(() => this.permit(current));
            current();
            this.stage('accepted');
            const deadline = this.now() + 18000;
            let result;
            for (let attempt = 0; attempt < 8; attempt++) {
                await this.wait(500);
                current();
                if (this.now() >= deadline) break;
                result = await this.diag.creationResult();
                current();
                if (result.status === 2 || result.status === 3 || result.status === 255) break;
            }
            if (!result || result.status !== 2) {
                const error = new DiagnosticError(result && (result.status === 3 || result.status === 255) ? 'createFailed' : 'createPending');
                error.request = '31 03 A1 9A';
                if (result) error.reason = 'Creation status 0x' + result.status.toString(16).toUpperCase().padStart(2, '0');
                throw error;
            }

            const listDeadline = this.now() + CREATION_LIST_CONFIRMATION_MS;
            let match;
            do {
                current();
                const after = await this.readProfiles(current);
                match = matchCreatedProfile(before, after, result.id);
                if (match.profile) break;
                const remaining = listDeadline - this.now();
                if (remaining <= 0) break;
                await this.wait(Math.min(remaining, CREATION_LIST_POLL_MS));
            } while (this.now() < listDeadline);
            if (!match.profile) {
                throw Object.assign(new DiagnosticError('createMissing'), {
                    request: '22 E3 33', reason: 'Creation result 0x02 · ' + match.reason
                });
            }
            const created = match.profile;
            this.created.add(created.id);
            this.setPendingPia(created.id);
            await this.completePia(created, current);
        });
    }

    resumePia(id, slot) {
        return this.profileAction('pia', id, async (account, current) => {
            if (account.id !== this.pendingPiaId) throw new DiagnosticError('profileMissing');
            if (account.slot !== slot) throw new DiagnosticError('slotChanged');
            await this.completePia(account, current);
        });
    }

    async completePia(account, current) {
        this.stage('settingPia');
        this.active = null;
        this.systemAccount = null;
        // The E333 list is one-based while the documented PIA slots are zero-based.
        await this.diag.setPermanentPia(account.slot - 1, () => this.permit(current));
        current();
        this.setPendingPia(null);
        this.stage('confirmed', { action: 'create', id: account.id, name: account.name });
    }

    login(id) {
        return this.profileAction('login', id, async (account, current) => {
            loginRequest(account.id);
            const profiles = this.profiles;
            this.profiles = null;
            this.active = null;
            this.systemAccount = null;
            await this.diag.login(account.id, () => this.permit(current));
            current();
            this.stage('accepted');
            const deadline = this.now() + ACTIVATION_CONFIRMATION_MS;
            do {
                current();
                const active = await this.vehicle.activeAccount();
                current();
                const match = matchActiveProfile(profiles, active);
                if (match && match.id === id) {
                    await this.readProfiles(current);
                    if (this.active && this.active.id === id) {
                        this.stage('confirmed', { action: 'login', id: account.id });
                        return;
                    }
                }
                const remaining = deadline - this.now();
                if (remaining <= 0) break;
                await this.wait(Math.min(remaining, ACTIVATION_POLL_MS));
            } while (this.now() < deadline);
            await this.readProfiles(current);
            if (this.active && this.active.id === id) {
                this.stage('confirmed', { action: 'login', id });
                return;
            }
            const reason = this.active ? 'A different profile is still active' : this.systemAccount ?
                'No unique profile match' : this.vehicle.activeIssue || 'Active account unavailable';
            this.stage('activationUnverified', { code: 'activationUnverified', id, request: '2E E3 34', reason });
        });
    }

    rename(id, input, expectedAccount = this.systemAccount) {
        return this.profileAction('rename', id, async (account, current) => {
            const active = this.systemAccount;
            if (!this.active || this.active.id !== account.id || !sameSessionAccount(expectedAccount, active)) {
                throw new DiagnosticError('active');
            }
            const name = await this.diag.rename(input, () => {
                this.permit(current, active);
                this.profiles = null;
                this.active = null;
                this.systemAccount = null;
            });
            current();
            this.stage('accepted');
            const after = await this.readProfiles(current);
            if (!sameSessionAccount(active, this.systemAccount) || (this.active && this.active.id !== account.id)) {
                throw new DiagnosticError('active');
            }
            if (!after.some((p) => p.id === account.id && p.name === name)) throw new DiagnosticError('renameMissing');
            this.stage('confirmed', { action: 'rename', id: account.id });
        });
    }

    profileAction(action, id, perform) {
        return this.run(action, async (current) => {
            this.permit(current);
            const profiles = await this.readProfiles(current);
            const account = profiles.find((p) => p.id === id && p.type !== 'guest');
            if (!account) throw new DiagnosticError('profileMissing');
            await perform(account, current);
        });
    }
}

module.exports = { Workflow };
