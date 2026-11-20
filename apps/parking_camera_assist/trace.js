'use strict';

const DURATION_MS = 90000;
const MAX_CHANGES = 40;

function scalar(value) {
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '-';
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
    xview: { CurrentState: ['3D perspective', (v) => scalar(v.perspective)] },
    parkPlayer: { cameraPlayerState: ['Player', scalar] },
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
