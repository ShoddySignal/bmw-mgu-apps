'use strict';

const DURATION_MS = 90000;
const MAX_CHANGES = 40;
const ACTIVATION_SOURCES = { 0: 'NO_ACTIVATION', 1: 'SBA_ACTIVATION', 2: 'PBA_ACTIVATION', 3: 'BUTTON_ACTIVATION', 20: 'OFFROAD_ACTIVATION' };

function scalar(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '-';
}

function cameraState(value) {
    return [value.application, value.mode, value.perspective].map(scalar).join(' / ');
}

function streamInfo(value) {
    return scalar(value.imageWidth) + 'x' + scalar(value.imageHeight) + ' @ ' + scalar(value.framesPerSecond) + ' fps';
}

const SIGNALS = {
    cid: { currentGraphicalContext: ['CID screen', (v) => scalar(v.visibleContext)] },
    cid2: { currentGraphicalContext: ['CID app/state', (v) => {
        const visual = v.VisualContext || {};
        return [visual.AppletID, visual.StateID].map(scalar).join('/');
    }] },
    menu: { requestParkmenu: ['Park', (v) => [
        v.hmiVisibilityRequest, v.parkmenuLayout, scalar(v.parkmenuRequest).replace(/^PARKMENU_/, ''),
    ].map(scalar).join(' / ')] },
    hmi: { selectedCameraMode: ['Mode', scalar], selectedCamera: ['Camera', scalar] },
    xview: {
        CurrentState: ['XView3D', cameraState],
        PerspectiveChangeTriggered: ['XView3D change', (v) => cameraState(v.xView3DState || v)],
        FeedbackSA2: ['Activation source', (v) => ACTIVATION_SOURCES[v] || scalar(v)],
        Handshake: ['Handshake', (v) => v === 1 ? 'ON' : v === 0 ? 'OFF' : scalar(v)],
        ActivationMode: ['Activation mode', scalar],
    },
    icam: {
        currentState: ['ICAM2', cameraState],
        cameraProxyState: ['Camera link', scalar],
        streamInfo: ['Stream info', streamInfo],
    },
    parkPlayer: { cameraPlayerState: ['Player', scalar] },
    das: { dasVideoState: ['DAS video', scalar] },
    display: { videoDisplayStatus: ['Display video', (v) => scalar(v.cameraPlayerState)] },
};

const summarize = (format, value) => value == null ? '-' : format(value);

class FactoryTrace {
    constructor() {
        this.until = 0;
        this.initial = null;
        this.changes = [];
        this.omitted = 0;
    }

    start(at, read) {
        this.startedAt = at;
        this.until = at + DURATION_MS;
        this.changes = [];
        this.omitted = 0;
        this.last = {};
        Object.keys(SIGNALS).forEach((source) => {
            Object.keys(SIGNALS[source]).forEach((field) => {
                const [label, format] = SIGNALS[source][field];
                this.last[label] = summarize(format, read(source, field));
            });
        });
        this.initial = Object.assign({}, this.last);
    }

    observe(source, field, value, at) {
        if (!this.active(at)) return;
        const signal = SIGNALS[source] && SIGNALS[source][field];
        if (!signal) return;
        const [label, format] = signal;
        const text = summarize(format, value);
        if (this.last[label] === text) return;
        this.last[label] = text;
        this.append(label, text, at);
    }

    mark(label, text, at) {
        if (this.active(at)) this.append(label, text, at);
    }

    append(label, text, at) {
        if (this.changes.length === MAX_CHANGES) {
            this.changes.shift();
            this.omitted++;
        }
        this.changes.push({ elapsed: at - this.startedAt, label, text });
    }

    active(at) { return this.initial !== null && at < this.until; }
    remaining(at) { return Math.max(0, Math.ceil((this.until - at) / 1000)); }
    stop() { this.until = 0; }
}

module.exports = { FactoryTrace, DURATION_MS };
