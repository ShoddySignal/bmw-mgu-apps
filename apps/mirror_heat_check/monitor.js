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
        this.test = null;
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
            if (!this.testInProgress) this.message = 'Reading stopped.';
            else this.message = this.test.attempted ? 'Observation stopped.' : 'Test cancelled before send.';
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
            this.message = `Confirm 100% for ${TEST_SECONDS} seconds. Check both mirror surfaces.`;
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
        const test = active ? { attempted: false, raw: '', error: null, before: null, during: null, after: null } : null;
        if (test) this.test = test;
        if (!this.diag.available || (active && (!this.parked() || this.now() < this.lockUntil))) {
            this.message = !this.diag.available ? 'Waiting for TASU.' : 'Test unavailable. Check P and test timer.';
            if (test) test.error = this.message;
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
                sample = key === 'faults' ? { value: await this.diag.readFaults(guard) } :
                    await this.diag.read(DIDS[key], guard);
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
        this.message = 'Identifying the BDC...';
        try {
            if (await read('ident') !== INDEX) {
                this.message = this.samples.ident.error || 'Different BDC variant. Test profile is for BDC_G05.';
                return;
            }
            this.message = 'Reading mirror heater status...';
            for (const key of ORDER) await read(key);
            if (!active) {
                await read('faults');
                this.message = 'Snapshot from BDC_G05. Open Diagnostics for each reply.';
                return;
            }
            const heating = this.samples.heating.value;
            test.before = heating;
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

            this.message = 'Sending the heater test...';
            try {
                test.raw = await this.diag.activate(() => {
                    guard();
                    if (this.now() >= deadline) throw new MirrorError('Confirmation expired before send.');
                    if (!this.parked()) throw new MirrorError('Parking status changed. Test cancelled.');
                    if (test.attempted) throw new MirrorError('Test already sent');
                    test.attempted = true;
                    this.activeUntil = this.now() + TEST_SECONDS * 1000;
                    this.lockUntil = this.activeUntil + REQUEST_MARGIN_MS;
                });
            } catch (error) {
                test.error = error.code || 'Test acknowledgement unavailable';
                test.raw = error.raw || '';
                if (!test.attempted) {
                    if (current()) this.message = test.error;
                    return;
                }
                if (/^NRC [0-9A-F]{2}$/.test(test.error)) {
                    this.activeUntil = 0;
                    if (current()) this.message = 'BDC declined the test (' + test.error + ').';
                    return;
                }
            }
            guard();
            const acknowledged = !!test.raw && !test.error;
            while (this.now() < this.lockUntil) {
                this.message = acknowledged ? 'BDC accepted the request. Check both mirror surfaces.' :
                    'Test reply unconfirmed. Observing BDC until the test window ends.';
                const value = await read('heating');
                if (value && value.on !== null && this.now() < this.activeUntil &&
                    (!test.during || (!test.during.on && value.on))) test.during = value;
                await read('protection');
                const delay = Math.min(2000, this.lockUntil - this.now());
                if (delay > 0) await this.wait(delay);
                guard();
            }

            test.after = await read('heating');
            await read('protection');
            await read('counter');
            await read('faults');
            this.message = acknowledged ?
                'Test elapsed. Open Diagnostics for BDC status and mirror faults.' :
                'Test elapsed. BDC acknowledgement was unavailable. Open Diagnostics.';
        } catch (error) {
            if (generation === this.generation) this.message = error.code || 'Diagnostic check interrupted.';
        } finally {
            if (test && !test.attempted && !test.error) test.error = this.message;
            this.busy = false;
            this.testInProgress = false;
        }
    }
}

module.exports = { Monitor };
