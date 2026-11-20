'use strict';

const { SOURCES, FIELDS, VIDEO_STATES, SIMPLE, parkingView, selection, call } = require('./plans');
const { FactoryTrace, DURATION_MS } = require('./trace');
const CALL_TIMEOUT = 1500;
const SAMPLE_AGE = 3500;
const VIDEO_TEST_MS = 4000;
const CID_FIELD = 'currentGraphicalContext';
const HMI_RESULTS = ['OK', 'ABORTED', 'CONTEXT_NOT_AVAILABLE', 'NO_CHANGE', 'NOT_ALLOWED',
    'NOT_FOCUSABLE', 'NOT_FOUND', 'NOT_POSSIBLE', 'OUT_OF_RANGE', 'UNSUPPORTED_PARAMETER'];

function json(value) {
    return JSON.stringify(value === undefined ? null : value, (key, item) =>
        typeof item === 'bigint' ? String(item) : item);
}

function stage(raw) {
    if (['P', 'R', 'N', 'D'].indexOf(raw) >= 0) return raw;
    return Number.isInteger(raw) ? [null, 'P', 'R', 'N', 'D'][raw] || null : null;
}

function monotonicMs() {
    const time = process.hrtime();
    return time[0] * 1000 + time[1] / 1000000;
}

function is(value, name, code) { return value === name || value === code; }
function message(error) { return error && error.message ? error.message : String(error); }

class Probe {
    constructor(signals, log, decodeSelection, now = monotonicMs, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
        this.signals = signals;
        this.log = log;
        this.decodeSelection = decodeSelection;
        this.now = now;
        this.delay = delay;
        this.links = {};
        this.samples = {};
        this.provider = {};
        this.sequence = 0;
        this.trace = new FactoryTrace();
        this.parkingView = null;
        this.cidAttempt = null;
        this.busy = false;
        this.closed = false;
        this.status = 'Select a request or record a factory-camera session.';
    }

    async start() {
        this.log.info('parking camera diagnostics ready to subscribe');
        await Promise.all(Object.keys(FIELDS).map((key) => this.watch(key)));
    }

    async watch(key) {
        const svc = SOURCES[key];
        const receive = {};
        FIELDS[key].forEach((field) => { receive[field] = (value) => this.update(key, field, value); });
        const options = { onAvailable: (up) => this.setAvailable(key, up) };
        if (key === 'speed') options.pollMs = 1200;
        try {
            const link = await this.signals.watch(svc.iface, svc.instance || '1', receive, this.log, options);
            if (this.closed) return link.shutdown();
            this.links[key] = link;
            if (link.error) this.record('subscribe-error', { source: key, interface: svc.iface, error: link.error });
            this.setAvailable(key, link.available);
            if (key === 'xview' && link.proxy) {
                await this.signals.on(link.proxy, 'PerspectiveChangeTriggered',
                    (value) => this.update(key, 'PerspectiveChangeTriggered', value), this.log);
            }
        } catch (error) {
            this.record('subscribe-error', { source: key, interface: svc.iface, error: message(error) });
        }
    }

    available(key) {
        const link = this.links[key];
        return !!(link && link.proxy && link.available);
    }

    setAvailable(key, up) {
        if (this.closed || this.provider[key] === up) return;
        this.provider[key] = up;
        if (!up) {
            const fields = Object.keys(this.samples[key] || {});
            delete this.samples[key];
            const at = this.now();
            fields.forEach((field) => this.trace.observe(key, field, undefined, at));
        }
        this.record('provider', { source: key, interface: SOURCES[key].iface, available: up });
    }

    update(key, field, value) {
        if (this.closed) return;
        if (value && key === 'speed') value = { speedVehicleCentreOfGravity: value.speedVehicleCentreOfGravity };
        if (value && key === 'gear') {
            const selector = field === 'statusGearboxDrive' ? 'statusActualStageDrive' : 'statusGearSelectionDrive';
            value = { [selector]: value[selector] };
        }
        const fields = this.samples[key] || (this.samples[key] = {});
        const previous = fields[field];
        const data = json(value);
        const at = this.now();
        fields[field] = { at, value, data };
        if (key === 'cid' && field === CID_FIELD) {
            const plan = parkingView(value);
            if (plan) this.parkingView = plan;
            if (this.cidAttempt && value && value.visibleContext === this.cidAttempt.target) {
                this.cidAttempt.observed = true;
            }
        }
        if (!previous || previous.data !== data) {
            if (this.busy || this.trace.active(at)) this.record('signal', { source: key, field, value });
            this.trace.observe(key, field, value, at);
        }
    }

    value(key, field, maxAge) {
        if (!this.available(key)) return undefined;
        const sample = this.sample(key, field);
        if (sample && (!maxAge || this.now() - sample.at <= maxAge)) return sample.value;
        return undefined;
    }

    sample(key, field) { return this.samples[key] && this.samples[key][field]; }

    speedKmh() {
        const sample = this.value('speed', 'statusCarSpeed2', SAMPLE_AGE);
        const raw = sample && sample.speedVehicleCentreOfGravity;
        return Number.isInteger(raw) && raw >= 0 && raw < 65535 ? raw / 64 : null;
    }

    selectors() {
        const main = this.value('gear', 'statusGearboxDrive', SAMPLE_AGE);
        const other = this.value('gear', 'DataPowerTrain2', SAMPLE_AGE);
        const decoded = this.decodeSelection(other && other.statusGearSelectionDrive);
        return [stage(main && main.statusActualStageDrive), decoded && decoded.stage].filter(Boolean);
    }

    parkingIssue() {
        const speed = this.speedKmh();
        if (speed === null) return 'Waiting for fresh vehicle speed';
        if (speed !== 0) return 'Vehicle is moving';
        const gear = this.selectors();
        if (!gear.length) return 'Waiting for fresh selector status';
        if (gear.some((value) => value !== 'P')) return 'Select P before sending requests';
        return null;
    }

    cameraPerspective() {
        const state = this.value('xview', 'CurrentState') || this.value('icam', 'currentState');
        const n = state && state.perspective;
        return Number.isInteger(n) && n >= 0 && n <= 255 ? n : null;
    }

    snapshot() {
        const state = {};
        Object.keys(FIELDS).forEach((key) => {
            const values = {};
            Object.keys(this.samples[key] || {}).forEach((field) => {
                const value = this.value(key, field);
                if (value !== undefined) values[field] = value;
            });
            state[key] = { available: this.available(key), values };
        });
        return state;
    }

    startTrace() {
        this.trace.start(this.now(), (source, field) => this.value(source, field));
        this.record('manual-trace', { seconds: DURATION_MS / 1000, state: this.snapshot() });
    }

    stopTrace() {
        this.trace.stop();
        this.record('manual-trace-stop', {});
    }

    traceRemaining() { return this.trace.remaining(this.now()); }

    record(event, details) {
        this.log.info('camera-assist ' + json(Object.assign({ event, test: this.testId || null }, details)));
    }

    async invoke(action, check, onSend) {
        const svc = SOURCES[action.source];
        const details = {
            interface: svc.iface, service: '0x' + svc.id, instance: svc.instance || '1', method: action.method,
            methodId: '0x' + action.id, params: action.params, fireAndForget: action.fireAndForget,
        };
        let sent = false;
        const before = () => {
            if (!this.available(action.source)) throw new Error('Provider unavailable · ' + action.source);
            if (check) check();
            sent = true;
            if (onSend) onSend();
            this.record('send', details);
        };
        try {
            if (!this.available(action.source)) throw new Error('Provider unavailable · ' + action.source);
            const response = await this.signals.call(this.links[action.source].proxy, action.method, action.params, CALL_TIMEOUT, before);
            this.record(action.fireAndForget ? 'dispatched' : 'reply', Object.assign({}, details, { response }));
            return response;
        } catch (error) {
            this.record('call-error', Object.assign({}, details, { sent, error: message(error) }));
            throw error;
        }
    }

    checkParked() {
        if (this.closed) throw new Error('App is closing');
        const issue = this.parkingIssue();
        if (issue) throw new Error(issue);
    }

    async waitFor(observed, error) {
        const deadline = this.now() + 1800;
        while (!observed() && this.now() < deadline) {
            this.checkParked();
            await this.delay(150);
        }
        if (!observed()) throw new Error(error);
    }

    parkingMenuRequested() {
        const menu = this.value('menu', 'requestParkmenu');
        return menu && is(menu.parkmenuRequest, 'PARKMENU_VISIBILITY_REQUESTED', 1) &&
            !is(menu.hmiVisibilityRequest, 'FADE_OUT', 2);
    }

    currentCid() {
        const context = this.value('cid', CID_FIELD);
        return context && Number.isInteger(context.visibleContext) ? context.visibleContext : null;
    }

    beginCidAttempt(target) {
        const before = this.currentCid();
        if (before === null) throw new Error('Current CID screen is unavailable');
        if (before === target) throw new Error('Close Parking View before sending');
        this.cidAttempt = { target, before, observed: false };
    }

    finishCidAttempt() {
        if (!this.cidAttempt) return;
        const result = this.cidAttempt;
        this.cidAttempt = null;
        const after = this.currentCid();
        this.record('cid-result', Object.assign({ after }, result));
        this.status += ' | CID ' + result.before + ' > ' + (after === null ? '-' : after) +
            ' | ' + result.target + (result.observed ? ' observed' : ' not observed');
    }

    async run(plan, numeric, foreground) {
        if (this.closed || this.busy || !plan) return;
        if (!foreground()) {
            const reason = 'Review screen is not in front';
            this.status = 'Not sent · ' + reason;
            this.record('blocked', { reason });
            return;
        }

        this.busy = true;
        this.testId = ++this.sequence;
        this.status = 'Running · ' + plan.label;
        this.record('test-start', { label: plan.label, enumEncoding: numeric ? 'number' : 'name', state: this.snapshot() });
        let sent = false;
        const markSent = () => { sent = true; };
        try {
            let step = plan.build(numeric);
            this.checkParked();
            if (!this.available(step.source)) throw new Error('Provider unavailable · ' + SOURCES[step.source].iface.split('.').pop());
            let first = true;
            const send = (action, extraCheck) => this.invoke(action, () => {
                this.checkParked();
                if (first && !foreground()) throw new Error('Review screen is no longer in front');
                if (extraCheck) extraCheck();
                first = false;
            }, markSent);

            if (plan.enterParkmenu) {
                const previous = this.sample('menu', 'requestParkmenu');
                await send(SIMPLE.OPEN_MENU.build(numeric));
                await this.waitFor(() => previous !== this.sample('menu', 'requestParkmenu') && this.parkingMenuRequested(),
                    'No new parking menu visibility request observed');
            }
            if (plan.enterFreeView) {
                const previous = this.sample('hmi', 'selectedCameraMode');
                await send(selection('mode', 2, false).build(numeric));
                await this.waitFor(() => previous !== this.sample('hmi', 'selectedCameraMode') &&
                    is(this.value('hmi', 'selectedCameraMode'), 'FREE_CAMERA', 3), 'No new 3D mode notification observed');
            }
            if (plan.attach) {
                const reply = await send(plan.attach(numeric));
                const cookie = reply && typeof reply === 'object' ? reply.cookie : reply;
                if (!Number.isInteger(cookie) || cookie < 0 || cookie > 0xffffffff) throw new Error('No valid ICAM2 client cookie in reply');
                this.release = () => this.invoke(call('icam', 'clientDetach', '0006', { cookie }));
                step = plan.build(numeric, cookie);
            }
            const reply = await send(step, () => {
                if (plan.visibleContext !== undefined) this.beginCidAttempt(plan.visibleContext);
                if (!plan.video) return;
                const field = VIDEO_STATES[plan.video];
                if (!is(this.value(plan.video, field), 'VIDEO_IDLE', 0)) {
                    throw new Error('Wait for ' + field + ' to report VIDEO_IDLE');
                }
                if (this.parkingMenuRequested()) throw new Error('Close the factory parking screen before a player test');
            });
            if (plan.video) this.release = () => this.stopVideo(plan.video);
            if (this.cidAttempt) {
                const code = reply && typeof reply === 'object' ? reply.errorCode : reply;
                const status = Number.isInteger(code) ? HMI_RESULTS[code] || String(code) : code;
                this.status = 'HMI reply: ' + (status == null ? 'missing errorCode' : String(status));
            } else {
                this.status = (step.fireAndForget ? 'Dispatched' : 'Replied') + ' · ' + plan.label;
            }
        } catch (error) {
            this.status = (sent ? 'Test incomplete' : 'Not sent') + ' · ' + message(error);
            this.record('test-error', { sent, error: message(error) });
        } finally {
            if (sent && !this.closed) await this.delay(VIDEO_TEST_MS);
            await this.releaseTest();
            this.finishCidAttempt();
            this.record('test-end', { result: this.status, state: this.snapshot() });
            this.testId = null;
            this.busy = false;
        }
    }

    async releaseTest() {
        const release = this.release;
        if (!release) return;
        this.release = null;
        try { await release(); }
        catch (error) {
            this.status = 'Cleanup unconfirmed · ' + message(error);
            this.record('cleanup-error', { error: message(error) });
        }
    }

    async stopVideo(source) {
        const state = this.value(source, VIDEO_STATES[source]);
        const active = is(state, 'VIDEO_ACTIVE', 2) || is(state, 'VIDEO_NO_DATA', 1);
        const issue = this.parkingIssue();
        const factory = this.parkingMenuRequested();
        if (!active || issue || factory) {
            this.record('video-stop-skipped', { source, state, reason: issue || (factory ? 'Factory parking view requested' : 'Player inactive or status unavailable') });
            return;
        }
        const id = source === 'das' ? '0009' : '0003';
        await this.invoke(call(source, 'stopVideo', id, {}), () => {
            const reason = this.parkingIssue();
            if (reason || this.parkingMenuRequested()) throw new Error(reason || 'Factory parking view requested');
        });
    }

    async shutdown() {
        this.closed = true;
        await this.releaseTest();
        await Promise.all(Object.keys(this.links).map((key) => this.links[key].shutdown()));
    }
}

module.exports = { Probe };
