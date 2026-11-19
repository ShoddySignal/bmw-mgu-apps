'use strict';

const { ProfileDiag, validName, NAME_MAX } = require('./diag');
const { Workflow } = require('./workflow');
const { Vehicle, monotonicMs } = require('./vehicle');

const PROFILE_ROWS = ['PROFILE_0', 'PROFILE_1', 'PROFILE_2', 'PROFILE_3'];
const ACCOUNT_ID_ROWS = [
    ['SLOT_1_ID', 'E333 slot 1', 1],
    ['SLOT_2_ID', 'E333 slot 2', 2],
    ['SLOT_3_ID', 'E333 slot 3', 3],
    ['GUEST_ACCOUNT_ID', 'E333 guest', null]
];
const HEX_PREVIEW_BYTES = 48;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TYPES = { guest: 'Guest', local: 'Local', connected: 'BMW ID' };
const ERRORS = {
    offline: 'Connection to HU_MGU lost.',
    transport: 'TASU rejected the request or reported a transport error.',
    timeout: 'ECU reply timed out. Refresh profiles before trying again.',
    variant: 'SGBD index is unrecognized for HU_MGU.',
    payload: 'ECU reply has an unexpected format.',
    parked: 'Fresh readings of 0 km/h and gear P are required.',
    writeDisabled: 'Confirmation was interrupted. Return to the list and try again.',
    capacity: 'All three slots are in use.',
    createFailed: 'ECU reported that profile creation failed.',
    createPending: 'ECU has yet to confirm creation. Refresh profiles.',
    createMissing: 'ECU reported completion. A unique new profile could not be identified.',
    profileMissing: 'The profile is missing from the list.',
    active: 'Active account could not be verified. Select the profile from the BMW menu.',
    slotChanged: 'The profile slot changed. Open Finish profile setup and confirm again.',
    piaPending: 'Choose Finish profile setup to continue.',
    id: 'The profile ID has an unexpected format for activation.',
    name: 'Enter a name using up to 24 ASCII characters.',
    renameMissing: 'ECU accepted the request. The new name is awaiting confirmation.'
};
const CONFIRMED = {
    login: 'Active profile confirmed.',
    rename: 'New name confirmed.'
};
const CONFIRM_LABELS = { create: 'Create profile', resumePia: 'Finish setup', login: 'Activate profile', rename: 'Save name' };
const OPERATIONS = { refresh: 'Read profiles', create: 'Create profile', pia: 'PIA setup', login: 'Activate profile', rename: 'Rename profile' };

function profileLabel(name) {
    return Array.from(name || 'Unnamed').slice(0, 38).join('');
}

function accountValue(label, value, missing = 'Unavailable') {
    if (typeof value !== 'string') return label + ' · ' + missing;
    const quoted = JSON.stringify(value).replace(/ /g, '\\x20').replace(/[\u007f-\uffff]/g,
        (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase());
    return label + ' · ' + Buffer.byteLength(value, 'utf8') + ' bytes · ' + quoted;
}

function nameHex(label, field) {
    if (!field) return label + ' · Unavailable';
    if (!field.bytes.length) return label + ' · Empty';
    const bytes = field.bytes.slice(0, HEX_PREVIEW_BYTES)
        .map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    return label + ' · ' + field.bytes.length + ' bytes · ' + bytes +
        (field.bytes.length > HEX_PREVIEW_BYTES ? ' …' : '');
}

function errorMessage(error) {
    if (error.code === 'nrc') {
        return 'ECU rejected the request. NRC 0x' + error.nrc.toString(16).toUpperCase().padStart(2, '0') + '.';
    }
    return ERRORS[error.code] || 'The diagnostic operation did not finish.';
}

function diagnostic(workflow, message) {
    const error = workflow.lastIssue;
    if (error) {
        if (error.code === 'activationUnverified') {
            return error.request + ' · Activation accepted · ' + error.reason;
        }
        const previous = workflow.state === 'error' ? '' : 'Last error · ';
        const phase = error.afterAcceptance ? 'After ECU acceptance · ' : '';
        if (error.code === 'payload' && error.request) {
            return previous + error.request + ' · ' + phase + error.replyLength + ' UDS bytes · ' + error.reason;
        }
        const step = error.request || OPERATIONS[error.operation];
        const reason = error.reason || errorMessage(error);
        return previous + (step ? step + ' · ' : '') + phase + reason;
    }
    if (workflow.state === 'ready' && workflow.extraAccountBytes) {
        return '22 E3 33 · Skipped ' + workflow.extraAccountBytes + ' bytes after guest ID.';
    }
    return message;
}

function status(workflow) {
    switch (workflow.state) {
    case 'waiting': return 'Waiting for ECU reply...';
    case 'accepted': return 'ECU accepted the request. Checking the result...';
    case 'settingPia': return 'Profile created. Applying permanent PIA settings...';
    case 'activationUnverified': return 'Activation accepted. Check the active profile in iDrive.';
    case 'confirmed': {
        if (workflow.detail.action !== 'create') return CONFIRMED[workflow.detail.action];
        return 'Created “' + profileLabel(workflow.detail.name) + '”. Select it in the app or in iDrive.';
    }
    case 'ready': return workflow.pendingPiaId ? 'Profile created. Choose Finish profile setup.' : 'Profiles refreshed.';
    case 'error': {
        const error = workflow.detail;
        const message = error.code === 'payload' && error.request ?
            'Unexpected reply to ' + error.request + '. See Diagnostics.' : errorMessage(error);
        return workflow.pendingPiaId ? 'PIA setup pending. ' + message : message;
    }
    default: return 'Connecting to HU_MGU...';
    }
}

async function start(ctx, kit, sdk) {
    const { ui, signals, settings } = ctx;
    let software = null;
    let sessionInstance;
    try { sessionInstance = sdk.config.get('someip:instances:sessionManager'); } catch (e) { /* SDK variant */ }
    const vehicle = new Vehicle(signals, sessionInstance, monotonicMs, () => {
        refreshPending = true;
        schedule();
    });
    const link = new kit.Diag(signals, { info() {}, warn() {} });
    link.quiet = true;
    link.busyLog = false;
    const diag = new ProfileDiag(link, kit.replyTo);
    const inFront = (name) => ui.isVisible(name) && ui.hasFocus(name);
    let intent = null, draft = '', key = 0;
    let refreshPending = true, renderQueued = false, rendering = false;
    let accountDetailsShown = false;
    const keys = ctx.spec.screens.find((s) => s.name === 'EDIT').items.find((i) => i[1] === 'CHARACTER')[3];
    const work = new Workflow(diag, vehicle, {
        visible: () => inFront('CONFIRM') && intent && intent.phase === 'running' && !intent.revoked,
        changed: schedule,
        wait,
        now: monotonicMs,
        pendingPiaId: settings.get('pendingPiaId'),
        savePendingPia: (id) => settings.set('pendingPiaId', id)
    });

    function driverProfile(id) {
        return work.profiles && work.profiles.find((p) => p.id === id && p.type !== 'guest');
    }

    function can(action, id) {
        if ((refreshPending && inFront('MAIN')) || work.busy || !link.available || !work.profiles) return false;
        if (action === 'create') return !work.pendingPiaId && work.profiles.filter((p) => p.type !== 'guest').length < 3;
        const profile = driverProfile(id);
        if (!profile) return false;
        if (action === 'resumePia') return id === work.pendingPiaId;
        const active = vehicle.isCurrentAccount(work.active) && work.active.id === id;
        if (action === 'login') return !active && profile.id.length === 7;
        return active;
    }

    function schedule() {
        renderQueued = true;
        if (!rendering) {
            rendering = true;
            setImmediate(render);
        }
    }

    function renderAccountDetails(systemAccount, profiles) {
        const show = inFront('ACCOUNT_IDS');
        if (!show && !accountDetailsShown) return;
        accountDetailsShown = show;
        const matches = work.accountMatches;
        const rows = [
            ['SYSTEM_ACCOUNT_ID', accountValue('UserAccount.id', systemAccount && systemAccount.id)],
            ['SESSION_REFERENCE', accountValue('SessionManager reference', systemAccount && systemAccount.reference)],
            ['SYSTEM_ACCOUNT_NAME', accountValue('UserAccount.name', systemAccount && systemAccount.rawName)],
            ['ACCOUNT_MATCHES', matches ? 'Matches · ID/reference ' + matches.ids + ' · Exact name ' +
                (matches.names === null ? 'Unavailable' : matches.names) : 'Matches · Unavailable'],
            ...ACCOUNT_ID_ROWS.map(([component, label, slot]) => {
                const profile = profiles && profiles.find((entry) => entry.slot === slot);
                return [component, accountValue(label, profile && profile.id, profiles ? 'Empty' : 'Unavailable')];
            }),
            ...[1, 2, 3].flatMap((slot) => {
                const field = work.accountNames[slot - 1];
                const label = 'E333 slot ' + slot + ' name';
                return [
                    ['SLOT_' + slot + '_NAME', accountValue(label, field && field.name,
                        field && field.issue)],
                    ['SLOT_' + slot + '_NAME_HEX', nameHex(label + ' HEX', field)]
                ];
            })
        ];
        return Promise.all(rows.map(([component, value]) => ui.text(component, show ? value : '')));
    }

    async function render() {
        renderQueued = false;
        if (refreshPending && !work.busy && link.available && (inFront('MAIN') || inFront('ACCOUNT_IDS'))) {
            refreshPending = false;
            work.refresh();
        }
        const profiles = work.profiles || [];
        const message = status(work);
        const activeId = vehicle.isCurrentAccount(work.active) ? work.active.id : null;
        const systemAccount = vehicle.isCurrentAccount(work.systemAccount) ? work.systemAccount : null;
        const parkingIssue = vehicle.parkingIssue();
        const activeIssue = !work.profiles ? 'Profile list unavailable' : systemAccount ?
            'No unique profile match' : vehicle.activeIssue || 'Checking system account';
        const pending = work.pendingPiaId;
        let listMessage = message;
        if (work.state === 'ready' && !profiles.length) listMessage = 'No profiles found.';
        else if ((work.state === 'ready' || work.state === 'activationUnverified') && !activeId && !pending &&
            systemAccount && systemAccount.name) listMessage = 'Active in iDrive · ' + profileLabel(systemAccount.name);
        const rows = PROFILE_ROWS.map((name, i) => {
            const profile = profiles[i];
            if (!profile) return ui.visible(name, false);
            const activate = !!can('login', profile.id);
            const isActive = profile.id === activeId;
            const activity = activate ? 'Select to activate' : activeId ? 'Inactive' : 'Activity unknown';
            const type = TYPES[profile.type || (work.created.has(profile.id) ? 'local' : null) ||
                (isActive ? work.active.type : null)];
            const position = profile.slot ? 'Slot ' + profile.slot + (type ? ' · ' + type : '') : type;
            return Promise.all([
                ui.cells(name, 0, {
                    Text1stRow: (isActive ? 'Active · ' : '') + profileLabel(profile.name),
                    Text2ndRow: isActive ? position : position + ' · ' + activity
                }),
                ui.enabled(name, activate)
            ]).then(() => ui.visible(name, true));
        });
        try {
            await Promise.all(rows.concat([
                ui.text('STATUS', listMessage),
                ui.enabled('REFRESH', !!link.available && !work.busy),
                ui.text('CREATE', pending ? 'Finish profile setup' : 'Create offline profile'),
                ui.enabled('CREATE', pending ? !!can('resumePia', pending) : !!can('create')),
                ui.enabled('RENAME', !!can('rename', activeId)),
                ui.text('ID_INDEX', 'SGBD index · ' + (work.identity ? work.identity.index : 'Unavailable')),
                ui.text('ID_VERSION', 'Software version · ' + (software ? software.version : 'Unavailable')),
                ui.text('ID_VARIANT', 'Software variant · ' + (software ? software.variantId : 'Unavailable')),
                ui.text('ACTIVE', 'Active account · ' + (activeId ?
                    (work.active.matchedByName ? 'Matched by name' : 'Verified') : activeIssue)),
                ui.text('PARK', 'Parked · ' + (parkingIssue || 'Verified')),
                ui.text('NRC', diagnostic(work, message)),
                renderAccountDetails(systemAccount, work.profiles),
                ui.text('DRAFT', 'New name · ' + (draft || '—')),
                ui.enabled('RENAME_NEXT', !!intent && !intent.revoked && validName(draft) && !!can('rename', intent.id)),
                ui.enabled('APPLY', !work.busy && !!intent && (intent.phase === 'done' ||
                    (intent.phase === 'confirm' && !intent.revoked && !!can(intent.action, intent.id)))),
                ui.visible('CANCEL_CONFIRM', !!intent && intent.phase === 'confirm'),
                ui.text('APPLY', intent ? (intent.phase === 'done' ? 'Back to profiles' : CONFIRM_LABELS[intent.action]) : 'Confirm')
            ]));
        } finally {
            rendering = false;
            if (renderQueued) schedule();
        }
    }

    function confirm(choice, message, from) {
        const current = { ...choice, phase: 'confirm' };
        intent = current;
        return Promise.resolve(from && ui.close(from)).then(() => ui.text('CONFIRM_TEXT', message)).then(() => {
            if (intent === current) return ui.open('CONFIRM');
        }).then(schedule);
    }

    function cancel(screen, phase) {
        if (!inFront(screen) || !intent || intent.phase !== phase) return;
        intent = null;
        draft = '';
        return ui.close(screen);
    }

    PROFILE_ROWS.forEach((name, i) => ui.onClick(name, () => {
        const profile = work.profiles && work.profiles[i];
        if (inFront('MAIN') && profile && can('login', profile.id)) {
            return confirm({ action: 'login', id: profile.id }, 'Activate profile “' + profileLabel(profile.name) + '”?');
        }
    }));
    ui.onClick('REFRESH', () => {
        if (!inFront('MAIN') || !link.available || work.busy) return;
        refreshPending = false;
        return work.refresh();
    });
    ui.onClick('DIAGNOSTICS', () => { schedule(); return ui.open('DETAILS'); });
    ui.onClick('DETAILS_BACK', () => { if (inFront('DETAILS')) return ui.close('DETAILS'); });
    ui.onClick('SHOW_ACCOUNT_IDS', () => { if (inFront('DETAILS')) return ui.open('ACCOUNT_IDS'); });
    ui.onClick('ACCOUNT_IDS_BACK', () => { if (inFront('ACCOUNT_IDS')) return ui.close('ACCOUNT_IDS'); });
    ui.onClick('CANCEL_CONFIRM', () => cancel('CONFIRM', 'confirm'));
    ui.onClick('CANCEL_EDIT', () => cancel('EDIT', 'edit'));
    ui.onClick('CREATE', () => {
        if (!inFront('MAIN')) return;
        const pending = driverProfile(work.pendingPiaId);
        if (pending && can('resumePia', pending.id)) {
            return confirm({ action: 'resumePia', id: pending.id, value: pending.slot },
                'Finish permanent PIA setup for “' + profileLabel(pending.name) + '” in slot ' + pending.slot + '?');
        }
        if (!can('create')) return;
        return confirm({ action: 'create' }, 'Create a local profile? This may affect BMW ID and Digital Key. Keep your physical key with you.');
    });
    ui.onClick('RENAME', () => {
        const profile = driverProfile(work.active && work.active.id);
        if (!inFront('MAIN') || !profile || !can('rename', profile.id)) return;
        const label = profileLabel(profile.name);
        intent = { action: 'rename', id: profile.id, label, account: work.systemAccount, phase: 'edit' };
        draft = '';
        key = 0;
        schedule();
        return Promise.all([ui.selected('CHARACTER', key), ui.text('CURRENT_PROFILE', 'Current profile · ' + label)])
            .then(() => ui.open('EDIT'));
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
        if (!inFront('EDIT') || !intent || intent.phase !== 'edit' || intent.revoked || !validName(draft) || !can('rename', intent.id)) return;
        return confirm({ action: 'rename', id: intent.id, value: draft, account: intent.account },
            'Rename active profile “' + intent.label + '” to “' + draft + '”?', 'EDIT');
    });
    ui.onClick('APPLY', async () => {
        if (!inFront('CONFIRM') || !intent || work.busy) return;
        if (intent.phase === 'done') {
            intent = null;
            await ui.close('CONFIRM');
            return;
        }
        const choice = intent;
        if (choice.phase !== 'confirm' || choice.revoked || !can(choice.action, choice.id)) return;
        choice.phase = 'running';
        const update = () => {
            if (intent === choice && choice.phase === 'running') ui.text('CONFIRM_TEXT', status(work));
        };
        const progress = setInterval(update, 350);
        try {
            await work[choice.action](choice.id, choice.value, choice.account);
        } finally {
            clearInterval(progress);
            if (intent === choice) {
                choice.phase = 'done';
                await ui.text('CONFIRM_TEXT', status(work));
            }
            draft = '';
            schedule();
        }
    });
    ui.onVisible((name, on) => {
        if (on && (name === 'MAIN' || name === 'ACCOUNT_IDS')) refreshPending = true;
        if (on || name === 'ACCOUNT_IDS') schedule();
        if (!on && name === 'CONFIRM' && intent && intent.phase === 'running') intent.revoked = true;
        if (!on && intent &&
            ((name === 'EDIT' && intent.phase === 'edit') ||
             (name === 'CONFIRM' && (intent.phase === 'confirm' || intent.phase === 'done')))) {
            intent = null;
            draft = '';
        }
    });
    ui.onFocus((name, on) => {
        if (name === 'ACCOUNT_IDS') schedule();
        if (name === 'MAIN' && on) {
            refreshPending = true;
            schedule();
        }
        if (name === 'CONFIRM' && !on && intent && intent.phase === 'running') intent.revoked = true;
    });
    link.on('available', (up) => {
        if (!up) {
            work.disconnected();
            if (intent) {
                intent.revoked = true;
                if (intent.phase === 'confirm') {
                    intent.phase = 'done';
                    ui.text('CONFIRM_TEXT', status(work));
                }
            }
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
