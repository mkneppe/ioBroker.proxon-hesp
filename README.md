# ioBroker.proxon-hesp

*[Deutsche Version / German version](README.de.md)*

Listens **passively** to the internal HESP bus of Proxon ventilation units (P series)
through an RS485-to-TCP gateway and stores all values in ioBroker.
By default the adapter sends nothing on the bus. Optionally it can write room setpoints
and read the parameters of all bus modules (read queries only).

> **Note:** Unofficial community project, not affiliated with the manufacturer. All mappings are based on bus observations,
> not on manufacturer documentation. Use at your own risk, especially the optional write functions.

## Requirements

- RS485-to-TCP gateway on the HESP bus (19200 baud, 8N1) in transparent TCP server mode
  (e.g. port 502). Several TCP clients at the same time are fine as long as they only listen.
- js-controller ≥ 6, Admin ≥ 7, Node.js ≥ 20.

## Installation

1. **Gateway:** connect an RS485-to-TCP gateway (tested: USR-TCP232 series) to the HESP bus lines (A/B) of the unit.
   - Settings: 19200 baud, 8 data bits, no parity, 1 stop bit.
   - Mode: TCP server, transparent (no Modbus conversion).
2. **Adapter:** in Admin → *Adapters* click the GitHub icon (*Custom*), select *Custom URL* and enter the URL of the release package, e.g.
   `https://github.com/mkneppe/ioBroker.proxon-hesp/releases/download/v0.4.0/iobroker.proxon-hesp-0.4.0.tgz`.
   - Or on the console: `iob url <that URL>`.
   - Then create an instance.
3. **Instance:**
   - **Connection:** IP address and port of the gateway.
   - **Modules:** map bus addresses to folder names.
     - `2` = ventilation unit, `10`–`15` = room modules.
     - On the analysed installation, 10–15 followed the order of the central control panel: hall, bedroom, child 1–4.
   - **Mappings:** the defaults fit an FWT 2-R with BDE Comfort.
   - **Control** (optional): enable room setpoint writing and periodic parameter polling.

## States

| Path | Content |
|---|---|
| `info.connection` | Connected and receiving valid telegrams |
| `info.events`, `info.lastEvent` | Rare events: new registers, changed texts, meta replies |
| `info.capture` | Switch: writes all telegrams for *n* minutes to a file in the instance data folder |
| `info.framesPerHour`, `info.skippedBytesPerHour` | Statistics |
| `<module>.<name>` | Named values according to the **mappings** table (a leading `/` creates the state below the instance root) |
| `<module>.Register.<R/W>_<DP>` | Every register seen: `value` (auto-decoded), `raw` (hex), `lastSeen`, `count` |
| `<room>.Sollwert` | Only if writing is enabled: writable setpoint, sent once as SET `0x01FB` to the room module and acknowledged after the module reports it back |
| `<module>.Meta.*` | Self-description of a module (name, DP list, type codes, access, units, error text) |
| `<module>.Parameter.*` | Values of all registers of a module, read with *read parameters* |
| `Parameter_lesen*` | Button and status (active, progress, text, timestamp) of *read parameters* |

`R` = reply of a module to a read query, `W` = value the master writes to the module. Register numbers in state IDs are decimal.

## Read parameters

The button `Parameter_lesen` queries every configured module, the ventilation unit first:
- its name (meta `0x0001`)
- its directory (meta `0x0033` DP list, `0x0034` type, `0x0038` access, `0x0039` unit)
- every parameter once

Only read queries are sent, one per bus gap (about every 12 s), so a full run takes more than an hour.
Periodic polling of the ventilation unit can be enabled under *Control* (off by default).

## Protocol (short)

```
h0 h1 h2 | id (uint32 LE) | len (nibbles) | payload | CRC16 LE
```

- Header: 24 bit LE.
  - Bits 0–3 type: 0 query, 1 set, 2 reply, 3 ack.
  - Bits 4–13 source, bits 14–23 destination.
- ID: data point in the low 16 bits; the high 16 bits are the sub selector (element offset for meta lists).
- CRC: init `0xFFFF`, reflected polynomial `0x8048`, 16 shift steps per byte.
- The length field overflows for 128-byte replies (`0x00`).

Sources and acknowledgements: see [NOTICE.md](NOTICE.md).

## Changelog

### 0.4.0 (2026-11-09)

- Read parameters of all modules; button and status directly under the instance; meta lists merged

### 0.3.2 (2026-11-09)

- Read parameters: more robust against missing replies, abort is reported

### 0.3.1 (2026-11-09)

- Setpoint step configurable, default 1 °C (room modules ignored 20.5 °C in tests)

### 0.3.0 (2026-11-09)

- Button "read parameters" (read queries only), optional periodic polling (off by default)

### 0.2.1 (2026-11-09)

- Address 40 identified as air-quality sensor (humidity, CO2)

### 0.2.0 (2026-11-08)

- Optional writing of room setpoints

### 0.1.x (2026-11-08)

- First versions: passive listening, CRC check with resync, mappings, register store, meta data points, events, capture

## License

MIT, see [LICENSE](LICENSE).
