'use strict';

const { MIRROR_FAULTS, MAX_TEST_SECONDS, POWER_LEVELS } = require('./protocol');
const unknown = 'Unavailable';
const faultRows = Object.keys(MIRROR_FAULTS).map((code) => 'F_' + code);
const durations = [MAX_TEST_SECONDS, 180, 120, 60, 30];

function value(sample) { return sample ? sample.value : null; }

function state(v, yes, no) {
    return v === true ? yes : v === false ? no : unknown;
}

function detail(sample) {
    if (!sample) return '—';
    return [sample.error, sample.raw].filter(Boolean).join(' · ') || '—';
}

function heatSummary(heat) {
    if (!heat) return '—';
    const on = state(heat.on, 'ON', 'OFF');
    return heat.demand === null ? on : on + ' · ' + heat.demand + '% requested';
}

function testReply(test) {
    if (!test) return 'No test started';
    if (!test.attempted) return test.error ? 'Not sent · ' + test.error : 'Checking test conditions';
    if (!test.error) return test.raw ? 'Accepted · ' + test.raw : 'Waiting for BDC';
    return (test.error.startsWith('NRC ') ? 'Declined · ' : 'Unconfirmed · ') + detail(test);
}

function labels(monitor) {
    const sample = monitor.samples;
    const test = monitor.test;
    const heat = monitor.refreshPending ? null : value(sample.heating);
    const protection = monitor.refreshPending ? null : value(sample.protection);
    const count = value(sample.counter);
    const faults = value(sample.faults);
    let faultStatus = 'Select Read status';
    if (faults) faultStatus = faults.length ? faults.length + ' matching codes' : 'No matching pending or stored codes';
    else if (sample.faults) faultStatus = 'Unavailable · ' + detail(sample.faults);
    const remaining = monitor.remaining();
    const text = {
        STATUS: remaining ? monitor.message + ' ' + remaining + ' s' : monitor.message,
        HEATING: 'BDC heater status: ' + (heat ? heatSummary(heat) : unknown),
        PROTECTION: 'Protection (D321): ' + state(protection, 'Active', 'Inactive'),
        R_TEST: 'Last test reply: ' + testReply(test),
        TEST_SETTINGS: 'Last test settings: ' + (test ? test.seconds + ' s · ' + test.power + '%' : '—'),
        BEFORE: 'Before test: ' + heatSummary(test && test.before),
        DURING: 'During test: ' + heatSummary(test && test.during),
        AFTER: 'After test: ' + heatSummary(test && test.after),
        FAULT_STATUS: 'Mirror faults: ' + faultStatus,
        IDENT: 'BDC SGBD: ' + (value(sample.ident) || detail(sample.ident)),
        CODED: 'Mirror heating coded: ' + state(value(sample.equipment), 'Yes', 'No'),
        NSC: 'NSC activation count: ' + (count === null ? unknown : count),
        R_HEAT: 'D32D: ' + detail(sample.heating),
        R_PROTECT: 'D321: ' + detail(sample.protection),
        R_COUNT: '2305: ' + detail(sample.counter),
        R_EQUIPMENT: 'E450: ' + detail(sample.equipment)
    };
    for (const { code, description, status } of faults || []) {
        text['F_' + code] = code + ' · ' + description + ' · ' + status;
    }
    return text;
}

function bindUi(ctx, monitor) {
    const ui = ctx.ui;
    const sent = {};
    const view = ['STATUS', 'HEATING', 'PROTECTION'];
    const diagnostics = ['R_TEST', 'TEST_SETTINGS', 'BEFORE', 'DURING', 'AFTER', 'FAULT_STATUS', 'IDENT', 'CODED', 'NSC',
        'R_HEAT', 'R_PROTECT', 'R_COUNT', 'R_EQUIPMENT'];
    let duration = durations[0];
    let power = POWER_LEVELS[0];
    let rendering = false;
    let dirty = false;
    function changed(key, value, update, pending) {
        if (sent[key] === value) return;
        sent[key] = value;
        pending.push(update());
    }

    async function render() {
        if (rendering) { dirty = true; return; }
        rendering = true;
        try {
            do {
                dirty = false;
                const text = labels(monitor);
                const pending = [];
                if (ui.isVisible('MAIN')) {
                    for (const key of view) changed(key, text[key], () => ui.text(key, text[key]), pending);
                    for (const key of ['READ', 'DURATION', 'POWER']) {
                        changed('enable-' + key, !monitor.busy, () => ui.enabled(key, !monitor.busy), pending);
                    }
                    const canStart = !monitor.busy && monitor.now() >= monitor.lockUntil;
                    changed('enable-start', canStart, () => ui.enabled('START', canStart), pending);
                }
                if (ui.isVisible('DETAILS')) {
                    for (const key of diagnostics) changed(key, text[key], () => ui.text(key, text[key]), pending);
                    for (const key of faultRows) {
                        const show = !!text[key];
                        if (show) changed(key, text[key], () => ui.text(key, text[key]), pending);
                        changed('show-' + key, show, () => ui.visible(key, show), pending);
                    }
                }
                await Promise.all(pending);
            } while (dirty);
        } catch (error) {
            ctx.log.warn('Mirror heater display: ' + error);
        } finally {
            rendering = false;
        }
    }

    function run(action) {
        const result = action();
        const rendered = render();
        return result ? result.then(render) : rendered;
    }

    function update() {
        return run(() => monitor.refreshIfPending());
    }

    ui.onClick('DURATION', ({ row }) => {
        if (Number.isInteger(row) && durations[row] !== undefined) duration = durations[row];
    });
    ui.onClick('POWER', ({ row }) => {
        if (Number.isInteger(row) && POWER_LEVELS[row] !== undefined) power = POWER_LEVELS[row];
    });
    ui.onClick('READ', () => run(() => monitor.refresh()));
    ui.onClick('START', () => run(() => monitor.start(power, duration)));
    ui.onClick('DETAILS_OPEN', () => {
        monitor.setVisible(false);
        return ui.open('DETAILS');
    });
    function visible() {
        const onScreen = ui.isVisible('MAIN') && !ui.isVisible('DETAILS');
        return run(() => monitor.setVisible(onScreen && ui.hasFocus('MAIN'), onScreen));
    }

    ui.onVisible(visible);
    ui.onFocus(visible);
    const timer = setInterval(() => {
        if (ui.isVisible('MAIN') || ui.isVisible('DETAILS')) update();
    }, 500);
    ctx.app.on('shutdown', () => {
        monitor.setVisible(false);
        clearInterval(timer);
    });
    visible();
    return update;
}

module.exports = { labels, bindUi };
