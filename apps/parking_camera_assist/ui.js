'use strict';

const { MODES, CAMERAS, PERSPECTIVES, CLIENT_TYPES, SIMPLE, CAMERA_ROUTES, PLAYER_CHOICES,
    parkingViewVideo, parkingViewCamera, selection, freeView, direct, menuOpen, describe } = require('./plans');
const TRACE_ROWS = ['TRACE_ROW_1', 'TRACE_ROW_2', 'TRACE_ROW_3', 'TRACE_ROW_4'];

function format(value) {
    if (value === undefined || value === null) return 'unavailable';
    if (typeof value !== 'object') return String(value);
    return JSON.stringify(value);
}

function perspective(value) {
    return value ? [value.application, value.mode, value.perspective].map(format).join(' / ') : 'unavailable';
}

function bindUi(ctx, probe) {
    const ui = ctx.ui;
    const rows = { mode: 0, camera: 0, raw: 0, client: 0, parkRoute: 0, parkPlayer: 0 };
    const push = {};
    let angle = 0;
    let pending = null;
    let reviewResult = '';
    let rendering = false;
    let openingReview = false;
    let tracePage = 0;
    let historyPage = 0;

    const selectRow = (id, key, options) => ui.onClick(id, (event) => {
        if (Number.isInteger(event.row) && options[event.row]) rows[key] = event.row;
        render();
    });
    const inFront = (screen) => ui.isVisible(screen) && ui.hasFocus(screen);
    const reviewVisible = () => inFront('REVIEW');
    const put = (queue, key, value, send) => {
        if (push[key] === value) return;
        push[key] = value;
        queue.push(send());
    };
    const putText = (queue, key, value) => put(queue, key, value, () => ui.text(key, value));
    const enable = (queue, key, value) => put(queue, key, value, () => ui.enabled(key, value));
    const visible = (queue, key, value) => put(queue, key + ':visible', value, () => ui.visible(key, value));

    function renderTrace(tasks) {
        const { initial, changes, omitted } = probe.trace;
        const remaining = probe.traceRemaining();
        const pages = Math.max(1, Math.ceil(changes.length / TRACE_ROWS.length));
        tracePage = Math.min(tracePage, pages - 1);
        const count = changes.length + omitted;
        const status = remaining ? 'Recording (' + remaining + ' s)' : 'Recording ended';
        const page = 'Page ' + (tracePage + 1) + '/' + pages;
        const summary = [status, count + (count === 1 ? ' change' : ' changes'), page];
        if (omitted) summary.push('Showing last ' + changes.length);
        visible(tasks, 'TRACE_START', !remaining);
        visible(tasks, 'TRACE_STOP', !!remaining);
        putText(tasks, 'TRACE_STATUS', initial ? summary.join(' | ')
            : 'Start recording, then open and close the factory camera.');
        if (initial) {
            putText(tasks, 'TRACE_BASELINE', 'Before: CID ' + initial['CID screen'] + ', app/state ' + initial['CID app/state'] +
                ' | Park ' + initial.Park + ' | Activation ' + initial['Activation source'] + ' | Handshake ' + initial.Handshake +
                ' | Stream ' + initial['Stream info']);
        }
        visible(tasks, 'TRACE_BASELINE', !!initial);
        TRACE_ROWS.forEach((key, i) => {
            const change = changes[tracePage * TRACE_ROWS.length + i];
            if (change) putText(tasks, key, '+' + (change.elapsed / 1000).toFixed(1) + ' s  ' + change.label + '  ' + change.text);
            visible(tasks, key, !!change);
        });
        visible(tasks, 'TRACE_PREVIOUS', pages > 1);
        visible(tasks, 'TRACE_NEXT', pages > 1);
        enable(tasks, 'TRACE_PREVIOUS', tracePage > 0);
        enable(tasks, 'TRACE_NEXT', tracePage + 1 < pages);
    }

    async function render() {
        if (rendering) return;
        const tasks = [];
        const issue = probe.parkingIssue();
        const parking = issue || 'P / 0 km/h confirmed';
        if (ui.isVisible('MAIN')) {
            putText(tasks, 'PARKING', parking);
            const seconds = probe.traceRemaining();
            putText(tasks, 'STATUS', probe.status + (seconds ? ' Trace: ' + seconds + ' s' : ''));
        }
        if (ui.isVisible('TRACE_RESULTS')) renderTrace(tasks);
        if (ui.isVisible('PARK_TESTS')) {
            const reference = probe.parkingCamera;
            const waiting = probe.cameraCapture && probe.traceRemaining();
            const hint = waiting ? 'Open Parking View with the BMW button, wait for the image and close it.'
                : 'Capture the factory camera mode first.';
            putText(tasks, 'PARK_CAMERA_REFERENCE', reference ? 'Captured ' + perspective(reference.state) : hint);
            enable(tasks, 'PARK_CAPTURE_CAMERA', !probe.busy);
            enable(tasks, 'PARK_REVIEW_CAMERA', !!reference && !probe.busy);
        }
        if (ui.isVisible('TEST_HISTORY')) {
            const count = probe.results.length;
            const entry = probe.results[historyPage];
            putText(tasks, 'HISTORY_POSITION', entry ? 'Result ' + (historyPage + 1) + '/' + count : 'Run a test to see its result.');
            putText(tasks, 'HISTORY_LABEL', entry ? entry.label : '');
            putText(tasks, 'HISTORY_RESULT', entry ? entry.status : '');
            const cameras = entry && entry.cameras;
            if (cameras) putText(tasks, 'HISTORY_CAMERAS', 'XView3D ' + perspective(cameras.xview) + ' | ICAM2 ' + perspective(cameras.icam));
            visible(tasks, 'HISTORY_CAMERAS', !!cameras);
            visible(tasks, 'HISTORY_OLDER', count > 1);
            visible(tasks, 'HISTORY_NEWER', count > 1);
            enable(tasks, 'HISTORY_OLDER', historyPage + 1 < count);
            enable(tasks, 'HISTORY_NEWER', historyPage > 0);
        }
        if (ui.isVisible('CAMERAS')) enable(tasks, 'ENTER_FREE', !!freeView(rows.camera));
        if (ui.isVisible('RAW')) {
            putText(tasks, 'RAW_INDEX', 'Perspective byte: ' + angle);
            enable(tasks, 'RAW_OBSERVED', probe.cameraPerspective() !== null);
        }
        if (ui.isVisible('REVIEW')) {
            const canSend = !!(pending && !issue && !probe.busy && reviewVisible());
            const enumChoices = pending && (pending.attach || describe(pending, false) !== describe(pending, true));
            putText(tasks, 'REVIEW_PARK', probe.busy ? 'Recording test results…' : parking);
            if (reviewResult) putText(tasks, 'REVIEW_RESULT', reviewResult);
            visible(tasks, 'REVIEW_RESULT', !!reviewResult);
            enable(tasks, 'RUN_NAMES', canSend);
            enable(tasks, 'RUN_NUMBERS', canSend);
            put(tasks, 'numeric-visible', !!enumChoices, () => ui.visible('RUN_NUMBERS', !!enumChoices));
        }
        if (ui.isVisible('DIAGNOSTICS')) {
            const state = (source, field) => probe.value(source, field);
            const layout = state('menu', 'requestParkmenu') || {};
            const selectionBar = state('hmi', 'operabilitySelectionBar') || {};
            const display = state('display', 'videoDisplayStatus') || {};
            const popup = state('popup', 'displayPopUp') || {};
            const cid = state('cid', 'currentGraphicalContext') || {};
            const visual = (state('cid2', 'currentGraphicalContext') || {}).VisualContext || {};
            putText(tasks, 'HMI_STATE', 'Mode / camera: ' + format(state('hmi', 'selectedCameraMode')) + ' / ' + format(state('hmi', 'selectedCamera')));
            putText(tasks, 'MENU_STATE', 'Layout / visibility: ' + format(layout.parkmenuLayout) + ' / ' + format(layout.hmiVisibilityRequest));
            putText(tasks, 'CID_CONTEXT', 'CID context: ' + format(cid.visibleContext));
            putText(tasks, 'CID_CONTEXT2', 'CID applet / state: ' + [visual.AppletID, visual.StateID].map(format).join(' / '));
            putText(tasks, 'FREE_STATE', '3D available / angle: ' + format(selectionBar.freeViewOperable) + ' / ' + format(state('xview', 'PosAngleFreecamera')));
            putText(tasks, 'XVIEW_STATE', 'XView3D: ' + perspective(state('xview', 'CurrentState')));
            putText(tasks, 'ICAM_STATE', 'ICAM2: ' + perspective(state('icam', 'currentState')));
            putText(tasks, 'PLAYER_STATE', 'Park player / base: ' + format(state('parkPlayer', 'cameraPlayerState')) + ' / ' + format(state('player', 'cameraPlayerState')));
            putText(tasks, 'DAS_STATE', 'DAS / watchdog: ' + format(state('das', 'dasVideoState')) + ' / ' + format(state('das', 'watchdogState')));
            putText(tasks, 'DISPLAY_STATE', 'Display / watchdog: ' + format(display.cameraPlayerState) + ' / ' + format(display.watchdogState));
            putText(tasks, 'POPUP_STATE', 'Parking pop-up: ' + format(popup.popUpId));
            putText(tasks, 'LAST_RESULT', probe.status);
        }
        if (!tasks.length) return;
        rendering = true;
        try { await Promise.all(tasks); }
        finally { rendering = false; }
    }

    async function review(plan) {
        if (!plan || probe.busy || openingReview) return;
        openingReview = true;
        pending = null;
        reviewResult = '';
        try {
            const request = describe(plan, false);
            const prefix = plan.enterParkmenu ? 'Send cluster request, then ' : plan.enterFreeView ? 'Enter 3D, then '
                : plan.attach ? 'Attach ICAM2, then ' : '';
            await Promise.all([ui.text('REVIEW_NAME', plan.label), ui.text('REVIEW_REQUEST', prefix + request)]);
            pending = plan;
            await ui.open('REVIEW');
        } finally {
            openingReview = false;
        }
        await render();
    }

    async function send(numeric) {
        if (!pending || probe.busy) return;
        reviewResult = '';
        const result = probe.run(pending, numeric, reviewVisible);
        render();
        await result;
        reviewResult = probe.status;
        await render();
    }

    const navigation = {
        GO_TRACE: 'TRACE_RESULTS', GO_MODES: 'MODES', GO_CAMERAS: 'CAMERAS',
        GO_ROUTES: 'ROUTES', GO_RAW: 'RAW', GO_STATE: 'DIAGNOSTICS',
        GO_PARK_TESTS: 'PARK_TESTS',
    };
    Object.keys(navigation).forEach((button) => ui.onClick(button, () => ui.open(navigation[button])));
    function reviewParkingView(plan) {
        if (plan) return review(plan);
        probe.status = 'Open and close Parking View once with the BMW button to capture CID 20251.';
        return render();
    }
    ui.onClick('OPEN_PARKING_VIEW', () => reviewParkingView(probe.parkingView));
    ui.onClick('PARK_PROTECTED_VIDEO', () => reviewParkingView(parkingViewVideo(probe.parkingView, false)));
    ui.onClick('PARK_DAS_VIDEO', () => reviewParkingView(parkingViewVideo(probe.parkingView, true)));
    ui.onClick('PARK_CAPTURE_CAMERA', () => { probe.armCameraCapture(); return render(); });
    ui.onClick('PARK_REVIEW_CAMERA', () => review(parkingViewCamera(probe.parkingCamera, rows.parkRoute, rows.parkPlayer)));
    ui.onClick('GO_TEST_HISTORY', () => { historyPage = 0; return ui.open('TEST_HISTORY'); });
    ui.onClick('HISTORY_OLDER', () => {
        if (historyPage + 1 < probe.results.length) historyPage++;
        return render();
    });
    ui.onClick('HISTORY_NEWER', () => { historyPage = Math.max(0, historyPage - 1); return render(); });
    ui.onClick('TRACE_START', () => {
        if (probe.traceRemaining()) return;
        tracePage = 0;
        probe.startTrace();
        return render();
    });
    ui.onClick('TRACE_STOP', () => {
        if (probe.traceRemaining()) probe.stopTrace();
        return render();
    });
    ui.onClick('TRACE_PREVIOUS', () => { tracePage = Math.max(0, tracePage - 1); return render(); });
    ui.onClick('TRACE_NEXT', () => { tracePage++; return render(); });
    selectRow('MODE_PICK', 'mode', MODES);
    selectRow('CAMERA_PICK', 'camera', CAMERAS);
    selectRow('RAW_PICK', 'raw', PERSPECTIVES);
    selectRow('CLIENT_PICK', 'client', CLIENT_TYPES);
    selectRow('PARK_CAMERA_ROUTE', 'parkRoute', CAMERA_ROUTES);
    selectRow('PARK_PLAYER_PICK', 'parkPlayer', PLAYER_CHOICES);

    ui.onClick('HMI_MODE', () => review(selection('mode', rows.mode, false)));
    ui.onClick('ASSIST_MODE', () => review(selection('mode', rows.mode, true)));
    ui.onClick('MENU_MODE', () => review(menuOpen(rows.mode)));
    ui.onClick('HMI_CAMERA', () => review(selection('camera', rows.camera, false)));
    ui.onClick('ASSIST_CAMERA', () => review(selection('camera', rows.camera, true)));
    ui.onClick('ENTER_FREE', () => review(freeView(rows.camera)));
    Object.keys(SIMPLE).forEach((button) => ui.onClick(button, () => review(SIMPLE[button])));
    ui.onClick('RAW_MINUS', () => { angle = Math.max(0, angle - 1); return render(); });
    ui.onClick('RAW_PLUS', () => { angle = Math.min(255, angle + 1); return render(); });
    ui.onClick('RAW_OBSERVED', () => {
        const observed = probe.cameraPerspective();
        if (observed !== null) angle = observed;
        return render();
    });
    ui.onClick('RAW_XVIEW', () => review(direct(rows.raw, angle, rows.client, false)));
    ui.onClick('RAW_ICAM', () => review(direct(rows.raw, angle, rows.client, true)));
    ui.onClick('RUN_NAMES', () => send(false));
    ui.onClick('RUN_NUMBERS', () => send(true));

    const refresh = () => render().catch((error) => ctx.log.warn('Camera probe display: ' + error));
    const timer = setInterval(refresh, 500);
    ui.onVisible(refresh);
    ui.onFocus(refresh);
    ctx.app.on('shutdown', () => {
        clearInterval(timer);
        probe.shutdown().catch((error) => ctx.log.warn('Camera probe shutdown: ' + error));
    });
    refresh();
}

module.exports = { bindUi };
