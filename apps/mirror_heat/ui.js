'use strict';

const { MIRROR_FAULTS } = require('./protocol');
const unknown = 'Unavailable';
const faultRows = Object.keys(MIRROR_FAULTS).map((code) => 'F_' + code);

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
    const heat = value(sample.heating);
    const demand = heat ? heat.demand : null;
    const count = value(sample.counter);
    const faults = value(sample.faults);
    let faultStatus = 'Select Read status';
    if (faults) faultStatus = faults.length ? faults.length + ' matching codes' : 'No matching pending or stored codes';
    else if (sample.faults) faultStatus = 'Unavailable · ' + detail(sample.faults);
    const remaining = monitor.remaining();
    const text = {
        STATUS: remaining ? monitor.message + ' ' + remaining + ' s' : monitor.message,
        HEATING: 'BDC heater status: ' + state(heat && heat.on, 'ON', 'OFF'),
        DEMAND: 'BDC requested output: ' + (demand === null ? unknown : demand + '%'),
        PROTECTION: 'Protection (D321): ' + state(value(sample.protection), 'Active', 'Inactive'),
        PARKING: 'Parking check: ' + (monitor.parked() ? 'P · 0 km/h' : 'waiting for current P and 0 km/h'),
        R_TEST: 'Last test reply: ' + testReply(test),
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
    const view = ['STATUS', 'HEATING', 'DEMAND', 'PROTECTION', 'PARKING'];
    const diagnostics = ['R_TEST', 'BEFORE', 'DURING', 'AFTER', 'FAULT_STATUS', 'IDENT', 'CODED', 'NSC',
        'R_HEAT', 'R_PROTECT', 'R_COUNT', 'R_EQUIPMENT'];
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
                monitor.tick();
                const text = labels(monitor);
                const pending = [];
                if (ui.isVisible('MAIN')) {
                    for (const key of view) changed(key, text[key], () => ui.text(key, text[key]), pending);
                    const confirming = monitor.checking();
                    changed('show-confirm', confirming, () => ui.visible('CONFIRM', confirming), pending);
                    const canRead = !monitor.busy;
                    const canReview = !monitor.busy && !confirming && monitor.now() >= monitor.lockUntil;
                    changed('enable-read', canRead, () => ui.enabled('READ', canRead), pending);
                    changed('enable-review', canReview, () => ui.enabled('REVIEW', canReview), pending);
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
        render();
        return Promise.resolve(result).then(render);
    }

    ui.onClick('READ', () => run(() => monitor.refresh()));
    ui.onClick('REVIEW', () => run(() => monitor.review()));
    ui.onClick('CONFIRM', () => run(() => monitor.confirm()));
    ui.onClick('DETAILS_OPEN', () => {
        monitor.setVisible(false);
        return ui.open('DETAILS');
    });
    function visible() {
        monitor.setVisible(ui.isVisible('MAIN') && ui.hasFocus('MAIN') && !ui.isVisible('DETAILS'));
        render();
    }

    ui.onVisible(visible);
    ui.onFocus(visible);
    const timer = setInterval(() => {
        if (ui.isVisible('MAIN') || ui.isVisible('DETAILS')) render();
    }, 500);
    ctx.app.on('shutdown', () => {
        monitor.setVisible(false);
        clearInterval(timer);
    });
    visible();
    return render;
}

module.exports = { labels, bindUi };
