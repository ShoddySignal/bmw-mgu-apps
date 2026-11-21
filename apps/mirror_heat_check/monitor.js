'use strict';

const { INDEX, DIDS, MirrorError } = require('./protocol');

const REQUEST_MARGIN_MS = 2500;
const ORDER = ['equipment', 'counter', 'heating', 'protection'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function monotonicMs() {
    const time = process.hrtime();
    return time[0] * 1000 + time[1] / 1000000;
}

class Monitor {
    constructor(diag, now = monotonicMs, wait = sleep) {
        this.diag = diag;
        this.now = now;
        this.wait = wait;
        this.visible = false;
        this.onScreen = false;
        this.generation = 0;
        this.busy = false;
        this.testInProgress = false;
        this.refreshPending = false;
        this.refreshAfterTest = false;
        this.activeUntil = 0;
        this.lockUntil = 0;
        this.samples = {};
        this.message = 'Choose duration and power, then select Start test.';
        this.test = null;
    }

    setVisible(visible, onScreen = visible) {
        if (this.visible && !visible) this.interrupt();
        if (this.onScreen && !onScreen) this.refreshPending = true;
        this.visible = visible;
        this.onScreen = onScreen;
        return this.refreshIfPending();
    }

    disconnected() {
        this.interrupt();
        this.refreshPending = true;
        this.message = 'Waiting for TASU.';
    }

    interrupt() {
        this.generation++;
        if (this.busy) {
            this.refreshPending = true;
            if (this.testInProgress && this.test.attempted) this.refreshAfterTest = true;
            if (!this.testInProgress) this.message = 'Reading stopped.';
            else this.message = this.test.attempted ? 'Observation stopped.' : 'Test cancelled before send.';
        }
    }

    refreshIfPending() {
        if (this.refreshAfterTest && this.now() >= this.lockUntil) {
            this.refreshPending = true;
        }
        if (this.refreshPending && this.visible && !this.busy && this.diag.available) return this.refresh();
    }

    remaining() {
        return Math.max(0, Math.ceil((this.activeUntil - this.now()) / 1000));
    }

    start(power, seconds) {
        return this.run({ power, seconds, attempted: false, raw: '', error: null, before: null, during: null, after: null });
    }

    refresh() {
        return this.run();
    }

    async run(test) {
        if (!this.visible || this.busy) return;
        if (!this.diag.available || (test && this.now() < this.lockUntil)) {
            this.message = !this.diag.available ? 'Waiting for TASU.' : 'Wait for the previous test duration to expire.';
            return;
        }
        if (test) this.test = test;
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
        this.testInProgress = !!test;
        this.refreshPending = false;
        if (this.now() >= this.lockUntil) this.refreshAfterTest = false;
        this.samples = {};
        this.message = 'Identifying the BDC...';
        try {
            if (await read('ident') !== INDEX) {
                this.message = this.samples.ident.error || 'Different BDC variant. Test profile is for BDC_G05.';
                return;
            }
            this.message = 'Reading mirror heater status...';
            for (const key of ORDER) await read(key);
            if (!test) {
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
                test.raw = await this.diag.activate(test.power, test.seconds, () => {
                    guard();
                    if (test.attempted) throw new MirrorError('Test already sent');
                    test.attempted = true;
                    this.activeUntil = this.now() + test.seconds * 1000;
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
                    this.lockUntil = 0;
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
                if (value && value.on !== null && value.demand !== null && this.now() < this.activeUntil) {
                    test.during = value;
                }
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
            await this.refreshIfPending();
        }
    }
}

module.exports = { Monitor };
