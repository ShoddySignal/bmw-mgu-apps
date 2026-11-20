# Parking Camera Assist for iDrive 7

Parking Camera Assist tests the parking camera services found in the BMW X5 G05 MGU SOME/IP catalog. It records which requests the app sent and what the vehicle subsequently reported. Choose and confirm each test with the vehicle stopped in P. The app checks current selector and speed signals again at the point of dispatch.

## Planned automatic activation

- **Low speed** opens the selected parking view when the vehicle enters a configurable low-speed range.
- **Obstacle detected** opens the selected parking view when the parking sensors report an obstacle.

The two options are planned as independent settings. The current build provides manual tests and diagnostics to verify camera activation and the vehicle's signals.

## Install through MGU Store

To install online, add `ShoddySignal/bmw-mgu-apps` as a **Releases** source in MGU Store, select **Check now**, then install **Parking Camera Assist** from the **Store** tab. [Full MGU Store installation steps](../../README.md#install-through-mgu-store)

## Install from USB

To prepare a USB package, build and test from the repository root.

```sh
python3 tools/build_mgu_app.py parking_camera_assist --test
```

Copy `catalog.json` and the `.tgz` it lists from `dist/usb/mgu-repo/parking_camera_assist/` to `mgu-repo/parking_camera_assist/` on a USB drive. Open **MGU Store → USB**, select **Parking Camera Assist** and choose **Install**. The package uses the SDK on the head unit. [MGU Store USB catalog format](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md#2-catalog)

## Test a camera

| Screen | Requests available |
| --- | --- |
| **Screen modes** | Parking / 360, Panorama View, 3D View, rear view, trailer hitch, car wash, Assist View, MPIL and sensors only. Select a mode through HMI, try Assist with `activationPointReached=false`, or request the parking menu first via `parkmenuRequestedByUser`. |
| **Cameras and 3D presets** | Front, rear, left, right, Panorama, automatic, semi-automatic and eight `FREE_CAMERA_n` presets. Test the individual selection or enter 3D and then select a preset. |
| **Open menu and video players** | Request the parking menu by itself, select the automatic camera, or test the base CameraPlayer, ParkCameraPlayer normal and protected starts, and DasVideo with `WD_ACTIVE`. Player tests require a reported idle state. After a successful start, the app observes the player for four seconds and requests stop if it still observes playback, the vehicle is parked, and the factory parking menu has not requested visibility. |
| **XView3D and ICAM2** | Try direct perspective requests for 360, bird's-eye, fixed view, free 3D, front or rear Panorama, rear camera, trailer zoom and car wash. Set the perspective byte or take it from the current observed state. The ICAM2 test uses a client cookie obtained through `clientAttach` and releases it with `clientDetach`. |

The confirmation screen shows the call. Use **Send with enum names** first. A separate **Send with enum numbers** option is available for comparing the native binding's enum handling. Each confirmation runs only the selected test. For combined tests, the second call waits for a new parking menu or 3D mode notification. If no matching notification arrives, the log identifies the step where the test stopped.

The eight 3D preset numbers have no side labels in the catalog. To map them on the vehicle, choose **Record factory controls for 90 s**, open the factory camera screen and move around the 3D selector. Note the order by position relative to the car's nose. Compare it with `selectedCamera` and `XView3D.CurrentState.perspective` in the trace.

## Diagnostics

**Live diagnostics** displays the selected mode and camera, the parking layout, the 3D availability flag, XView3D and ICAM2 state, player state, watchdog state and parking pop-ups. The app keeps its subscriptions while its process is running, including when the factory screen has taken focus.

Look for `camera-assist` lines in the app's `data/parking_camera_assist.log` or its rotated `.log.1`. The records include provider availability, a before and after snapshot, the interface, method ID and parameters at dispatch, the native reply or error, and state changes observed while recording. **Dispatched** indicates that a fire-and-forget call returned from the local binding. **Replied** indicates a reply for a request-response call. Actual activation is measured from the observed state and display.

The USB package and local tests verify the app and the catalog signatures. OAP access to each service, behavior of inherited methods and the displayed camera view need validation on the vehicle.
