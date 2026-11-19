'use strict';

const { INDEX, DIDS, TEST_SECONDS, MirrorError } = require('./protocol');

const REQUEST_MARGIN_MS = 2500;
const CONFIRM_MS = 15000;
const ORDER = ['equipment', 'counter', 'heating', 'protection'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Monitor {
    constructor(diag, parked, now, wait = sleep) {
        this.diag = diag;
        this.parked = parked;
        this.now = now;
        this.wait = wait;
        this.visible = false;
        this.generation = 0;
        this.busy = false;
        this.testInProgress = false;
        this.confirmUntil = null;
        this.activeUntil = 0;
        this.lockUntil = 0;
        this.samples = {};
        this.message = 'Select Read status or Review heater test.';
        this.write = null;
        this.observed = false;
    }

    setVisible(visible) {
        if (this.visible && !visible) this.interrupt();
        this.visible = visible;
    }

    interrupt() {
        this.generation++;
        if (this.confirmUntil !== null) {
            this.message = 'Confirmation cancelled.';
            this.confirmUntil = null;
        }
        if (this.busy) {
            this.message = this.testInProgress && this.write && this.write.attempted ?
                'Observation stopped. The BDC uses the selected test duration.' : 'Reading stopped.';
        }
    }

    checking() {
        return this.confirmUntil !== null && this.now() < this.confirmUntil;
    }

    tick() {
        if (this.confirmUntil !== null && !this.checking()) {
            this.confirmUntil = null;
            this.message = 'Confirmation expired. Select Review heater test.';
        }
    }

    remaining() {
        return Math.max(0, Math.ceil((this.activeUntil - this.now()) / 1000));
    }

    review() {
        if (!this.visible || this.busy) return;
        if (this.now() < this.lockUntil) {
            this.message = 'Wait for the previous test duration to expire.';
        } else if (!this.diag.available) {
            this.message = 'Waiting for TASU.';
        } else if (!this.parked()) {
            this.message = 'Select P at 0 km/h. Waiting for current vehicle signals.';
        } else {
            this.confirmUntil = this.now() + CONFIRM_MS;
            this.message = 'Confirm 100% for 30 seconds. Check both mirror surfaces.';
        }
    }

    confirm() {
        this.tick();
        if (!this.checking()) return Promise.resolve();
        const deadline = this.confirmUntil;
        this.confirmUntil = null;
        return this.run(true, deadline);
    }

    refresh() {
        this.confirmUntil = null;
        return this.run(false);
    }

    async run(active, deadline) {
        if (!this.visible || this.busy) return;
        if (active && (!Number.isFinite(deadline) || this.now() >= deadline)) return;
        if (!this.diag.available || (active && (!this.parked() || this.now() < this.lockUntil))) {
            this.message = !this.diag.available ? 'Waiting for TASU.' : 'Test unavailable. Check P and test timer.';
            return;
        }
        const generation = this.generation;
        const current = () => this.visible && generation === this.generation && this.diag.available;
        const guard = () => {
            if (!current()) throw new MirrorError('Observation stopped');
        };
        const read = async (key) => {
            guard();
            let sample;
            try {
                sample = await this.diag.read(DIDS[key], guard);
            } catch (error) {
                sample = { value: null, error: error.code || 'Read failed', raw: error.raw || '' };
            }
            guard();
            this.samples[key] = sample;
            return sample.value;
        };

        this.busy = true;
        this.testInProgress = active;
        this.samples = {};
        if (active) {
            this.write = null;
            this.observed = false;
        }
        this.message = 'Identifying the BDC...';
        try {
            if (await read('ident') !== INDEX) {
                this.message = this.samples.ident.error || 'Different BDC variant. Test profile is for BDC_G05.';
                return;
            }
            this.message = 'Reading mirror heater status...';
            for (const key of ORDER) await read(key);
            if (!active) {
                this.message = 'Snapshot from BDC_G05. Open Diagnostics for each reply.';
                return;
            }
            const heating = this.samples.heating.value;
            if (!heating || heating.on === null || heating.demand === null) {
                this.message = 'Heater status is unavailable or has an unexpected layout.';
                return;
            }
            if (this.samples.equipment.value === false) {
                this.message = 'BDC reports mirror heating is not coded.';
                return;
            }
            if (this.samples.protection.value !== false) {
                this.message = 'Protection is active or its state is unknown.';
                return;
            }

            this.message = 'Sending the 30-second test...';
            this.write = { attempted: false, raw: '', error: null };
            try {
                const raw = await this.diag.activate(() => {
                    guard();
                    if (this.now() >= deadline) throw new MirrorError('Confirmation expired before send.');
                    if (!this.parked()) throw new MirrorError('Parking status changed. Test cancelled.');
                    if (this.write.attempted) throw new MirrorError('Test already sent');
                    this.write.attempted = true;
                    this.activeUntil = this.now() + TEST_SECONDS * 1000;
                    this.lockUntil = this.activeUntil + REQUEST_MARGIN_MS;
                });
                guard();
                this.write.raw = raw;
            } catch (error) {
                if (!current()) return;
                this.write.error = error.code || 'Test acknowledgement unavailable';
                this.write.raw = error.raw || '';
                if (!this.write.attempted) {
                    this.message = this.write.error;
                    return;
                }
                if (/^NRC [0-9A-F]{2}$/.test(this.write.error)) {
                    this.activeUntil = 0;
                    this.message = 'BDC declined the test (' + this.write.error + ').';
                    return;
                }
            }
            const acknowledged = !!this.write.raw && !this.write.error;
            while (this.now() < this.lockUntil) {
                this.message = acknowledged ? 'Test accepted. Compare both mirror surfaces.' :
                    'Test reply unconfirmed. Observing BDC until the test window ends.';
                const value = await read('heating');
                if (value && value.on && this.now() < this.activeUntil) this.observed = true;
                await read('protection');
                const delay = Math.min(2000, this.lockUntil - this.now());
                if (delay > 0) await this.wait(delay);
                guard();
            }

            await read('heating');
            await read('protection');
            await read('counter');
            this.message = acknowledged ?
                (this.observed ? 'Test elapsed. BDC reported heating during the test.' :
                    'Test elapsed. Heating ON was not observed in BDC status.') :
                'Test elapsed. BDC acknowledgement was unavailable.';
        } catch (error) {
            if (generation === this.generation) this.message = error.code || 'Diagnostic check interrupted.';
        } finally {
            this.busy = false;
            this.testInProgress = false;
        }
    }
}

module.exports = { Monitor };
