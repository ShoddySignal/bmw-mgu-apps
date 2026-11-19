'use strict';

const { ProfileDiag } = require('./diag');
const { DiagnosticError, prepareProfileName, MAX_DRIVER_PROFILES, MAX_PROFILE_NAME_BYTES } = require('./profiles');
const { enterProfileName } = require('./speller');
const { Workflow } = require('./workflow');
const { Vehicle, monotonicMs } = require('./vehicle');

const PROFILE_ROWS = ['PROFILE_0', 'PROFILE_1', 'PROFILE_2', 'PROFILE_3'];
const ACCOUNT_DETAIL_SCREENS = ['ACCOUNT_SLOT', 'ACCOUNT_SYSTEM', 'ACCOUNT_IDS'];
const ACCOUNT_SLOT_BUTTONS = ['OPEN_SLOT_1', 'OPEN_SLOT_2', 'OPEN_SLOT_3'];
const PARKING_SCREENS = ['MAIN', 'DETAILS', 'CONFIRM'];
const SPELLER_RETURN_GRACE_MS = 750;
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
    createMissing: 'ECU reported success. Refresh profiles and check the list in iDrive.',
    profileMissing: 'The profile is missing from the list.',
    active: 'Active account could not be verified. Select the profile from the BMW menu.',
    slotChanged: 'The profile slot changed. Open Finish profile setup and confirm again.',
    piaPending: 'Choose Finish profile setup to continue.',
    id: 'The profile ID has an unexpected format for activation.',
    name: 'Enter a profile name with visible characters.',
    nameTooLong: 'Name is too long. Maximum ' + MAX_PROFILE_NAME_BYTES + ' UTF-8 bytes.',
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
    let intent = null, renameNotice = null;
    let refreshPending = true, renderQueued = false, rendering = false;
    let accountDetailScreen, accountDetailFields = [], selectedSlot = null;
    let confirmationText, confirmationWrite = Promise.resolve(), refreshParkedDisplay;
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
        if (intent && intent.phase === 'speller') return false;
        if ((refreshPending && inFront('MAIN')) || work.busy || !link.available || !work.profiles) return false;
        if (action === 'create') return !work.pendingPiaId && work.driverProfileCount < MAX_DRIVER_PROFILES;
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

    function setConfirmationText(text, force) {
        if (force || text !== confirmationText) {
            confirmationText = text;
            confirmationWrite = confirmationWrite.catch(() => {}).then(() => ui.text('CONFIRM_TEXT', text));
        }
        return confirmationWrite;
    }

    function spellerVisibilityChanged() {
        const choice = intent;
        if (!choice || choice.phase !== 'speller') return;
        if (!inFront('MAIN')) {
            choice.leftMain = true;
            clearTimeout(choice.returnTimer);
            choice.returnTimer = null;
        } else if (choice.leftMain && !choice.returnTimer) {
            // MainApp can restore the screen before delivering the last keystroke event.
            choice.returnTimer = setTimeout(choice.cancelInput, SPELLER_RETURN_GRACE_MS);
        }
    }

    function accountRows(screen, systemAccount, profiles) {
        if (screen === 'ACCOUNT_SYSTEM') {
            return [
                ['SYSTEM_ACCOUNT_NAME', accountValue('UserAccount.name', systemAccount && systemAccount.rawName)],
                ['SYSTEM_ACCOUNT_ID', accountValue('UserAccount.id', systemAccount && systemAccount.id)],
                ['SESSION_REFERENCE', accountValue('SessionManager reference', systemAccount && systemAccount.reference)]
            ];
        }
        if (screen === 'ACCOUNT_SLOT') {
            const profile = profiles && profiles.find((entry) => entry.slot === selectedSlot);
            const label = selectedSlot === null ? 'E333 guest' : 'E333 slot ' + selectedSlot;
            const rows = [['SLOT_DETAIL_ID', accountValue(label, profile && profile.id, profiles ? 'Empty' : 'Unavailable')]];
            if (selectedSlot !== null) {
                const field = work.accountNames[selectedSlot - 1];
                rows.push(
                    ['SLOT_DETAIL_NAME', accountValue('Name', field && field.name, field && field.issue)],
                    ['SLOT_DETAIL_HEX', nameHex('Name HEX', field)]
                );
            }
            return rows;
        }
        const matches = work.accountMatches;
        const summary = work.busy ? 'Reading profile details…' : matches ?
            'Matches · ID/reference ' + matches.ids + ' · Exact name ' +
            (matches.names === null ? 'Unavailable' : matches.names) : 'Matches · Unavailable';
        return [['ACCOUNT_MATCHES', summary]].concat(ACCOUNT_SLOT_BUTTONS.map((button, index) => {
            const label = 'Slot ' + (index + 1);
            const profile = profiles && profiles.find((entry) => entry.slot === index + 1);
            const detail = profile ? profileLabel(profile.name) : profiles ? 'Empty' : '';
            return [button, detail ? label + ' · ' + detail : label, label];
        }));
    }

    function renderAccountDetails(systemAccount, profiles) {
        const screen = ACCOUNT_DETAIL_SCREENS.find(inFront);
        if (!screen && !accountDetailScreen) return;
        const cleared = screen === accountDetailScreen ? [] :
            accountDetailFields.map(([component, reset]) => ui.text(component, reset));
        const rows = screen ? accountRows(screen, systemAccount, profiles) : [];
        accountDetailScreen = screen;
        accountDetailFields = rows.map(([component, , reset]) => [component, reset || '']);
        return Promise.all(cleared.concat(rows.map(([component, value]) => ui.text(component, value))));
    }

    async function render() {
        renderQueued = false;
        vehicle.setParkingPolling(PARKING_SCREENS.some(inFront));
        if (inFront('DETAILS') && !refreshParkedDisplay) {
            refreshParkedDisplay = setInterval(schedule, 1000);
            if (refreshParkedDisplay.unref) refreshParkedDisplay.unref();
        } else if (!inFront('DETAILS') && refreshParkedDisplay) {
            clearInterval(refreshParkedDisplay);
            refreshParkedDisplay = null;
        }
        if (refreshPending && !work.busy && link.available &&
            (inFront('MAIN') || ACCOUNT_DETAIL_SCREENS.some(inFront))) {
            refreshPending = false;
            work.refresh();
        }
        const profiles = work.profiles || [];
        const count = work.driverProfileCount;
        const profileCapacity = 'Driver profiles · ' + (count === null ? 'Up to ' : count + ' of ') + MAX_DRIVER_PROFILES;
        const message = status(work);
        const activeId = vehicle.isCurrentAccount(work.active) ? work.active.id : null;
        const systemAccount = vehicle.isCurrentAccount(work.systemAccount) ? work.systemAccount : null;
        const parkingIssue = vehicle.parkingIssue();
        const activeIssue = !work.profiles ? 'Profile list unavailable' : systemAccount ?
            'No unique profile match' : vehicle.activeIssue || 'Checking system account';
        const activeStatus = !activeId ? activeIssue : work.active.matchedByName ? 'Matched by name' :
            work.active.matchedByReference ? 'Matched by reference' : 'Verified';
        const pending = work.pendingPiaId;
        let listMessage = message;
        if (work.state === 'ready' && !profiles.length) listMessage = 'No profiles found.';
        else if ((work.state === 'ready' || work.state === 'activationUnverified') && !activeId && !pending &&
            systemAccount && systemAccount.name) listMessage = 'Active in iDrive · ' + profileLabel(systemAccount.name);
        if (renameNotice && !work.busy && link.available) listMessage = renameNotice;
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
            const confirmationStatus = inFront('CONFIRM') && intent && (intent.phase === 'running' || intent.phase === 'done') ?
                setConfirmationText(message) : null;
            await Promise.all(rows.concat([
                ui.text('STATUS', listMessage),
                ui.text('PROFILE_CAPACITY', profileCapacity),
                ui.enabled('REFRESH', !!link.available && !work.busy),
                ui.text('CREATE', pending ? 'Finish profile setup' : 'Create offline profile'),
                ui.enabled('CREATE', pending ? !!can('resumePia', pending) : !!can('create')),
                ui.enabled('RENAME', !!can('rename', activeId)),
                ui.text('ID_INDEX', 'SGBD index · ' + (work.identity ? work.identity.index : 'Unavailable')),
                ui.text('ID_VERSION', 'Software version · ' + (software ? software.version : 'Unavailable')),
                ui.text('ID_VARIANT', 'Software variant · ' + (software ? software.variantId : 'Unavailable')),
                ui.text('ACTIVE', 'Active account · ' + activeStatus),
                ui.text('PARK', 'Parked · ' + (parkingIssue || 'Verified')),
                ui.text('NRC', diagnostic(work, message)),
                renderAccountDetails(systemAccount, work.profiles),
                confirmationStatus,
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

    function confirm(choice, message) {
        const current = { ...choice, phase: 'confirm' };
        intent = current;
        return setConfirmationText(message, true).then(() => {
            if (intent === current) return ui.open('CONFIRM');
        }).then(schedule);
    }

    PROFILE_ROWS.forEach((name, i) => ui.onClick(name, () => {
        const profile = work.profiles && work.profiles[i];
        if (inFront('MAIN') && profile && can('login', profile.id)) {
            return confirm({ action: 'login', id: profile.id }, 'Activate profile “' + profileLabel(profile.name) + '”?');
        }
    }));
    ui.onClick('REFRESH', () => {
        if (!inFront('MAIN') || !link.available || work.busy) return;
        renameNotice = null;
        refreshPending = false;
        return work.refresh();
    });
    ui.onClick('DIAGNOSTICS', () => { schedule(); return ui.open('DETAILS'); });
    ui.onClick('DETAILS_BACK', () => { if (inFront('DETAILS')) return ui.close('DETAILS'); });
    ui.onClick('SHOW_ACCOUNT_IDS', () => {
        if (!inFront('DETAILS')) return;
        refreshPending = true;
        return ui.open('ACCOUNT_IDS');
    });
    ui.onClick('ACCOUNT_IDS_BACK', () => { if (inFront('ACCOUNT_IDS')) return ui.close('ACCOUNT_IDS'); });
    ui.onClick('OPEN_SYSTEM_ACCOUNT', () => { if (inFront('ACCOUNT_IDS')) return ui.open('ACCOUNT_SYSTEM'); });
    ui.onClick('ACCOUNT_SYSTEM_BACK', () => { if (inFront('ACCOUNT_SYSTEM')) return ui.close('ACCOUNT_SYSTEM'); });
    ui.onClick('ACCOUNT_SLOT_BACK', () => { if (inFront('ACCOUNT_SLOT')) return ui.close('ACCOUNT_SLOT'); });
    async function openAccountSlot(slot) {
        if (!inFront('ACCOUNT_IDS')) return;
        selectedSlot = slot;
        await Promise.all([
            ui.visible('SLOT_DETAIL_NAME', slot !== null),
            ui.visible('SLOT_DETAIL_HEX', slot !== null)
        ]);
        if (inFront('ACCOUNT_IDS') && selectedSlot === slot) return ui.open('ACCOUNT_SLOT');
    }
    ACCOUNT_SLOT_BUTTONS.forEach((button, index) => ui.onClick(button, () => openAccountSlot(index + 1)));
    ui.onClick('OPEN_GUEST_ACCOUNT', () => openAccountSlot(null));
    ui.onClick('CANCEL_CONFIRM', () => {
        if (!inFront('CONFIRM') || !intent || intent.phase !== 'confirm') return;
        intent = null;
        return ui.close('CONFIRM');
    });
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
    ui.onClick('RENAME', async () => {
        const profile = driverProfile(work.active && work.active.id);
        if (!inFront('MAIN') || !profile || !can('rename', profile.id)) return;
        const choice = { action: 'rename', id: profile.id, account: work.systemAccount, phase: 'speller' };
        const cancellation = new Promise((resolve) => { choice.cancelInput = () => resolve(null); });
        intent = choice;
        renameNotice = null;
        schedule();
        try {
            const input = await enterProfileName(ctx.app, cancellation);
            if (intent !== choice || choice.revoked || input === null) return;
            if (!vehicle.isCurrentAccount(choice.account)) {
                renameNotice = ERRORS.active;
                return;
            }
            const value = prepareProfileName(input);
            return confirm({ action: choice.action, id: choice.id, account: choice.account, value },
                'Rename active profile “' + profileLabel(profile.name) + '” to “' + value + '”?');
        } catch (error) {
            if (intent === choice && !choice.revoked) {
                renameNotice = error instanceof DiagnosticError ? errorMessage(error) : 'iDrive text input is unavailable.';
            }
        } finally {
            clearTimeout(choice.returnTimer);
            if (intent === choice) intent = null;
            schedule();
        }
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
        try {
            await work[choice.action](choice.id, choice.value, choice.account);
        } finally {
            if (intent === choice) {
                choice.phase = 'done';
                await setConfirmationText(status(work));
            }
            schedule();
        }
    });
    ui.onVisible((name, on) => {
        if (on && name === 'MAIN') refreshPending = true;
        if (name === 'MAIN') spellerVisibilityChanged();
        if (on || PARKING_SCREENS.includes(name) || ACCOUNT_DETAIL_SCREENS.includes(name)) schedule();
        if (!on && name === 'CONFIRM' && intent && intent.phase === 'running') intent.revoked = true;
        if (!on && name === 'CONFIRM' && intent && (intent.phase === 'confirm' || intent.phase === 'done')) {
            intent = null;
        }
    });
    ui.onFocus((name, on) => {
        if (name === 'MAIN' && on) refreshPending = true;
        if (name === 'MAIN') spellerVisibilityChanged();
        if (PARKING_SCREENS.includes(name) || ACCOUNT_DETAIL_SCREENS.includes(name)) schedule();
        if (name === 'CONFIRM' && !on && intent && intent.phase === 'running') intent.revoked = true;
    });
    link.on('available', (up) => {
        if (!up) {
            work.disconnected();
            if (intent) {
                intent.revoked = true;
                if (intent.phase === 'confirm') {
                    intent.phase = 'done';
                }
                if (intent.phase === 'speller') intent.cancelInput();
            }
        }
        refreshPending = true;
        schedule();
    });
    schedule();
    const version = Promise.resolve().then(() => sdk.runtimeVariant.getSoftwareVersion()).then((value) => {
        if (value && [value.version, value.variantId].every((x) => typeof x === 'string' && /^[\w. -]{1,80}$/.test(x))) software = value;
    }).catch(() => {}).then(schedule);
    await Promise.all([link.init(), vehicle.init().then(schedule), version]);
}

module.exports = { start };
