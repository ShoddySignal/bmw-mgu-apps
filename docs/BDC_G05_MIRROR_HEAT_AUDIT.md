# BDC_G05 · Mirror Heat Check

The source is the local `BDC_G05.prg`, revision `1.000`, SHA-256 `2ab470b9fe6ca6d9ab7e50ce7f220e5bf9428a217a30debccfc71391e120ac6a`. The `IDENT` job uses address `0x40` at offset `0x3C9`. The reference index maps `40 0F2680` to BDC_G05. [SGBD index](https://github.com/alexp50/bmw-apps/blob/4fb5a5dba1ec7c6a57545ae935a14cb91a194d19/apps/road_trip_computer/builtin/sgbd_index.json)

| Request | Positive response fields |
| --- | --- |
| `22 F1 50` | The first three bytes after `62 F1 50` contain the SGBD index. `IDENT` reads them at offsets `0x912–0x9E5`. |
| `22 D3 2D` | `RES_0xD32D_D` defines two 16-bit big-endian values. The first is the `0/1` status. The second is the requested percentage, with a scale factor of 1 and no offset. |
| `22 D3 21` | A 16-bit `0/1` flag. The function name refers to thermal protection. The field name in this revision contains `SPIELSCHUTZ`. The app labels it **Protection (D321)**. Its relationship to mirror glass temperature requires vehicle testing. |
| `22 23 05` | An unsigned 16-bit big-endian count of NSC-triggered mirror heater activations. |
| `22 E4 50` | `RES_0xE450_D` defines eight bytes. The fourth reports mirror heater coding according to `TAB_AUSSENSPIEGEL_HEIZUNG_VORHANDEN`. `00` means uncoded, `01` means coded, and `FF` means invalid. |
| `19 02 0C` | The `FS_LESEN` job specifies status mask `0C` for pending and confirmed codes. A `59 02` reply contains a status availability mask followed by four-byte records with a three-byte code and one status byte. |

## Timed activation

`SG_FUNKTIONEN` lists service `2E` for `AUSSENSPIEGEL_HEIZUNG`. `ARG_0xD32D_D` defines two consecutive `signed int` arguments. `TAB_SPIEGEL_HEIZUNG_ARG` maps 25%, 50%, 75%, and 100% to steps `0x01` through `0x04`. The second argument sets the duration in seconds, up to 240 seconds. Both rows have `-` in the `L/H` column.

`STEUERN` starts the UDS payload with `2E` at `0x35887`, takes the DID from the `SG_FUNKTIONEN` row at `0x369B5–0x36ACB`, and reads `WERT` from the argument table at `0x3B8A3`. The `signed int` encoding branches at `0x38F79–0x391C9` and `0x3D4A8` select little-endian only for `L/l`. The default stores the high byte first, as shown at `0x39116–0x39188`. The `STATUS_LESEN` read branches use the same default at `0x18F87–0x19252` and `0x1BD24–0x1BFB9`. `STEUERN` wraps the payload in the transport frame before `XSEND` at `0x4E65B–0x4E7B2`.

The app sends TASU service `2E` with DID `D32D`, the selected power step, and the selected duration. The default 240-second test at 100% uses data `D3 2D 00 04 00 F0`. A 60-second test at 50% uses `D3 2D 00 02 00 3C`. It accepts `6E D3 2D` from ECU `40` as acknowledgement and reads `D32D` to observe the reported heater state. The variable settings were tested with simulated responses. Version 0.1.3 was tested on a 2021 BMW X5 G05. [InternalTasu diagnostics in the App Kit](https://github.com/cauliflowermossgrape/idrive7-apps#45-diagnostics)

`D32D` describes one shared heater state and request. Testing for physical heat requires measuring each mirror surface separately. The app retains the pre-test snapshot, the latest valid status and requested output received during the test, and the first status read by the test monitor after the test window.

### Known issue in 0.2.0

TASU starts listening before it dispatches the heater request. A negative UDS reply (`7F 2E <NRC>`) identifies the service and carries no DID or request identifier. In a simulated test, a delayed refusal from ECU `40` arrived before the new request was sent. The app displayed a refusal and unlocked **Start test** even though the simulated BDC then accepted the new request. This timing has been reproduced in simulation only. [TASU reply matching](../kit/runtime/diag.js#L137) · [Test lock handling](../apps/mirror_heat_check/monitor.js#L151)

A follow-up should ignore replies received before the native dispatch callback and keep the test locked until its duration expires if a refusal cannot be tied to the current request. A regression test should deliver an earlier refusal followed by the new acknowledgement and verify that a second activation remains blocked during the test window.

## Mirror fault memory

The app filters the BDC fault memory reply to the following entries from `FORTTEXTE`.

| Code | Meaning |
| --- | --- |
| `804246`, `804256` | Left or right mirror heater or electrochromic dimming fault. |
| `D90D0A`, `D90D0D` | Left or right mirror LIN module missing. |
| `804340` | Mirror heater short to ground. |
| `804341` | Mirror heater open circuit or short to positive. |
