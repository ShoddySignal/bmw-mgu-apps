'use strict';

const SOURCES = {
    hmi: { iface: 'de.bmw.dass.parking.parkmenu.userinteraction.UserInteractionParkmenu', id: '3056' },
    menu: { iface: 'de.bmw.dass.parking.parkmenu.parkmenuandlayout.ParkmenuAndLayout', id: '3059' },
    cluster: { iface: 'de.bmw.dass.parking.ParkmenuInstrumentCluster', id: '3064' },
    cid: { iface: 'de.bmw.infotainment.hmi.hmicontext.HMIContext', instance: 'HMI_CID' },
    cid2: { iface: 'de.bmw.infotainment.hmi.hmicontext2.HMIContext2' },
    popup: { iface: 'de.bmw.dass.parking.ParkmenuTextForDisplayCid', id: '3076' },
    xview: { iface: 'de.bmw.dass.XView3D', id: '3003' },
    icam: { iface: 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy', id: 'F78A' },
    player: { iface: 'de.bmw.infotainment.video.cameraplayer.CameraPlayer', id: 'F78D' },
    parkPlayer: { iface: 'de.bmw.infotainment.video.cameraplayer.ParkCameraPlayer', id: 'F78F' },
    das: { iface: 'de.bmw.infotainment.video.dasvideo.DasVideo', id: 'F788' },
    display: { iface: 'de.bmw.infotainment.video.videodisplaystatus.VideoDisplayStatus', id: 'B08B' },
    speed: { iface: 'de.bmw.infotainment.vehicle.Vehicle2', id: 'B519' },
    gear: { iface: 'de.bmw.infrastructure.VehicleInformation' },
};

const VIDEO_STATES = { player: 'cameraPlayerState', parkPlayer: 'cameraPlayerState', das: 'dasVideoState' };
const FIELDS = {
    hmi: ['selectedCameraMode', 'selectedCamera', 'automaticCameraSelected', 'operabilitySelectionBar'],
    menu: ['requestParkmenu'],
    cluster: ['parkmenuRequest'],
    cid: ['currentGraphicalContext'],
    cid2: ['currentGraphicalContext'],
    popup: ['displayPopUp'],
    xview: ['CurrentState', 'PosAngleFreecamera'],
    icam: ['currentState', 'cameraProxyState'],
    player: [VIDEO_STATES.player],
    parkPlayer: [VIDEO_STATES.parkPlayer, 'watchdogState'],
    das: [VIDEO_STATES.das, 'watchdogState'],
    display: ['videoDisplayStatus'],
    speed: ['statusCarSpeed2'],
    gear: ['statusGearboxDrive', 'DataPowerTrain2'],
};

const MODES = [
    ['PARKVIEW', 2, 'Parking / 360'],
    ['PANORAMAVIEW', 7, 'Panorama View'],
    ['FREE_CAMERA', 3, '3D View'],
    ['REARVIEW_ONLY', 1, 'Rear view only'],
    ['TRAILER_HITCH', 6, 'Trailer hitch'],
    ['CARWASH', 5, 'Car wash'],
    ['ASSISTVIEW', 8, 'Assist View'],
    ['MPIL', 4, 'MPIL'],
    ['PARKSENSORS_ONLY', 0, 'Parking sensors only'],
];

const CAMERAS = [
    ['FRONT_CAMERA', 1, 'Front camera'],
    ['REAR_CAMERA', 2, 'Rear camera'],
    ['LEFT_CAMERA', 3, 'Left camera'],
    ['RIGHT_CAMERA', 4, 'Right camera'],
    ['PANORAMA_CAMERA', 5, 'Panorama camera'],
    ['AUTOMATIC_CAMERA', 6, 'Automatic camera'],
    ['SEMI_AUTOMATIC_CAMERA', 15, 'Semi-automatic camera'],
];
for (let n = 1; n <= 8; n++) CAMERAS.push(['FREE_CAMERA_' + n, 6 + n, '3D preset ' + n]);
CAMERAS.push(['NO_CAMERA', 0, 'No camera']);

const TOP = ['TOPREARVIEW', 1];
const SIDE = ['SIDEVIEW', 2];
const RFK = ['RFK', 3];
const PERSPECTIVES = [
    ['360 automatic', TOP, ['AUTOMATIC_CAMERA', 0]],
    ['Bird’s-eye view', TOP, ['BIRDSEYE_VIEW', 3]],
    ['Fixed 360', TOP, ['FIXED_CAMERA', 1]],
    ['Free 3D view', TOP, ['FREE_CAMERA', 2]],
    ['Front Panorama', SIDE, ['SIDEVIEW_FRONT', 5]],
    ['Rear Panorama', SIDE, ['SIDEVIEW_REAR', 6]],
    ['Rear camera', RFK, ['RFK_REARVIEW', 11]],
    ['Rear side view', RFK, ['RFK_SIDEVIEW', 12]],
    ['Trailer zoom / 360', TOP, ['TRAILER_ZOOM', 4]],
    ['Trailer zoom / rear', RFK, ['RFK_TRAILER_ZOOM', 13]],
    ['Car wash', TOP, ['CAR_WASH', 9]],
];
const CLIENT_TYPES = [['CLIENT_INDIRECT', 1, 'Indirect client'], ['CLIENT_DIRECT', 0, 'Direct client']];

function enumeration(pair, numeric) { return pair[numeric ? 1 : 0]; }

function call(source, method, id, params, fireAndForget) {
    return { source, method, id, params, fireAndForget: !!fireAndForget };
}

function selection(kind, row, assist) {
    const mode = kind === 'mode';
    const choice = (mode ? MODES : CAMERAS)[row];
    if (!choice) return null;
    const parameter = mode ? 'cameraMode' : 'cameraSelection';
    const method = (assist ? 'assistSelectCamera' : 'hmiSelectCamera') + (mode ? 'Mode' : '');
    const id = assist ? (mode ? '0016' : '0015') : (mode ? '0007' : '0006');
    return {
        label: (assist ? 'Assist (activation point false) / ' : 'HMI / ') + choice[2],
        build(numeric) {
            const params = { [parameter]: enumeration(choice, numeric) };
            if (assist) params.activationPointReached = false;
            return call('hmi', method, id, params, true);
        },
    };
}

function freeView(row) {
    const camera = CAMERAS[row];
    if (!camera || camera[1] < 7 || camera[1] > 14) return null;
    const plan = selection('camera', row, false);
    return Object.assign({}, plan, { label: 'Enter 3D / ' + camera[2], enterFreeView: true });
}

function direct(row, perspective, client, icam) {
    const preset = PERSPECTIVES[row];
    if (!preset || !Number.isInteger(perspective) || perspective < 0 || perspective > 255 || !CLIENT_TYPES[client]) return null;
    return {
        label: (icam ? 'ICAM2 / ' : 'XView3D / ') + preset[0],
        attach: icam ? (numeric) => call('icam', 'clientAttach', '0005', { type: enumeration(CLIENT_TYPES[client], numeric) }) : null,
        build(numeric, cookie) {
            const state = { application: enumeration(preset[1], numeric), mode: enumeration(preset[2], numeric), perspective };
            return icam ? call('icam', 'changeState', '0009', { cookie, desiredState: state })
                : call('xview', 'changePerspective', '0014', { xView3DState: state });
        },
    };
}

const SIMPLE = {
    OPEN_MENU: { label: 'Send cluster parking request', build: () => call('cluster', 'parkmenuRequestedByUser', '0005', {}, true) },
    AUTO_CAMERA: {
        label: 'Select automatic camera',
        build: () => call('hmi', 'hmiSelectAutomaticCamera', '0008', { selectAutomaticCamera: true }, true),
    },
    VIDEO_PARK: {
        label: 'ParkCameraPlayer / startVideo',
        video: 'parkPlayer',
        build: () => call('parkPlayer', 'startVideo', '0002', {}),
    },
    VIDEO_PROTECTED: {
        label: 'ParkCameraPlayer / startProtectedVideo',
        video: 'parkPlayer',
        build: () => call('parkPlayer', 'startProtectedVideo', '0005', {}),
    },
    VIDEO_BASE: {
        label: 'CameraPlayer / startVideo',
        video: 'player',
        build: () => call('player', 'startVideo', '0002', {}),
    },
    VIDEO_DAS: {
        label: 'DasVideo / startVideo',
        video: 'das',
        build: (numeric) => call('das', 'startVideo', '0008', { watchdog: enumeration(['WD_ACTIVE', 1], numeric) }),
    },
};

function menuOpen(modeRow) {
    const plan = selection('mode', modeRow, false);
    if (!plan) return null;
    return Object.assign({}, plan, { label: 'Cluster request / ' + MODES[modeRow][2], enterParkmenu: true });
}

function describe(plan, numeric) {
    const step = plan.build(numeric, '<cookie>');
    const target = SOURCES[step.source].iface.split('.').pop();
    return target + '.' + step.method + ' ' + JSON.stringify(step.params);
}

module.exports = { SOURCES, FIELDS, MODES, CAMERAS, PERSPECTIVES, CLIENT_TYPES, VIDEO_STATES, SIMPLE,
    selection, freeView, direct, menuOpen, call, describe };
