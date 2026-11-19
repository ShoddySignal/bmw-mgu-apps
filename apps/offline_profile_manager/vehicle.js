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

function fresh(sample, now) {
    return sample && now >= sample.at && now - sample.at <= AGE_MS ? sample.value : null;
}

function selectorInPark(value, alternate) {
    if (Number.isInteger(value)) {
        if (alternate) {
            if (value === 3) return true;
            if (value === 1 || value === 2 || (value >= 5 && value <= 13)) return false;
        } else if (value >= 1 && value <= 4) {
            return value === 1;
        }
    }
    if (value === 'P') return true;
    if (['R', 'N', 'D'].includes(value) || (alternate && typeof value === 'string' && /^_[1-9]$/.test(value))) return false;
    return null; // NP/N_OR_P and invalid values cannot verify Park.
}

function parkingIssue(speed, gear, now, alternateGear) {
    const speedReading = fresh(speed, now);
    if (!speedReading) return 'Speed sample missing or stale';
    const value = speedReading.speedVehicleCentreOfGravity;
    if (!Number.isInteger(value) || value < 0 || value >= 65535) return 'Speed sample invalid';
    if (value !== 0) return 'Vehicle speed is above 0 km/h';
    const primary = selectorInPark(fresh(gear, now), false);
    const alternate = selectorInPark(fresh(alternateGear, now), true);
    if (primary === false || alternate === false) return 'A selector signal reports a position other than P';
    if (primary !== true && alternate !== true) return 'No fresh selector reading confirming P';
    return null;
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
        this.alternateGear = null;
        this.speedLink = null;
        this.gearLink = null;
        this.sessionLink = null;
        this.sessionEpoch = 0;
        this.watchedSession = false;
        this.activeIssue = 'SessionManager unavailable';
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
            signals.watch(GEAR, '1', {
                statusGearboxDrive: (value) => {
                    this.gear = { value: value && value.statusActualStageDrive, at: this.now() };
                },
                DataPowerTrain2: (value) => {
                    this.alternateGear = { value: value && value.statusGearSelectionDrive, at: this.now() };
                }
            }, silent, {
                onAvailable: (up) => { if (!up) this.gear = this.alternateGear = null; }
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

    parkingIssue() {
        if (!this.speedLink || !this.speedLink.available) return 'Speed signal provider unavailable';
        if (!this.gearLink || !this.gearLink.available) return 'Selector signal provider unavailable';
        return parkingIssue(this.speed, this.gear, this.now(), this.alternateGear);
    }

    async activeAccount() {
        let account;
        const epoch = this.sessionEpoch;
        try {
            this.activeIssue = 'SessionManager unavailable';
            if (!this.sessionLink || !this.sessionLink.isAvailable()) return null;
            this.activeIssue = 'Active account reference unavailable';
            const reference = await read(this.sessionLink, REFERENCE);
            if (typeof reference !== 'string' || !reference || reference.length > 128 || /[\x00-\x1f\x7f]/.test(reference)) return null;
            this.activeIssue = 'Active account ID unavailable';
            account = await this.signals.proxy(ACCOUNT, reference);
            const id = await read(account, 'id');
            if (typeof id !== 'string' || !id || /[^ -~]/.test(id)) return null;
            let type;
            try { type = await read(account, 'type'); } catch (e) { type = null; }
            this.activeIssue = 'Active account changed during verification';
            if (await read(this.sessionLink, REFERENCE) !== reference || this.sessionEpoch !== epoch) return null;
            this.activeIssue = null;
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

module.exports = { Vehicle, monotonicMs, parkingIssue };
