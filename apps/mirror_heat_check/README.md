# Mirror Heat Check for iDrive 7

Mirror Heat Check tests exterior mirror heating on the BMW X5 G05 with BDC_G05. Choose **Duration** (30 seconds, 1, 2, 3, or 4 minutes) and **Power** (25%, 50%, 75%, or 100%), then select **Start test**. The defaults are 4 minutes and 100%. The app updates the reported heater status during the countdown. **Read status** takes a standalone snapshot of the heater state, requested output, protection flag, equipment coding, NSC activation count, and mirror fault memory.

## Install from USB

Build and test from the repository root.

```sh
python3 tools/build_mgu_app.py mirror_heat_check --test
```

Copy `catalog.json` and the `.tgz` it lists from `dist/usb/mgu-repo/mirror_heat_check/` to `mgu-repo/mirror_heat_check/` on a USB drive. Open **MGU Store → USB**, select **Mirror Heat Check** and choose **Install**. The ID7 package uses the SDK on the head unit. [MGU Store USB catalog format](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md#2-catalog)

MGU Store installs `mirror_heat_check` as a separate app. If you previously installed `mirror_heat`, uninstall it in MGU Store to keep a single copy.

## Test on the vehicle

1. Select **Read status** and confirm that **Diagnostics** shows BDC SGBD index `0F2680`. Record the starting temperature of both mirror surfaces, for example with a contact thermometer.
2. Choose the duration and power on the main screen and select **Start test**. The app requires a valid BDC heater status and inactive protection. It also cancels the test if the BDC reports that mirror heating is disabled in the vehicle coding. Keep the main screen open for live readings.
3. Open **Diagnostics**. **Last test reply** shows whether the app sent the request and whether the BDC acknowledged it. A positive reply is `6E D3 2D`. The status snapshots show the shared BDC request and whether the BDC already reported ON before the test. Normal vehicle-controlled heating may remain active after the test.
4. Measure each mirror surface separately and compare it with its starting temperature. If a mirror remains cold, check **Mirror faults** for pending and stored codes related to the heater circuit and mirror LIN modules. Select **Read status** to query fault memory again.

A single request sets the test duration in the BDC. The timer for an accepted request runs in the BDC. The app refreshes the current status when you return to the main screen or the BDC connection recovers. If monitoring was interrupted, it also refreshes at the end of the test window when the main screen is open. The NSC counter records NSC-triggered activations separately from the test result.

Version 0.1.3 was tested on a 2021 BMW X5 G05. The selectable settings in 0.2.0 have been tested with simulated TASU responses. [BDC_G05 audit](../../docs/BDC_G05_MIRROR_HEAT_AUDIT.md)
