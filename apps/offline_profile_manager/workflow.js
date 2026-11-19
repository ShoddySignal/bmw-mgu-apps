'use strict';

const { DiagnosticError, createdProfile } = require('./profiles');
const { loginRequest, validName } = require('./diag');

class Workflow {
    constructor(diag, vehicle, { writeEnabled, visible, firmware, verified, changed, wait, now,
        pendingPiaId, savePendingPia = () => {} }) {
        this.diag = diag;
        this.vehicle = vehicle;
        this.writeEnabled = writeEnabled;
        this.visible = visible;
        this.firmware = firmware;
        this.verified = verified;
        this.changed = changed;
        this.wait = wait;
        this.now = now;
        this.busy = false;
        this.generation = 0;
        this.identity = null;
        this.profiles = null;
        this.extraAccountBytes = 0;
        this.active = null;
        this.pendingPiaId = typeof pendingPiaId === 'string' && pendingPiaId ? pendingPiaId : null;
        this.savePendingPia = savePendingPia;
        this.created = new Set(this.pendingPiaId ? [this.pendingPiaId] : []);
        this.state = 'idle';
        this.detail = null;
    }

    stage(state, detail) {
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
        this.active = null;
        this.stage('error', new DiagnosticError('offline'));
    }

    async run(action) {
        if (this.busy) return false;
        const generation = this.generation;
        const current = () => {
            if (generation !== this.generation) throw new DiagnosticError('offline');
        };
        this.busy = true;
        this.stage('waiting');
        try {
            await action(current);
            return true;
        } catch (err) {
            if (generation === this.generation) this.stage('error', err instanceof DiagnosticError ? err : new DiagnosticError('transport'));
            return false;
        } finally {
            this.busy = false;
            this.changed();
        }
    }

    async refresh() {
        return this.run(async (current) => {
            this.identity = null;
            this.profiles = null;
            this.extraAccountBytes = 0;
            this.active = null;
            const identity = await this.diag.identify();
            current();
            this.identity = identity;
            if (!identity.isMgu) throw new DiagnosticError('variant');
            const profiles = await this.readProfiles(current, { allowExtraData: true });
            if (!this.extraAccountBytes && this.pendingPiaId &&
                !profiles.some((p) => p.id === this.pendingPiaId && p.type !== 'guest')) {
                this.setPendingPia(null);
                throw new DiagnosticError('profileMissing');
            }
            this.stage('ready');
        });
    }

    async readProfiles(current, options) {
        const { profiles, extraBytes } = await this.diag.accounts(options);
        const active = await this.vehicle.activeAccount();
        current();
        this.profiles = profiles;
        this.extraAccountBytes = extraBytes;
        this.active = active && profiles.some((p) => p.id === active.id) ? active : null;
        return profiles;
    }

    approved(action) {
        if (!this.identity || !this.identity.isMgu || this.extraAccountBytes) return false;
        const software = this.firmware();
        return !!software && this.verified.some((item) => item.index === this.identity.index &&
            item.version === software.version && item.variantId === software.variantId &&
            item.actions.includes(action) && (action !== 'create' || item.actions.includes('pia')));
    }

    permit(action, current, active) {
        current();
        if (!this.writeEnabled() || !this.visible()) throw new DiagnosticError('writeDisabled');
        if (!this.approved(action)) throw new DiagnosticError('firmware');
        if (!this.vehicle.stationary()) throw new DiagnosticError('parked');
        if (active && !this.vehicle.stillActive(active)) throw new DiagnosticError('active');
    }

    async create() {
        return this.run(async (current) => {
            this.permit('create', current);
            if (this.pendingPiaId) throw new DiagnosticError('piaPending');
            const before = await this.readProfiles(current);
            if (before.filter((p) => p.type !== 'guest').length >= 3) throw new DiagnosticError('capacity');

            this.profiles = null;
            this.active = null;
            await this.diag.create(() => this.permit('create', current));
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
                throw new DiagnosticError(result && (result.status === 3 || result.status === 255) ? 'createFailed' : 'createPending');
            }

            let created = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                const after = await this.readProfiles(current);
                created = createdProfile(before, after, result.id);
                if (created) break;
                if (attempt < 2) await this.wait(450);
            }
            if (!created) throw new DiagnosticError('createMissing');
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
        // Only approve firmware where E333 slots 1–3 correspond to PIA slots 0–2.
        await this.diag.setPermanentPia(account.slot - 1, () => this.permit('pia', current));
        current();
        this.setPendingPia(null);
        this.stage('confirmed', { action: 'create', id: account.id, name: account.name });
    }

    login(id) {
        return this.profileAction('login', id, async (account, current) => {
            loginRequest(account.id);
            this.profiles = null;
            this.active = null;
            await this.diag.login(account.id, () => this.permit('login', current));
            current();
            this.stage('accepted');
            for (let attempt = 0; attempt < 4; attempt++) {
                if (attempt > 0) await this.wait(500);
                current();
                const active = await this.vehicle.activeAccount();
                current();
                if (active && active.id === account.id) {
                    await this.readProfiles(current);
                    if (this.active && this.active.id === account.id) {
                        this.stage('confirmed', { action: 'login', id: account.id });
                        return;
                    }
                }
            }
            throw new DiagnosticError('active');
        });
    }

    rename(id, name) {
        return this.profileAction('rename', id, async (account, current) => {
            if (!validName(name)) throw new DiagnosticError('name');
            const active = this.active;
            if (!active || active.id !== account.id) throw new DiagnosticError('active');
            this.profiles = null;
            this.active = null;
            await this.diag.rename(name, () => this.permit('rename', current, active));
            current();
            this.stage('accepted');
            const after = await this.readProfiles(current);
            if (!this.active || this.active.id !== account.id) throw new DiagnosticError('active');
            if (!after.some((p) => p.id === account.id && p.name === name)) throw new DiagnosticError('renameMissing');
            this.stage('confirmed', { action: 'rename', id: account.id });
        });
    }

    profileAction(action, id, perform) {
        return this.run(async (current) => {
            this.permit(action, current);
            const profiles = await this.readProfiles(current);
            const account = profiles.find((p) => p.id === id && p.type !== 'guest');
            if (!account) throw new DiagnosticError('profileMissing');
            await perform(account, current);
        });
    }
}

module.exports = { Workflow };
