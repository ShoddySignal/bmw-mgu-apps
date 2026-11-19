'use strict';

const { ProfileDiag, validName, NAME_MAX } = require('./diag');
const { Workflow } = require('./workflow');
const { Vehicle, monotonicMs } = require('./vehicle');
const verified = require('./verified-firmware');

const PROFILE_ROWS = ['PROFILE_0', 'PROFILE_1', 'PROFILE_2', 'PROFILE_3'];
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPES = { guest: 'Guest', local: 'Local', connected: 'BMW ID' };
const ERRORS = {
    offline: 'Connection to HU_MGU lost.',
    transport: 'TASU rejected the request or reported a transport error.',
    timeout: 'ECU reply timed out. Refresh profiles before trying again.',
    variant: 'SGBD index is unrecognized for HU_MGU.',
    payload: 'ECU reply has an unexpected format.',
    parked: 'Fresh readings of 0 km/h and gear P are required.',
    firmware: 'This operation is awaiting validation on this firmware.',
    writeDisabled: 'Writes are off or the confirmation screen lost focus.',
    capacity: 'All three slots are in use.',
    createFailed: 'ECU reported that profile creation failed.',
    createPending: 'ECU has yet to confirm creation. Refresh profiles.',
    createMissing: 'ECU reported completion. A unique new profile could not be identified.',
    profileMissing: 'The selected profile is missing from the list.',
    active: 'Active account could not be verified. Select the profile from the BMW menu.',
    id: 'The profile ID has an unexpected format for activation.',
    name: 'Enter a name using up to 24 ASCII characters.',
    renameMissing: 'ECU accepted the request. The new name is awaiting confirmation.'
};
const CONFIRMED = {
    create: 'Profile confirmed. You can now select Activate.',
    login: 'Active profile confirmed.',
    rename: 'New name confirmed.'
};

function status(workflow) {
    switch (workflow.state) {
    case 'waiting': return 'Waiting for ECU reply...';
    case 'accepted': return 'ECU accepted the request. Checking the result...';
    case 'confirmed': return CONFIRMED[workflow.detail.action];
    case 'ready': return 'Profiles refreshed.';
    case 'error': {
        const error = workflow.detail;
        if (error.code === 'nrc') return 'ECU rejected the request. NRC 0x' + error.nrc.toString(16).toUpperCase().padStart(2, '0') + '.';
        return ERRORS[error.code] || 'The diagnostic operation did not finish.';
    }
    default: return 'Read-only mode. Open the app to connect to HU_MGU.';
    }
}

async function start(ctx, kit, sdk) {
    const { ui, signals, settings } = ctx;
    if (settings.get('writes') !== false) settings.set('writes', false);
    let software = null;
    let sessionInstance;
    try { sessionInstance = sdk.config.get('someip:instances:sessionManager'); } catch (e) { /* SDK variant */ }
    const vehicle = new Vehicle(signals, sessionInstance, monotonicMs);
    const link = new kit.Diag(signals, { info() {}, warn() {} });
    link.quiet = true;
    link.busyLog = false;
    const diag = new ProfileDiag(link, kit.replyTo);
    const inFront = (name) => ui.isVisible(name) && ui.hasFocus(name);
    let selectedId = null, intent = null, draft = '', key = 0;
    let refreshPending = true, renderQueued = false, rendering = false;
    const keys = ctx.spec.screens.find((s) => s.name === 'EDIT').items.find((i) => i[1] === 'CHARACTER')[3];
    const work = new Workflow(diag, vehicle, {
        writeEnabled: () => settings.get('writes') === true,
        visible: () => inFront('CONFIRM') && intent && intent.phase === 'running' && !intent.revoked,
        firmware: () => software,
        verified,
        changed: schedule,
        wait,
        now: monotonicMs
    });

    function selected() {
        return work.profiles && work.profiles.find((p) => p.id === selectedId) || null;
    }

    function can(action) {
        const profile = selected();
        if (work.busy || !link.available || !work.profiles || settings.get('writes') !== true || !work.approved(action)) return false;
        if (action === 'create') return work.profiles.filter((p) => p.type !== 'guest').length < 3;
        if (!profile || profile.type === 'guest') return false;
        if (action === 'login') return profile.id.length === 7;
        return work.active && work.active.id === profile.id;
    }

    function schedule() {
        renderQueued = true;
        if (!rendering) {
            rendering = true;
            setImmediate(render);
        }
    }

    async function render() {
        renderQueued = false;
        if (refreshPending && !work.busy && link.available && inFront('MAIN')) {
            refreshPending = false;
            work.refresh();
        }
        const profiles = work.profiles || [];
        const message = status(work);
        const firmwareReady = ['create', 'login', 'rename'].some((action) => work.approved(action));
        const rows = PROFILE_ROWS.map((name, i) => {
            const profile = profiles[i];
            if (!profile) return ui.visible(name, false);
            const active = work.active ? (work.active.id === profile.id ? 'Active' : 'Inactive') : 'Activity unknown';
            const type = TYPES[profile.type || (work.created.has(profile.id) ? 'local' : null) ||
                (work.active && work.active.id === profile.id ? work.active.type : null)] || 'Unknown type';
            const visibleName = Array.from(profile.name || 'Unnamed').slice(0, 48).join('');
            const position = profile.slot ? 'Slot ' + profile.slot + ' · ' + type : type;
            return ui.cells(name, 0, {
                Text1stRow: (selectedId === profile.id ? '✓ ' : '') + visibleName,
                Text2ndRow: position + ' · ' + active
            }).then(() => ui.visible(name, true));
        });
        try {
            await Promise.all(rows.concat([
                ui.text('CONNECTION', link.available ?
                    (work.identity ? 'HU_MGU · ' + work.identity.index : 'TASU connected') :
                    'TASU unavailable'),
                ui.text('STATUS', work.state === 'ready' && !profiles.length ? 'No profiles found.' : message),
                ui.enabled('REFRESH', !!link.available && !work.busy),
                ui.enabled('CREATE', !!can('create')),
                ui.enabled('LOGIN', !!can('login')),
                ui.enabled('RENAME', !!can('rename')),
                ui.text('WRITE_STATE', firmwareReady ?
                    (settings.get('writes') ? 'Writes are allowed while parked' : 'Writes are off') :
                    'Writes are blocked on this firmware'),
                ui.text('ID_INDEX', 'SGBD index · ' + (work.identity ? work.identity.index : 'Unavailable')),
                ui.text('ID_VERSION', 'Software version · ' + (software ? software.version : 'Unavailable')),
                ui.text('ID_VARIANT', 'Software variant · ' + (software ? software.variantId : 'Unavailable')),
                ui.text('ACTIVE', 'Active account · ' + (work.active ? 'Verified' : 'Unverified')),
                ui.text('PARK', 'Parked · ' + (vehicle.stationary() ? 'Verified' : 'Unverified')),
                ui.text('NRC', message),
                ui.text('DRAFT', 'New name · ' + (draft || '—')),
                ui.enabled('RENAME_NEXT', validName(draft)),
                ui.enabled('APPLY', !work.busy && !!intent && (intent.phase === 'confirm' || intent.phase === 'done')),
                ui.text('APPLY', intent && intent.phase === 'done' ? 'Back to profiles' : 'Confirm')
            ]));
        } finally {
            rendering = false;
            if (renderQueued) schedule();
        }
    }

    function confirm(action, id, name, from) {
        const profile = selected();
        const label = profile ? Array.from(profile.name || 'Unnamed').slice(0, 38).join('') : '';
        const message = {
            create: 'Create a new local profile? This is the second confirmation.',
            login: 'Activate profile “' + label + '”?',
            rename: 'Rename active profile “' + label + '” to “' + name + '”?'
        }[action];
        intent = { action, id, name, phase: 'confirm' };
        const current = intent;
        return Promise.resolve(from && ui.close(from)).then(() => ui.text('CONFIRM_TEXT', message)).then(() => {
            if (intent === current) return ui.open('CONFIRM');
        }).then(schedule);
    }

    PROFILE_ROWS.forEach((name, i) => ui.onClick(name, () => {
        const profile = work.profiles && work.profiles[i];
        if (!inFront('MAIN') || work.busy || !profile) return;
        selectedId = profile.id;
        schedule();
    }));
    ui.onClick('REFRESH', () => {
        if (!inFront('MAIN') || !link.available || work.busy) return;
        refreshPending = false;
        return work.refresh();
    });
    ui.onClick('OPEN_SETTINGS', () => ui.open('SETTINGS'));
    ui.onClick('DIAGNOSTICS', () => { schedule(); return ui.open('DETAILS'); });
    ui.onClick('CREATE', () => {
        if (!inFront('MAIN') || !can('create')) return;
        intent = { action: 'create', phase: 'warning' };
        return ui.open('CREATE_WARNING');
    });
    ui.onClick('CREATE_NEXT', () => {
        if (!inFront('CREATE_WARNING') || !intent || intent.phase !== 'warning' || !can('create')) return;
        return confirm('create', null, null, 'CREATE_WARNING');
    });
    ui.onClick('LOGIN', () => {
        if (inFront('MAIN') && can('login')) return confirm('login', selectedId);
    });
    ui.onClick('RENAME', () => {
        if (!inFront('MAIN') || !can('rename')) return;
        intent = { action: 'rename', id: selectedId, phase: 'edit' };
        draft = '';
        key = 0;
        schedule();
        return ui.selected('CHARACTER', key).then(() => ui.open('EDIT'));
    });
    ui.onClick('CHARACTER', (event) => {
        if (inFront('EDIT') && Number.isInteger(event.row) && keys[event.row]) key = event.row;
    });
    function edit(change) {
        if (!inFront('EDIT') || !intent || intent.phase !== 'edit') return;
        draft = change(draft).slice(0, NAME_MAX);
        schedule();
    }
    ui.onClick('ADD_CHARACTER', () => edit((value) => value + keys[key]));
    ui.onClick('ADD_SPACE', () => edit((value) => value + ' '));
    ui.onClick('ERASE_CHARACTER', () => edit((value) => value.slice(0, -1)));
    ui.onClick('RENAME_NEXT', () => {
        if (!inFront('EDIT') || !intent || intent.phase !== 'edit' || !validName(draft) || !can('rename')) return;
        return confirm('rename', intent.id, draft, 'EDIT');
    });
    ui.onClick('APPLY', async () => {
        if (!inFront('CONFIRM') || !intent || work.busy) return;
        if (intent.phase === 'done') {
            intent = null;
            await ui.close('CONFIRM');
            return;
        }
        const choice = intent;
        if (choice.phase !== 'confirm' || !can(choice.action)) return;
        choice.phase = 'running';
        const update = () => {
            if (intent === choice && choice.phase === 'running') ui.text('CONFIRM_TEXT', status(work));
        };
        const progress = setInterval(update, 350);
        try {
            await work[choice.action](choice.id, choice.name);
        } finally {
            clearInterval(progress);
            if (work.state === 'confirmed' && work.detail.action === 'create') selectedId = work.detail.id;
            if (intent === choice) {
                choice.phase = 'done';
                await ui.text('CONFIRM_TEXT', status(work));
            }
            draft = '';
            schedule();
        }
    });
    ui.onVisible((name, on) => {
        if (on) schedule();
        if (!on && name === 'CONFIRM' && intent && intent.phase === 'running') intent.revoked = true;
        if (!on && intent &&
            ((name === 'CREATE_WARNING' && intent.phase === 'warning') ||
             (name === 'EDIT' && intent.phase === 'edit') ||
             (name === 'CONFIRM' && (intent.phase === 'confirm' || intent.phase === 'done')))) {
            intent = null;
            draft = '';
        }
    });
    ui.onFocus((name, on) => {
        if (name === 'MAIN' && on) schedule();
        if (name === 'CONFIRM' && !on && intent && intent.phase === 'running') intent.revoked = true;
    });
    settings.onChange(schedule);
    link.on('available', (up) => {
        if (!up) {
            work.disconnected();
            selectedId = null;
            if (settings.get('writes') === true) settings.set('writes', false);
        }
        refreshPending = true;
        schedule();
    });
    const refreshParkedDisplay = setInterval(() => {
        if (inFront('DETAILS')) schedule();
    }, 1000);
    if (refreshParkedDisplay.unref) refreshParkedDisplay.unref();

    schedule();
    const version = Promise.resolve().then(() => sdk.runtimeVariant.getSoftwareVersion()).then((value) => {
        if (value && [value.version, value.variantId].every((x) => typeof x === 'string' && /^[\w. -]{1,80}$/.test(x))) software = value;
    }).catch(() => {}).then(schedule);
    await Promise.all([link.init(), vehicle.init().then(schedule), version]);
}

module.exports = { start };
