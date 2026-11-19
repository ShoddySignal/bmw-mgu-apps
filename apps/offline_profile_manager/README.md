# Offline Profile Manager for BMW iDrive 7

Version 0.1.1 is intended for read-only testing on a 2022 BMW X5 G05 with HU_MGU and MGU Store. It reads accounts when you open the app. Select **Refresh profiles** to read them again. No BMW ID, ConnectedDrive connection, Tool32 or ENET connection is required after installation.

Profile creation, permanent PIA selection, account activation and renaming workflows have passed simulated tests. The firmware allowlist is empty, so the app runs in read-only mode. Installation and live profile reads still require on-car testing.

## Installation

Follow the [GitHub installation instructions](../../README.md#install-through-mgu-store) if your car is online. To install from USB, copy the two files generated in `dist/usb/mgu-repo/offline_profile_manager` to `mgu-repo/offline_profile_manager` on your USB drive. Open **MGU Store → USB**, select **Offline Profile Manager** and choose **Install**. The Store uses SDK components from the existing firmware. [MGU Store USB documentation](https://github.com/robertnisipeanu/mgu-store#offline-usb-stick)

## Create an offline profile on validated firmware

1. Choose **Create offline profile** and confirm. The app verifies the new account and applies permanent PIA mode to its slot. The confirmation screen shows the new profile's name.
2. Select the profile in **CAR → Driver Profiles** in iDrive. If in-app activation is approved for the firmware, you can also select its row in the app and confirm activation.
3. Choose **Rename active profile**. The app shows the current profile name and checks the active account again before writing the new name.

The app refreshes the profile list when you return to the main screen. If creation succeeds and permanent PIA setup is interrupted, choose **Finish profile setup** to continue with the saved account.

## Validate on the vehicle

1. Park, select P and keep the physical key with you. Leave writes off.
2. Open the app and compare its profile list with the BMW menu. Empty slots are omitted. Activity and account type are shown when available.
3. Under **Diagnostics**, record the SGBD index, software version and variant, parking status and any NRC. Confirm that the app can recognize the stationary vehicle.
4. Select a different existing profile from the BMW menu. Reopen the app and refresh. Compare the **Active** indicator with the BMW menu. If the app reports **Activity unknown**, share the status and software version without names, full account IDs, VIN or raw frames.

If the app reports an unexpected reply, **Diagnostics** shows the request identifier, UDS reply size and the reason the parser rejected it. Share that line with the SGBD index and software version.

On `mgu-high` firmware `L18_22w18.3-1-6`, a 55-byte profile reply was observed with nonzero data after the guest ID. The app displays the decoded profiles and shows the number of skipped bytes in **Diagnostics**. Writes require a reply with a validated layout.

| Operation | What to verify on the target unit |
| --- | --- |
| Identify and list | Confirm a `62 F1 50` response with the HU_MGU SGBD index `0F25B0`. Verify the `62 E3 33` layout with both occupied and empty slots. A different index requires checking its own SGBD. |
| Parking | Confirm live `Vehicle2.statusCarSpeed2` reports 0 km/h and `VehicleInformation.statusGearboxDrive` reports P. Missing signals, unavailable providers and readings older than three seconds block writes. A firmware that does not refresh P needs a verified source of current selector state. |
| Create | Confirm `71 01 A1 9A`, then `71 03 A1 9A` with status `02`, followed by exactly one new account in `62 E3 33`. A controlled test requires the physical key because creating a profile can affect BMW ID and Digital Key. |
| Permanent PIA during creation | Verify that positions 1–3 in `62 E3 33` correspond to PIA slots `00`–`02`. The app sends `31 01 02 08 04 <slot> 02` and checks for `71 01 02 08`. Verify the effect and persistence on the target unit before enabling `pia` for its firmware. The create button requires approval for both `create` and `pia`. |
| Activate from the profile list | Confirm `6E E3 34`, then compare the selected ID against the active SessionManager account's `UserAccount.id`. Repeat the check with two known profiles. |
| Rename | Verify the selected account is active before sending the request. Confirm `6E E3 35`, then check that the same ID has the new name. Use the BMW profile menu if the active account cannot be verified. |

The app gates each write operation on a matching SGBD index, exact software version and variant, explicit user confirmation and fresh vehicle signals. A firmware update may require revalidation. The app reports diagnostic refusal codes and never automatically repeats writes. It never changes diagnostic sessions, uses SecurityAccess, deletes or resets profiles, or interacts with keys. It keeps profile names, full account IDs and VIN out of app logs.

See the [PRG audit](../../docs/HU_MGU_PRG_AUDIT.md) for request bytes, bytecode offsets and response layouts.
