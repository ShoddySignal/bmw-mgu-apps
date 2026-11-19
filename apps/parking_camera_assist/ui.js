'use strict';

const { MODES, CAMERAS, PERSPECTIVES, CLIENT_TYPES, SIMPLE, selection, freeView, direct, menuOpen, describe } = require('./plans');

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
    const rows = { mode: 0, camera: 0, raw: 0, client: 0 };
    const push = {};
    let angle = 0;
    let pending = null;
    let rendering = false;
    let openingReview = false;

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
        if (ui.isVisible('CAMERAS')) enable(tasks, 'ENTER_FREE', !!freeView(rows.camera));
        if (ui.isVisible('RAW')) {
            putText(tasks, 'RAW_INDEX', 'Perspective byte: ' + angle);
            enable(tasks, 'RAW_OBSERVED', probe.cameraPerspective() !== null);
        }
        if (ui.isVisible('REVIEW')) {
            const canSend = !!(pending && !issue && !probe.busy && reviewVisible());
            const enumChoices = pending && (pending.attach || describe(pending, false) !== describe(pending, true));
            putText(tasks, 'REVIEW_PARK', probe.busy ? 'Recording test results…' : parking);
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
            putText(tasks, 'HMI_STATE', 'Mode / camera: ' + format(state('hmi', 'selectedCameraMode')) + ' / ' + format(state('hmi', 'selectedCamera')));
            putText(tasks, 'MENU_STATE', 'Layout / visibility: ' + format(layout.parkmenuLayout) + ' / ' + format(layout.hmiVisibilityRequest));
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
        try {
            const request = describe(plan, false);
            const prefix = plan.enterParkmenu ? 'Request menu, then ' : plan.enterFreeView ? 'Enter 3D, then '
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
        const result = probe.run(pending, numeric, reviewVisible);
        render();
        await result;
        await render();
    }

    const navigation = { GO_MODES: 'MODES', GO_CAMERAS: 'CAMERAS', GO_ROUTES: 'ROUTES', GO_RAW: 'RAW', GO_STATE: 'DIAGNOSTICS' };
    Object.keys(navigation).forEach((button) => ui.onClick(button, () => ui.open(navigation[button])));
    ui.onClick('TRACE', () => { probe.startTrace(); return render(); });
    selectRow('MODE_PICK', 'mode', MODES);
    selectRow('CAMERA_PICK', 'camera', CAMERAS);
    selectRow('RAW_PICK', 'raw', PERSPECTIVES);
    selectRow('CLIENT_PICK', 'client', CLIENT_TYPES);

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
