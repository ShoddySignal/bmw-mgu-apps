# HU_MGU PRG audit

The user-supplied EDIABAS/BEST/2 file was parsed locally. The following offsets refer to the original file. [EdiabasX parser](https://github.com/emdzej/ediabasx/tree/main/packages/best-parser/src) · [EdiabasLib opcode implementation](https://github.com/uholeschak/ediabaslib/blob/master/EdiabasLib/EdiabasLib/EdOperations.cs)

| Item | Value |
| --- | --- |
| SHA-256 | `74daa7f74246ab5bb4078816d2b7e79915b4744a5fb351f1f9fde72d760bba10` |
| PRG revision | `8.005` |
| PRG label | `19-11-460` |
| Executable jobs | 79 |
| Data rows in `SG_FUNKTIONEN` | 169 |
| HU_MGU physical address | `0x63` |

The old prototype archive was unavailable. Its two earlier request values come from the task description. The public SGBD reference is revision 6.002. [Public SGBD reference](https://github.com/emdzej/ediabasx-docs-sgbd/blob/main/docs/sgbd/HU_MGU.md)

| Operation | UDS request | Evidence |
| --- | --- | --- |
| `IDENT` | `22 F1 50` | Literal at `0x3A0`. `0x902–0x9D5` reads response offsets 3 to 5 as a big-endian SGBD index. The App Kit index maps `0F25B0` and address `63` to HU_MGU. The app reads the software version separately using `runtimeVariant.getSoftwareVersion()`. |
| `PERSONALISATION_ACCOUNT_IDS` | `22 E3 33` | Literal at `0xC64C8`. The old value was `22 D2 7B`. The job removes the three-byte UDS prefix at `0xC6A68` and consumes six NUL-terminated strings using `strlen + 1`. The final field at `0xC6FDB` is the guest ID. The order is `ID1, name1, ID2, name2, ID3, name3, guest ID`. The parser treats IDs as opaque ASCII and decodes names as strict UTF-8. Empty pairs represent free slots. The guest ID can end at the payload boundary or be followed by zero padding. These fields contain no active-account indicator. |
| `STEUERN_ROUTINE / PERSONALISATION_CREATE_LOCAL_ACCOUNT` | `31 01 A1 9A` | `SG_FUNKTIONEN` gives service `31` and RID `A19A` with no arguments. The `STR` branch at `0x53E55` selects subfunction `01`. |
| Creation result | `31 03 A1 9A` | The `RRR` branch at `0x53F8F` selects `03`. Both `RES_0xA19A_R` fields apply to RRR. The first payload byte is `TAB_TESTSTATUS`: `00` not started, `01` in progress, `02` success, `03` failure, `FF` undefined. The ID string is optional. The app requires status `02` and a single new ID in the refreshed list, matching any ID from the result. |
| `STEUERN / PERSONALISATION_LOGIN_ACCOUNT` | `2E E3 34 <seven ID bytes>` | `ARG_0xE334_D` specifies `string[7]`. `0x450C7–0x451AF` enforces the length and strips the `pars` terminator. The bytecode adds no padding. |
| `PERSONALISATION_RENAME_ACCOUNT` | `2E E3 35 <name> 00` | Literal at `0xC9417`. The old value was `2E D0 2E`. The `pars` and `scat` instructions at `0xC94D0` and `0xC9511` preserve the NUL terminator. EdiabasLib encodes its text argument as Windows-1252. The app strips control characters and limits the resulting name to 24 UTF-8 bytes before adding the terminator. The ECU's supported characters and maximum length require vehicle testing. |
| `STEUERN_PIA_04_CHANGE_PROFILE` | `31 01 02 08 04 <slot> <mode>` | Literal at `0xC9ACA`. The two arguments are inserted at `0xC9B25` and `0xC9B76`. The app allows only mode `02` for driver slots `00`–`02`. The `71 01 02 08` reply acknowledges the request. Persistence and the mapping to `E333` require verification on the target unit. |
| `STATUS_PIA_CURRENT_PROFILE` | Multi-step exchange | The job changes diagnostic sessions and reads a profile data stream. The app uses SessionManager to identify the active profile. See [Profile IDs and active account](#profile-ids-and-active-account). |

TASU generates the transport envelope. The adapter matches replies against physical address `0x63`, service ID, and DID or routine echo. NRC `78` extends the current wait within its deadline. Live compatibility, session mapping and the availability of fresh stationary signals require vehicle validation.

## Profile IDs and active account

On the BMW X5 G05 with SGBD index `0F25B0`, software `L18_22w18.3-1-6` and variant `mgu-high`, diagnostics showed the following values with each driver profile selected.

| Selected profile | SessionManager reference suffix | ID returned by `22 E3 33` | ID bytes |
| --- | --- | --- | --- |
| First | `UserAccountManager.i01` | `i01\x20\x20\x20\x20` | `69 30 31 20 20 20 20` |
| Second | `UserAccountManager.i02` | `i02\x20\x20\x20\x20` | `69 30 32 20 20 20 20` |

Each `\x20` represents one ASCII space in the ID. These four spaces were observed on this unit. The PRG specifies a seven-byte ID for `2E E3 34`. The app sends the seven bytes directly from the selected E333 entry. The request ends after the ID. For the second profile in the table, its UDS bytes are `2E E3 34 69 30 32 20 20 20 20`.

For active-profile detection, the app reads `SessionManager.currentUserAccountReference` and uses it to read `UserAccount.id`, `name`, and `type`. It refreshes on `currentUserOnChange`. The full SessionManager reference and `UserAccount.id` are separate values from the E333 ID and can differ from it.

For references of the form `de.bmw.infotainment.personalization.UserAccountManager.iNN`, the app also compares the instance `iNN` plus four ASCII spaces with the IDs of driver profiles in E333. A single matching row identifies the active profile. Conflicting identifier matches leave the active profile unresolved. With zero identifier matches, a unique exact driver name can identify it. **Diagnostics → Show account details** shows identifier and name match counts, so `ID/reference 1` and `Exact name 2` still identify a single active profile.

The G05 observations cover `i01` and `i02`. Automated tests cover both and confirm that the outgoing ID retains its four spaces. Vehicle validation of the app's reference matching is pending.

One E333 reply from the same unit returned the name `ЭЮЯ` as UTF-8 bytes `D0 AD D0 AE D0 AF`. This confirms the encoding of that name in the read response.
