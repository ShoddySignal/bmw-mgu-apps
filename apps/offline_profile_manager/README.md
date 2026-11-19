# Offline Profile Manager for BMW iDrive 7

Diagnostics were tested on a 2022 BMW X5 G05 with HU_MGU, software version `L18_22w18.3-1-6`, variant `mgu-high` and SGBD index `0F25B0`. The app reads accounts when you open it. Select **Refresh profiles** to read them again. No BMW ID, ConnectedDrive connection, Tool32 or ENET connection is required after installation.

Create, activate and rename profiles from the main screen. Each action asks for confirmation and checks that the vehicle is stationary in P before sending a write. Choose **Cancel** to leave a confirmation or discard a draft name. The list marks the current profile as **Active** and refreshes when iDrive reports a profile change.

## Installation

Follow the [GitHub installation instructions](../../README.md#install-through-mgu-store) if your car is online. To install from USB, copy the two files generated in `dist/usb/mgu-repo/offline_profile_manager` to `mgu-repo/offline_profile_manager` on your USB drive. Open **MGU Store → USB**, select **Offline Profile Manager** and choose **Install**. The Store uses SDK components from the existing firmware. [MGU Store USB documentation](https://github.com/robertnisipeanu/mgu-store#offline-usb-stick)

## Create an offline profile

1. With the vehicle in P, choose **Create offline profile** and confirm. The app verifies the new account and applies permanent PIA mode to its slot. The confirmation screen shows the new profile's name.
2. Select the profile in **CAR → Driver Profiles** in iDrive or select its row in the app and confirm activation.
3. Choose **Rename active profile**. The app shows the current profile name and checks the active account again before writing the new name.

The app refreshes the profile list when you return to the main screen. If creation succeeds and permanent PIA setup is interrupted, choose **Finish profile setup** to continue with the saved account.

## Validate on the vehicle

1. Park, select P and keep the physical key with you.
2. Open the app and compare its profile list with the BMW menu. Empty slots are omitted. Activity and account type are shown when available.
3. Under **Diagnostics**, record the SGBD index, software version and variant, parking status and any NRC. Confirm that the app can recognize the stationary vehicle.
4. Select a different existing profile from the BMW menu. Compare the **Active** indicator with the BMW menu after returning to the app. When neither system identifier matches a list entry, the app can match a unique exact name. If that also fails, **Active in iDrive** shows the name from the system when it is available.

**Diagnostics** keeps the last failure available after refreshing the list. It shows the command or operation, the reason and, where available, the ECU refusal code or reply length. It also explains why the app could not confirm Park or the active profile. Share those lines with the SGBD index and software version.

Choose **Diagnostics → Show account details** to compare IDs and names from iDrive and `22 E3 33`. The match counts show how many profiles match either system identifier and how many match the exact system name. Quoted text shows UTF-8 byte lengths, `\x20` for spaces and Unicode escapes for non-ASCII characters. Each driver slot shows the length and first 48 raw name bytes from the ECU in HEX, with `…` marking longer fields. These bytes are available even if a name fails UTF-8 decoding. The app keeps these values on this screen and clears the display when you leave.

On `mgu-high` firmware `L18_22w18.3-1-6`, a 55-byte profile reply was observed with nonzero data after the guest ID. The app uses the seven documented fields for display and write checks and reports any skipped bytes in **Diagnostics**. The decoder requires valid fields and unique account IDs.

| Operation | What to verify on the target unit |
| --- | --- |
| Identify and list | Confirm a `62 F1 50` response with the HU_MGU SGBD index `0F25B0`. Verify the `62 E3 33` layout with both occupied and empty slots. A different index requires checking its own SGBD. |
| Parking | Confirm live `Vehicle2.statusCarSpeed2` reports 0 km/h and that a subscription to `VehicleInformation.statusGearboxDrive` or `DataPowerTrain2` supplies a P event. Samples older than three seconds cannot verify Park. A current selector reading outside P blocks writes. |
| Create | Confirm `71 01 A1 9A`, then `71 03 A1 9A` with status `02`, followed by exactly one new account in `62 E3 33`. A controlled test requires the physical key because creating a profile can affect BMW ID and Digital Key. |
| Permanent PIA during creation | Verify that positions 1–3 in `62 E3 33` correspond to PIA slots `00`–`02`. The app sends `31 01 02 08 04 <slot> 02` and checks for `71 01 02 08`. Verify the effect and persistence on the target unit. |
| Activate from the profile list | Confirm `6E E3 34`. The app checks for a unique match by account ID or SessionManager reference, with a unique exact name as a fallback when both identifiers lack a match. **Diagnostics** distinguishes ECU acceptance from the account match. Repeat the check with two known profiles. |
| Rename | The app verifies that the same system account is still active before sending the request. Confirm `6E E3 35`, then check that the same list entry has the new name. Conflicting identifiers and ambiguous names block renaming. |

The app requires a recognized HU_MGU SGBD index, explicit user confirmation and fresh vehicle signals for each write. It shows the software version and variant in **Diagnostics**. The app reports diagnostic refusal codes and never automatically repeats writes. It never changes diagnostic sessions, uses SecurityAccess, deletes or resets profiles, or interacts with keys. It keeps profile names, full account IDs and VIN out of app logs.

See the [PRG audit](../../docs/HU_MGU_PRG_AUDIT.md) for request bytes, bytecode offsets and response layouts.
