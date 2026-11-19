# Offline Profile Manager for BMW iDrive 7

Version 0.1.0 is intended for read-only testing on a 2022 BMW X5 G05 with HU_MGU and MGU Store. It reads accounts when you open the app. Select **Refresh profiles** to read them again. No BMW ID, ConnectedDrive connection, Tool32 or ENET connection is required after installation.

Profile creation, activation and renaming workflows have passed simulated tests. The release blocks writes because no target firmware has been validated on the vehicle. Installation and live profile reads still require on-car testing.

## Installation

Follow the [GitHub installation instructions](../../README.md#install-through-mgu-store) if your car is online. To install from USB, copy the two files generated in `dist/usb/mgu-repo/offline_profile_manager` to `mgu-repo/offline_profile_manager` on your USB drive. Open **MGU Store → USB**, select **Offline Profile Manager** and choose **Install**. The Store uses SDK components from the existing firmware. [MGU Store USB documentation](https://github.com/robertnisipeanu/mgu-store#offline-usb-stick)

## Validate on the vehicle

1. Park, select P and keep the physical key with you. Leave writes off.
2. Open the app and compare its profile list with the BMW menu. Empty slots are omitted. Activity and account type are shown when available.
3. Under **Diagnostics**, record the SGBD index, software version and variant, parking status and any NRC. Confirm that the app can recognize the stationary vehicle.
4. Select a different existing profile from the BMW menu. Reopen the app and refresh. Compare the **Active** indicator with the BMW menu. If the app reports **Activity unknown**, share the status and software version without names, full account IDs, VIN or raw frames.

| Operation | What to verify on the target unit |
| --- | --- |
| Identify and list | Confirm a `62 F1 50` response with the HU_MGU SGBD index `0F25B0`. Verify the `62 E3 33` layout with both occupied and empty slots. A different index requires checking its own SGBD. |
| Parking | Confirm live `Vehicle2.statusCarSpeed2` reports 0 km/h and `VehicleInformation.statusGearboxDrive` reports P. Missing signals, unavailable providers and readings older than three seconds block writes. A firmware that does not refresh P needs a verified source of current selector state. |
| Create | Confirm `71 01 A1 9A`, then `71 03 A1 9A` with status `02`, followed by exactly one new account in `62 E3 33`. A controlled test requires the physical key because creating a profile can affect BMW ID and Digital Key. |
| Activate | Confirm `6E E3 34`, then compare the selected ID against the active SessionManager account's `UserAccount.id`. Repeat the check with two known profiles. |
| Rename | Verify the selected account is active before sending the request. Confirm `6E E3 35`, then check that the same ID has the new name. Use the BMW profile menu if the active account cannot be verified. |

The app gates each write operation on a matching SGBD index, exact software version and variant, explicit user confirmation and fresh vehicle signals. A firmware update may require revalidation. The app reports diagnostic refusal codes and never automatically repeats writes. It never changes diagnostic sessions, uses SecurityAccess, deletes or resets profiles, or interacts with keys. It keeps profile names, full account IDs and VIN out of app logs.

See the [PRG audit](../../docs/HU_MGU_PRG_AUDIT.md) for request bytes, bytecode offsets and response layouts.
