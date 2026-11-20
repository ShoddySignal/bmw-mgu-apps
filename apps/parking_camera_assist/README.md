# Parking Camera Assist for iDrive 7

Parking Camera Assist tests the parking camera services found in the BMW X5 G05 MGU SOME/IP catalog. It records which requests the app sent and what the vehicle subsequently reported. Choose and confirm each test with the vehicle stopped in P. The app checks current selector and speed signals again at the point of dispatch.

Opening the factory camera screen from the app still needs validation. `parkmenuRequestedByUser` belongs to `ParkmenuInstrumentCluster`. The mode, perspective and video player calls test those functions individually. The app records the central display context to investigate `HMIControl.requestGraphicalContext`.

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

On the tested G05, **Test opening Parking View** opened context `20251` with no camera image. To set up a test, open and close Parking View once with the BMW button while the app is running. The app uses the three captured context fields to request the same screen with `HMIControl.requestGraphicalContext`.

**Parking View + protected video** and **Parking View + DAS video** test the video step after the central display confirms `20251`. Each test requires the selected player to report `VIDEO_IDLE`. The report shows the reply from HMI and the player and display states after four seconds. `VIDEO_NO_DATA` indicates that a player reports a lack of video data. Check whether the camera image appears during the test. The combined tests need validation on the vehicle.

To test the camera mode as well, open **Parking View camera tests** and choose **Capture factory camera mode**. Open ordinary Parking View once with the BMW button, wait for the image and close it. The app keeps the camera mode it observed while the factory screen was visible. Choose **XView3D** or **ICAM2 indirect**, choose whether to request a player after camera mode confirmation, and open **Review test**. Close Parking View after each attempt. The same factory capture can be used for every route while the app is running. **Test results** holds the last 12 attempts. Check the actual display during each run and note which tests showed an image.

| Screen | Requests available |
| --- | --- |
| **Screen modes** | Parking / 360, Panorama View, 3D View, rear view, trailer hitch, car wash, Assist View, MPIL and sensors only. Select a mode through HMI, try Assist with `activationPointReached=false`, or send `parkmenuRequestedByUser` to the instrument cluster interface before attempting mode selection. |
| **Cameras and 3D presets** | Front, rear, left, right, Panorama, automatic, semi-automatic and eight `FREE_CAMERA_n` presets. Test the individual selection or enter 3D and then select a preset. |
| **Cluster and video player tests** | Send the cluster parking request, select the automatic camera, or test the base CameraPlayer, ParkCameraPlayer normal and protected starts, and DasVideo with `WD_ACTIVE`. Player tests require a reported idle state. After a successful start, the app observes the player for four seconds and requests stop if it still observes playback, the vehicle is parked, and the factory parking menu has not requested visibility. |
| **XView3D and ICAM2** | Try direct perspective requests for 360, bird's-eye, fixed view, free 3D, front or rear Panorama, rear camera, trailer zoom and car wash. Set the perspective byte or take it from the current observed state. The ICAM2 test uses a client cookie obtained through `clientAttach` and releases it with `clientDetach`. |

The confirmation screen shows the call. Use **Send with enum names** first. A separate **Send with enum numbers** option is available for comparing the native binding's enum handling. Each confirmation runs only the selected test. For combined tests, the second call waits for a new parking menu or 3D mode notification. If no matching notification arrives, the log identifies the step where the test stopped.

The eight 3D preset numbers have no side labels in the catalog. To map them on the vehicle, start a **Factory trace**, open Parking View, open its camera menu, select 3D, then choose sides one at a time with a short pause between actions. Note the order by position relative to the car's nose. The **XView3D**, **XView3D change**, and **ICAM2** rows show application, mode and perspective in that order. The G05 reported `20251 → 20541 → 20251` while switching to 3D from the Parking View menu. Which action caused the temporary `20541` needs validation.

## Diagnostics

While parked with the camera closed, open **Factory trace** and select **Record for 90 s**. Wait a few seconds, open 360 with the factory button, wait again and close it. Return to **Factory trace** and select **Stop recording** if the timer is still running. Photograph the relevant pages before starting a separate recording for Panorama View.

The screen shows the starting display IDs and parking menu state, followed by up to 40 changes with times relative to the start. Use **Previous page** and **Next page** to browse. A dash means the field has yet to report a value or has become unavailable. The screen retains the last recording while the app process is running. Starting another recording replaces it.

The file also contains both full `currentGraphicalContext` structures under `cid` (`HMIContext`, `HMI_CID`) and `cid2` (`HMIContext2`, instance `1`). A parking overlay may leave the reported context unchanged.

To compare a working camera with the app request, keep **Factory trace** running. Open and close Parking View with the BMW button, then return to the main menu and run **Test opening Parking View** or one of the video tests. The trace records both runs in order and marks the start of the programmatic test, its SDK calls and replies. **Activation source** is XView3D's `FeedbackSA2`. **Handshake**, **Camera link**, and **Stream info** show what the camera interfaces reported. Stream info describes the video format, so compare it with the player and display states and what appeared on the display.

**Live diagnostics** displays the central display context, the selected mode and camera, the parking layout, the 3D availability flag, XView3D and ICAM2 state, player state, watchdog state and parking pop-ups. The app keeps its subscriptions while its process is running, including when the factory screen has taken focus.

Look for `camera-assist` lines in the app's `data/parking_camera_assist.log` or its rotated `.log.1`. The records include provider availability, a before and after snapshot, the interface, method ID and parameters at dispatch, the native reply or error, and state changes observed while recording. **Dispatched** indicates that a fire-and-forget call returned from the local binding. **Replied** indicates a reply for a request-response call. Actual activation is measured from the observed state and display.

The USB package and local tests verify the app and the catalog signatures. OAP access to each service, behavior of inherited methods and the displayed camera view need validation on the vehicle.
