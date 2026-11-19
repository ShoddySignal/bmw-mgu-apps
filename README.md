# BMW MGU Apps

A shared MGU Store source for BMW iDrive 7 apps. Each app has its own ID, version and releases.

| App | ID | Status |
| --- | --- | --- |
| [Offline Profile Manager](apps/offline_profile_manager/) | `offline_profile_manager` | 0.1.13, BMW X5 G05 test configuration (`L18_22w18.3-1-6`, `mgu-high`) |
| [Mirror Heat Check](apps/mirror_heat_check/) | `mirror_heat_check` | 0.1.3, four-minute G05 heater test, vehicle validation pending |

## Install through MGU Store

1. Connect the head unit to the internet and open **MGU Store**.
2. Go to **Settings → Add source**, enter `ShoddySignal/bmw-mgu-apps`, and select **OK**. Choose **Releases** when the Store asks what to follow.
3. Go back to **Settings**, select **Check now**, and wait for the app list to refresh.
4. Open **Store**, choose **Offline Profile Manager** or **Mirror Heat Check**, then select **Install**. When installation finishes, open the app from the iDrive app menu.

The repository is public and can be added without signing in to GitHub. Add the source once for both apps. MGU Store installs the latest published version of each app. [Published versions on GitHub](https://github.com/ShoddySignal/bmw-mgu-apps/releases)

To update an installed app later, select **Check now** and use **Installed → Update**. [MGU Store documentation](https://github.com/robertnisipeanu/mgu-store#sources)

## Add and release an app

1. Put the app under `apps/<id>/` with its own `app.json`, `main.js` and `icon.png`. Match the manifest ID to the directory name and set `"mguHmi": ["ID7"]`. Use a stable, unique ID and an independent `major.minor.patch` version.
2. Build locally with `python3 tools/build_mgu_app.py <id> --test`. The builder runs `tests/test_<id>.js` if present, checks the OAP archives and stages a USB catalog under `dist/usb/mgu-repo/<id>/`. BMW's SDK comes from the firmware when Store installs the app.
3. On GitHub, open **Actions → Publish MGU Store app → Run workflow**. Select `main` and enter the app ID. The workflow publishes the selected app's `<id>@<version>.tgz` in a release tagged `<id>@<version>`. Each release includes titles, descriptions, and icons for all apps because the Store reads one metadata file for the source. To publish an update, set a higher version in that app's manifest.

[Offline Profile Manager vehicle validation](apps/offline_profile_manager/README.md#validate-on-the-vehicle) · [HU_MGU PRG audit](docs/HU_MGU_PRG_AUDIT.md)

## Upstream

[idrive7-apps App Kit](https://github.com/cauliflowermossgrape/idrive7-apps) · [MIT license](https://github.com/cauliflowermossgrape/idrive7-apps/blob/main/LICENSE)
