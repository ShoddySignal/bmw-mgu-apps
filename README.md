# BMW MGU Apps

A shared MGU Store source for BMW iDrive 7 apps. Each app has its own ID, version and releases.

| App | ID | Status |
| --- | --- | --- |
| [Offline Profile Manager](apps/offline_profile_manager/) | `offline_profile_manager` | 0.1.1, read-only pending vehicle validation |
| [Mirror Heat Check](apps/mirror_heat/) | `mirror_heat` | 0.1.1, G05 timed heater test, vehicle validation pending |

## Install through MGU Store

1. Connect MGU Store to the internet. Under **Settings → Accounts**, sign in to GitHub. Grant the **mgu-store** GitHub App read access to this private repository.
2. Under **Settings → Add source**, enter `ShoddySignal/bmw-mgu-apps` and select **Releases**.
3. Select **Check now**. In **Store**, open the app you want and choose **Install**.

Add the source once. MGU Store selects the newest release package for each app ID. [MGU Store documentation](https://github.com/robertnisipeanu/mgu-store/blob/main/docs/PUBLISHING.md#1-releases)

## Add and release an app

1. Put the app under `apps/<id>/` with its own `app.json`, `main.js` and `icon.png`. Match the manifest ID to the directory name and set `"mguHmi": ["ID7"]`. Use a stable, unique ID and an independent `major.minor.patch` version.
2. Build locally with `python3 tools/build_mgu_app.py <id> --test`. The builder runs `tests/test_<id>.js` if present, checks the OAP archives and stages a USB catalog under `dist/usb/mgu-repo/<id>/`. BMW's SDK comes from the firmware when Store installs the app.
3. On GitHub, open **Actions → Publish MGU Store app → Run workflow**. Select `main` and enter the app ID. The workflow publishes the selected app's `<id>@<version>.tgz` in a release tagged `<id>@<version>`. Each release includes titles, descriptions, and icons for all apps because the Store reads one metadata file for the source. To publish an update, set a higher version in that app's manifest.

[Offline Profile Manager vehicle validation](apps/offline_profile_manager/README.md#validate-on-the-vehicle) · [HU_MGU PRG audit](docs/HU_MGU_PRG_AUDIT.md)

## Upstream

[idrive7-apps App Kit](https://github.com/cauliflowermossgrape/idrive7-apps) · [MIT license](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/LICENSE)
