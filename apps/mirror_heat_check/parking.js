'use strict';

const MAX_AGE_MS = 3000;

function monotonicMs() {
    const time = process.hrtime();
    return time[0] * 1000 + time[1] / 1000000;
}

function stage(value, alternate) {
    if (typeof value === 'string') {
        if (value === 'NP' || value === 'N_OR_P') return null;
        if (['P', 'R', 'N', 'D'].includes(value)) return value;
        return alternate && /^_\d+$/.test(value) ? 'D' : null;
    }
    if (!Number.isInteger(value)) return null;
    if (!alternate) return [null, 'P', 'R', 'N', 'D'][value] || null;
    if (value >= 5 && value <= 13) return 'D';
    return [null, 'N', 'R', 'P'][value] || null;
}

function isParked(speed, primary, alternate, now) {
    const fresh = (sample) => sample && now >= sample.at && now - sample.at <= MAX_AGE_MS;
    if (!fresh(speed) || speed.value !== 0) return false;
    const positions = [primary, alternate].filter((sample) => fresh(sample) && sample.value !== null);
    return positions.length > 0 && positions.every((sample) => sample.value === 'P');
}

class Parking {
    constructor(signals, log, now) {
        this.signals = signals;
        this.log = log;
        this.now = now;
        this.speed = this.primary = this.alternate = null;
    }

    stamp(value) { return { value, at: this.now() }; }

    async init() {
        const watch = (iface, fields, options) => this.signals.watch(iface, '1', fields, this.log, options);
        await Promise.all([
            watch('de.bmw.infotainment.vehicle.Vehicle2', {
                statusCarSpeed2: (v) => { this.speed = this.stamp(v && v.speedVehicleCentreOfGravity); }
            }, {
                pollMs: 1200,
                onAvailable: (up) => { if (!up) this.speed = null; }
            }).then((link) => { this.speedLink = link; }),
            watch('de.bmw.infrastructure.VehicleInformation', {
                statusGearboxDrive: (v) => { this.primary = this.stamp(stage(v && v.statusActualStageDrive, false)); },
                DataPowerTrain2: (v) => { this.alternate = this.stamp(stage(v && v.statusGearSelectionDrive, true)); }
            }, {
                onAvailable: (up) => { if (!up) this.primary = this.alternate = null; }
            }).then((link) => { this.gearLink = link; })
        ]);
    }

    parked() {
        return !!(this.speedLink && this.speedLink.available && this.gearLink && this.gearLink.available &&
            isParked(this.speed, this.primary, this.alternate, this.now()));
    }
}

module.exports = { Parking, isParked, monotonicMs, stage };
