'use strict';

const SPEED = 'de.bmw.infotainment.vehicle.Vehicle2';
const GEAR = 'de.bmw.infrastructure.VehicleInformation';
const SESSION = 'de.bmw.infotainment.personalization.SessionManager';
const ACCOUNT = 'de.bmw.infotainment.personalization.UserAccount';
const REFERENCE = 'currentUserAccountReference';
const AGE_MS = 3000;
const ACTIVE_AGE_MS = 750;
const silent = { info() {}, warn() {} };

function monotonicMs() {
    const parts = process.hrtime();
    return parts[0] * 1000 + parts[1] / 1000000;
}

function field(value, key) {
    if (value && typeof value === 'object') return value[key];
    return value;
}

function stopped(speed, gear, now) {
    if (!speed || !gear || now < speed.at || now < gear.at ||
        now - speed.at > AGE_MS || now - gear.at > AGE_MS) return false;
    const value = speed.value;
    // Exact zero in Vehicle2's native scaling. Reject unavailable and invalid samples.
    return !!value && Number.isInteger(value.speedVehicleCentreOfGravity) &&
        value.speedVehicleCentreOfGravity === 0 &&
        (gear.value === 'P' || gear.value === 1);
}

async function read(proxy, key) {
    if (!proxy || !proxy.isAvailable()) return null;
    const result = await proxy.getValue(key, 1200);
    return proxy.isAvailable() ? field(result, key) : null;
}

class Vehicle {
    constructor(signals, sessionInstance, now) {
        this.signals = signals;
        this.sessionInstance = sessionInstance;
        this.now = now;
        this.speed = null;
        this.gear = null;
        this.speedLink = null;
        this.gearLink = null;
        this.sessionLink = null;
        this.sessionEpoch = 0;
        this.watchedSession = false;
    }

    async init() {
        const signals = this.signals;
        await Promise.all([
            signals.watch(SPEED, '1', { statusCarSpeed2: (value) => {
                this.speed = { value, at: this.now() };
            } }, silent, {
                pollMs: 1000,
                onAvailable: (up) => { if (!up) this.speed = null; }
            }).then((link) => { this.speedLink = link; }),
            signals.watch(GEAR, '1', { statusGearboxDrive: (value) => {
                this.gear = { value: value && value.statusActualStageDrive, at: this.now() };
            } }, silent, {
                onAvailable: (up) => { if (!up) this.gear = null; }
            }).then((link) => { this.gearLink = link; }),
            this.initSession()
        ]);
    }

    async initSession() {
        if (typeof this.sessionInstance !== 'string' || !this.sessionInstance) return;
        try {
            const proxy = await this.signals.proxy(SESSION, this.sessionInstance);
            this.sessionLink = proxy;
            await this.signals.on(proxy, REFERENCE, () => { this.sessionEpoch++; }, silent);
            await this.signals.onAvailable(proxy, () => { this.sessionEpoch++; });
            this.watchedSession = true;
        } catch (e) {
            // The target firmware can omit the service or limit access for non-BMW apps.
        }
    }

    stationary() {
        return !!(this.speedLink && this.speedLink.available && this.gearLink && this.gearLink.available &&
            stopped(this.speed, this.gear, this.now()));
    }

    async activeAccount() {
        let account;
        const epoch = this.sessionEpoch;
        try {
            const reference = await read(this.sessionLink, REFERENCE);
            if (typeof reference !== 'string' || !reference || reference.length > 128 || /[\x00-\x1f\x7f]/.test(reference)) return null;
            account = await this.signals.proxy(ACCOUNT, reference);
            const id = await read(account, 'id');
            if (typeof id !== 'string' || !id || /[^ -~]/.test(id)) return null;
            let type;
            try { type = await read(account, 'type'); } catch (e) { type = null; }
            if (await read(this.sessionLink, REFERENCE) !== reference || this.sessionEpoch !== epoch) return null;
            return { id, type: profileType(type), epoch, at: this.now() };
        } catch (e) {
            return null;
        } finally {
            if (account && account.shutdown) Promise.resolve().then(() => account.shutdown()).catch(() => {});
        }
    }

    stillActive(active) {
        const age = this.now() - active.at;
        return !!(this.watchedSession && this.sessionLink && this.sessionLink.isAvailable() &&
            this.sessionEpoch === active.epoch && age >= 0 && age <= ACTIVE_AGE_MS);
    }
}

function profileType(type) {
    // Only use self-describing enum values. Numeric mappings differ by interface version.
    const value = typeof type === 'string' ? type.toUpperCase() : '';
    if (value === 'LOCAL' || value === 'LOCAL_ACCOUNT') return 'local';
    if (value === 'GUEST' || value === 'GUEST_ACCOUNT') return 'guest';
    if (value === 'CONNECTED_DRIVE' || value === 'CONNECTEDDRIVE') return 'connected';
    return null;
}

module.exports = { Vehicle, monotonicMs, stopped };
