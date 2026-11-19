# Mirror Heat Check for iDrive 7

Mirror Heat Check tests exterior mirror heating on the BMW X5 G05 with BDC_G05. **Read status** shows the heating state, requested output, protection flag, equipment coding, and NSC activation count. **Review heater test → Start 30 s at 100%** asks the BDC to run the heater for 30 seconds and monitors its reply and status. Rapid repeated presses send a single request.

## Install from USB

Copy both files from `dist/usb/mgu-repo/mirror_heat/` to `mgu-repo/mirror_heat/` on a USB drive. Open **MGU Store → USB** and select **Mirror Heat Check**. The ID7 package uses the SDK on the head unit. [MGU Store USB catalog format](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md#2-catalog)

Build and test from the repository root.

```sh
python3 tools/build_mgu_app.py mirror_heat --test
```

## Test on the vehicle

1. Stop the vehicle, engage the parking brake, and select P. Open **Mirror Heat Check → Read status**. Confirm that **Diagnostics** shows BDC SGBD index `0F2680`. Record the starting temperature of both mirror surfaces, for example with a contact thermometer.
2. On the main screen, select **Review heater test**, then **Start 30 s at 100%**. The app requires current signals for P and 0 km/h, a valid BDC heater status reply, and an inactive protection flag. **Diagnostics** shows the BDC reply, including any negative response code. If the reply is missing, the app keeps reading the BDC status until the test window ends.
3. Compare the temperature of both mirrors after the test. The app shows the shared BDC command and status. Measure each mirror surface separately. The app reads the BDC once more after the timer expires. Normal vehicle-controlled heating may remain active depending on conditions.

A single request sets the test duration in the BDC. Leaving the app ends monitoring. The timer for an accepted request runs in the BDC. The NSC counter records NSC-triggered activations. The app reports it separately from the test result.

The package was tested with simulated TASU responses. Verify firmware compatibility, timer behavior, and physical heating on the target vehicle. [BDC_G05 audit](../../docs/BDC_G05_MIRROR_HEAT_AUDIT.md)
