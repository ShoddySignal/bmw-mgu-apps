# Mirror Heat Check for iDrive 7

Mirror Heat Check tests exterior mirror heating on the BMW X5 G05 with BDC_G05. **Read status** checks the BDC heater state, requested output, protection flag, equipment coding, NSC activation count, and mirror fault memory. **Review heater test → Start 30 s at 100%** asks the BDC to run the heater for 30 seconds. The app monitors the acknowledgement and the reported heater status before, during, and after the test. Rapid repeated presses send a single request.

## Install from USB

Copy both files from `dist/usb/mgu-repo/mirror_heat_check/` to `mgu-repo/mirror_heat_check/` on a USB drive. Open **MGU Store → USB** and select **Mirror Heat Check**. The ID7 package uses the SDK on the head unit. [MGU Store USB catalog format](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md#2-catalog)

MGU Store installs `mirror_heat_check` as a separate app. If you previously installed `mirror_heat`, uninstall it in MGU Store to keep a single copy.

The app subscribes to selector notifications on ID7 firmware with notification-only gearbox fields. **Read status** uses the BDC directly and is available without selector notifications.

Build and test from the repository root.

```sh
python3 tools/build_mgu_app.py mirror_heat_check --test
```

## Test on the vehicle

1. Stop the vehicle, engage the parking brake, and select P. Open **Mirror Heat Check → Read status**. Confirm that **Diagnostics** shows BDC SGBD index `0F2680`. Record the starting temperature of both mirror surfaces, for example with a contact thermometer.
2. On the main screen, select **Review heater test**, then **Start 30 s at 100%**. The app requires current signals for P and 0 km/h, a valid BDC heater status reply, and an inactive protection flag. Let the test finish with the main screen open.
3. Open **Diagnostics**. **Last test reply** shows whether the app sent the request and whether the BDC acknowledged it. A positive reply is `6E D3 2D`. The status snapshots show the shared BDC request and whether the BDC already reported ON before the test. Normal vehicle-controlled heating may remain active after the test.
4. Measure each mirror surface separately and compare it with its starting temperature. If a mirror remains cold, check **Mirror faults** for pending and stored codes related to the heater circuit and mirror LIN modules. Select **Read status** to query fault memory again.

A single request sets the test duration in the BDC. Leaving the main screen ends monitoring. The timer for an accepted request runs in the BDC. The NSC counter records NSC-triggered activations. The app reports it separately from the test result.

The package was tested with simulated TASU responses. Verify firmware compatibility, timer behavior, and physical heating on the target vehicle. [BDC_G05 audit](../../docs/BDC_G05_MIRROR_HEAT_AUDIT.md)
