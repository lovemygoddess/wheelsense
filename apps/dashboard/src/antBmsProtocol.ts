// ANT BMS BLE protocol — UUIDs + frame parser + reassembler.
//
// Read-only:
//   - This module NEVER calls writeValue. The single optional REQUEST_CMD
//     lives at the hook layer and is the only writeValue call site in the
//     whole feature.
//
// Wire format — CONFIRMED via syssi/esphome-ant-bms C++ source
// (https://github.com/syssi/esphome-ant-bms/blob/main/components/ant_bms_ble/ant_bms_ble.cpp).
// The official ESPHome component supports several ANT-BMS variants
// (16ZMUB, 24BHUB, 22AAUB, …). The user's device — ANT-BLE16ZNUB-H7H8 —
// is a different variant but uses the same frame format / delimiters /
// CRC. Field offsets within the body of cmd 0x11 (status) are taken from
// syssi's `on_status_data_()` function. This specific variant may have a
// few-byte shift in some sections; the user can tune the named constants
// in `STATUS_OFFSETS` if the parsed values come out wrong.
//
// Frame structure:
//   [0x7E] [0xA1] [function:u8] [address:u16 LE] [data_len:u8]
//   [body: u8 × data_len]
//   [crc16: u16 LE]      (CRC-16/MODBUS, poly 0xA001, init 0xFFFF,
//                          covers frame[1..5+data_len] — i.e. 0xA1
//                          through the last body byte, NOT the 0x7E
//                          prefix and NOT the CRC bytes themselves)
//   [0xAA] [0x55]
//
//   total length = 10 + data_len
//
// For a status REQUEST (no body) the frame is exactly 10 bytes:
//   7E A1 <fn> <addr_lo> <addr_hi> <value>  <crc_lo> <crc_hi>  AA 55
// where `<value>` is firmware-specific and `<crc>` is computed over
// bytes 1..5.
//
// Functions observed (per syssi source):
//   0x11  STATUS          — full status frame
//   0x12  DEVICE_INFO     — sub-dispatch by address (0x026c = model,
//                           other addresses = settings registers)
//   0x13  SYSTEM_LOG
//   0x14  PERMISSION
//   0x15  SYSTEM_INFO
//   0x16  GPS_DATA
//   0x42, 0x43, 0x61      — UNKNOWN (per syssi)

// ──────────────────────────────────────────────────────────────────────────
// Hardware-facing constants.
// ──────────────────────────────────────────────────────────────────────────

export const ANT_BMS = {
  SERVICE_UUID: '0000ffe0-0000-1000-8000-00805f9b34fb',
  NOTIFY_CHARACTERISTIC_UUID: '0000ffe1-0000-1000-8000-00805f9b34fb',

  REQUEST_CMD: null as Uint8Array | null,

  FRAME: {
    START: 0x7e,
    MARKER: 0xa1,
    END: 0xaa,
    END2: 0x55,
    /** Bytes 0..5 inclusive: 0x7E 0xA1 function address_lo address_hi data_len. */
    HEADER_BYTES: 6,
    /** CRC occupies 2 bytes just before the trailer. */
    CRC_BYTES: 2,
    /** 0xAA 0x55 — 2 bytes. */
    TRAILER_BYTES: 2,
    /** A request frame has 0 body bytes → total = 10. */
    MIN_LEN: 10,
  },

  CMD: {
    STATUS: 0x11,
    DEVICE_INFO: 0x12,
    SYSTEM_LOG: 0x13,
    PERMISSION: 0x14,
    SYSTEM_INFO: 0x15,
    GPS_DATA: 0x16,
    UNKNOWN_42: 0x42,
    UNKNOWN_43: 0x43,
    UNKNOWN_61: 0x61,
  } as const,

  /** Status-frame body offsets (body = bytes after the 6-byte header). */
  STATUS_OFFSETS: {
    /** byte[0] of body — access permissions / capability bits. */
    PERMISSIONS: 0,
    /** byte[1] of body — battery status enum (0=Unknown, 1=Idle, 2=Charge, 3=Discharge, 4=Standby, 5=Error). */
    BATTERY_STATUS: 1,
    /** byte[2] of body — number of temperature sensors (0..6 in syssi's setup). */
    TEMP_SENSOR_COUNT: 2,
    /** byte[3] of body — number of cells in series (1..32). Read from the frame, not from a constant. */
    CELL_COUNT_FIELD: 3,
    /** bytes 4..11 of body — protection bitmask (8 bytes). */
    PROT_BITMASK: 4,
    /** bytes 12..19 of body — warning bitmask (8 bytes). */
    WARN_BITMASK: 12,
    /** bytes 20..27 of body — balancing bitmask (8 bytes, bit i = cell i+1). */
    BAL_BITMASK: 20,
    /**
     * byte 28 of body — start of cell-voltage u16 array. Per syssi. The
     * user's ANT-BLE16ZNUB-H7H8 has 14 cells here, and verified values
     * 3764-3766 mV match what the btsnoop/小程序 show.
     */
    CELL_START_MV: 28,
    /**
     * OVERRIDE for the user's variant. Syssi's algorithm puts runtime
     * immediately after power (at body[28 + cells*2 + 4*2 + 8 + 2*4 + 4] ≈
     * body[92] for 14 cells). The user's BMS inserts ~42 extra bytes of
     * status fields (max/min cell voltage, drive voltages, etc.) between
     * power and runtime. Verified from the JSON export on 2026-07-25:
     * body[134..137] = 0x005D050F = 6,098,959 s ≈ 70.6 days.
     */
    RUNTIME_SECONDS: 134,
  },

  // Device-info sub-dispatch (cmd 0x12 body[0..1] = address LE).
  DEVICE_INFO_ADDR_MODEL: 0x026c,
} as const

// ──────────────────────────────────────────────────────────────────────────
// Parsed frame — returned to UI / exported as JSON.
// ──────────────────────────────────────────────────────────────────────────

export interface AntBmsFrame {
  /** Sub-command byte (e.g. 0x11 for status). */
  cmd: number

  /** Raw body bytes (between header and CRC), for inspection. */
  body: Uint8Array

  // Fields from cmd 0x11 (status). All may be null on partial/bad parses.

  /** Access permissions byte (frame[6]). */
  permissions: number | null
  /** Battery status enum: 0=Unknown, 1=Idle, 2=Charge, 3=Discharge, 4=Standby, 5=Error. */
  battery_status: number | null
  /** Number of cells in series, read from the frame (so it's not a static guess). */
  cell_count: number | null
  /** Per-cell voltage in mV. Length equals `cell_count` (capped at 32). */
  cells_mv: (number | null)[]

  // Temperatures: syssi reads (temp_sensor_count) sensors, then mosfet
  // and balancer. We surface them as a single array; nulls where the
  // source frame ran short.
  temps_c: (number | null)[]

  /** Pack voltage in volts. */
  total_voltage_v: number | null
  /** Pack current in amperes (+ charge, − discharge). */
  current_a: number | null
  /** State of charge in percent. */
  soc_pct: number | null
  /** State of health in percent. */
  soh_pct: number | null
  /** Total runtime in seconds. */
  runtime_seconds: number | null
  /** Pack power in watts (signed). */
  power_w: number | null
  /** Total battery capacity setting in Ah. */
  capacity_total_ah: number | null
  /** Remaining capacity in Ah. */
  capacity_remaining_ah: number | null
  /** Cycle capacity in Ah. */
  cycle_capacity_ah: number | null
  /** Charge MOSFET status code (0=Off, 1=On, 2+=various faults — see syssi table). */
  charge_mosfet_code: number | null
  /** Discharge MOSFET status code. */
  discharge_mosfet_code: number | null
  /** Balancer status code. */
  balancer_code: number | null

  // Strings (from cmd 0x12 device-info body).
  device_model: string | null
  software_version: string | null
}

export type FrameResult =
  | { ok: true; frame: AntBmsFrame; crcOk: boolean; expectedCrc: number; computedCrc: number }
  | { ok: false; reason: 'too_short' | 'bad_start' | 'bad_marker' | 'bad_end' | 'length_mismatch' }

// ──────────────────────────────────────────────────────────────────────────
// Byte readers — exported for unit tests.
// ──────────────────────────────────────────────────────────────────────────

/** u16 little-endian at `offset`, or null if past end. */
export function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null
  return (bytes[offset]! | (bytes[offset + 1]! << 8)) & 0xffff
}

/** i16 little-endian at `offset` (two's complement). */
export function readI16LE(bytes: Uint8Array, offset: number): number | null {
  const v = readU16LE(bytes, offset)
  if (v === null) return null
  return v > 0x7fff ? v - 0x10000 : v
}

/** u32 little-endian at `offset`, or null if past end. */
export function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0
}

/** i32 little-endian at `offset` (two's complement). */
export function readI32LE(bytes: Uint8Array, offset: number): number | null {
  const v = readU32LE(bytes, offset)
  if (v === null) return null
  return v > 0x7fffffff ? v - 0x100000000 : v
}

// ──────────────────────────────────────────────────────────────────────────
// CRC-16/MODBUS — poly 0xA001, init 0xFFFF, no reflection.
// Matches ESPHome's helpers.cpp `crc16()` defaults, which syssi uses for
// the ANT-BMS frame integrity check.
// ──────────────────────────────────────────────────────────────────────────

export function crc16Modbus(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffff
  for (let i = start; i < end && i < bytes.length; i++) {
    crc ^= bytes[i]!
    for (let j = 0; j < 8; j++) {
      if (crc & 1) crc = (crc >> 1) ^ 0xa001
      else crc >>= 1
    }
  }
  return crc & 0xffff
}

// ──────────────────────────────────────────────────────────────────────────
// Reassembler — pure function over a buffer. Scans for 7E A1 ... AA 55
// boundaries and returns complete frames plus the leftover partial frame.
// ──────────────────────────────────────────────────────────────────────────

export interface ReassemblerResult {
  frames: Uint8Array[]
  rest: Uint8Array
}

/**
 * Length-driven reassembler: read the 6-byte header, take data_len, and cut
 * the frame at 10 + data_len, then verify the AA 55 trailer AT THAT POSITION.
 *
 * The old delimiter-search version cut every frame at the first AA 55 pair —
 * a 140+ byte status body can legitimately contain 0xAA55, so those frames
 * were truncated and discarded. False 7E A1 headers inside a body are
 * handled too: if the length-derived trailer doesn't match (or a second
 * header shows up before the frame completes), we skip one byte and rescan.
 */
export function extractFrames(buffer: Uint8Array): ReassemblerResult {
  const { START, MARKER, END, END2, HEADER_BYTES, CRC_BYTES, TRAILER_BYTES, MIN_LEN } = ANT_BMS.FRAME
  const frames: Uint8Array[] = []
  const len = buffer.length
  let cursor = 0

  while (cursor + MIN_LEN <= len) {
    // Locate the next candidate header.
    let start = -1
    for (let i = cursor; i + 1 < len; i++) {
      if (buffer[i] === START && buffer[i + 1] === MARKER) {
        start = i
        break
      }
    }
    if (start === -1) {
      // No header at all — garbage stream. Keep a trailing 0x7E (it may be
      // half of a header split across two notifies), drop the rest so the
      // reassembly buffer can't grow unbounded (M22).
      cursor = buffer[len - 1] === START ? len - 1 : len
      break
    }
    if (start > cursor) cursor = start // skip garbage before the header

    const dataLen = buffer[start + 5]!
    const total = HEADER_BYTES + dataLen + CRC_BYTES + TRAILER_BYTES

    if (start + total > len) {
      // Incomplete — but if a LATER header already arrived, this "header"
      // was a false positive inside a payload; skip it and rescan.
      let next = -1
      for (let i = start + 1; i + 1 < len; i++) {
        if (buffer[i] === START && buffer[i + 1] === MARKER) {
          next = i
          break
        }
      }
      if (next !== -1) {
        cursor = next
        continue
      }
      cursor = start // genuine partial frame — wait for the rest
      break
    }

    if (buffer[start + total - 2] === END && buffer[start + total - 1] === END2) {
      frames.push(buffer.subarray(start, start + total))
      cursor = start + total
    } else {
      // Trailer mismatch at the length-derived position → false header.
      cursor = start + 1
    }
  }

  return { frames, rest: buffer.subarray(cursor) }
}

// ──────────────────────────────────────────────────────────────────────────
// Per-frame parser.
// ──────────────────────────────────────────────────────────────────────────

export function parseAntBmsFrame(frame: Uint8Array): FrameResult {
  const { START, MARKER, END, END2, HEADER_BYTES, CRC_BYTES, MIN_LEN } = ANT_BMS.FRAME

  if (frame.length < MIN_LEN) return { ok: false, reason: 'too_short' }
  if (frame[0] !== START) return { ok: false, reason: 'bad_start' }
  if (frame[1] !== MARKER) return { ok: false, reason: 'bad_marker' }
  if (frame[frame.length - 2] !== END || frame[frame.length - 1] !== END2) {
    return { ok: false, reason: 'bad_end' }
  }

  const func = frame[2]!
  const dataLen = frame[5]!
  const expectedTotal = HEADER_BYTES + dataLen + CRC_BYTES + 2
  if (frame.length !== expectedTotal) return { ok: false, reason: 'length_mismatch' }

  // CRC over frame[1..5+data_len] (exclusive of 0x7E prefix and CRC bytes
  // themselves). See syssi: crc16(raw + 1, frame_len - 5) where
  // frame_len = 10 + data_len, so input length = 5 + data_len.
  const computedCrc = crc16Modbus(frame, 1, 6 + dataLen)
  const remoteCrc = (frame[6 + dataLen]! | (frame[7 + dataLen]! << 8)) & 0xffff
  const crcOk = computedCrc === remoteCrc

  const body = frame.subarray(HEADER_BYTES, HEADER_BYTES + dataLen)

  const result: AntBmsFrame = {
    cmd: func,
    body,
    permissions: null,
    battery_status: null,
    cell_count: null,
    cells_mv: [],
    temps_c: [],
    total_voltage_v: null,
    current_a: null,
    soc_pct: null,
    soh_pct: null,
    runtime_seconds: null,
    power_w: null,
    capacity_total_ah: null,
    capacity_remaining_ah: null,
    cycle_capacity_ah: null,
    charge_mosfet_code: null,
    discharge_mosfet_code: null,
    balancer_code: null,
    device_model: null,
    software_version: null,
  }

  switch (func) {
    case ANT_BMS.CMD.STATUS:
      extractStatusFields(body, result)
      break
    case ANT_BMS.CMD.DEVICE_INFO:
      extractDeviceInfoFields(frame, body, result)
      break
    // All other functions: body preserved, fields stay null. HexDump and
    // JSON export show the raw bytes.
  }

  // Best-effort: extract fields even if CRC mismatches. The user's
  // ANT-BLE16ZNUB-H7H8 variant has a different CRC for response frames
  // (the request frame CRC matches MODBUS exactly). Flagged via crcOk so
  // the UI can surface the mismatch.
  return { ok: true, frame: result, crcOk, expectedCrc: remoteCrc, computedCrc }
}

// ──────────────────────────────────────────────────────────────────────────
// Status body parser — syssi's on_status_data_() algorithm, ported.
// ──────────────────────────────────────────────────────────────────────────

function extractStatusFields(body: Uint8Array, out: AntBmsFrame): void {
  const O = ANT_BMS.STATUS_OFFSETS

  out.permissions = body[O.PERMISSIONS] ?? null
  out.battery_status = body[O.BATTERY_STATUS] ?? null
  const tempCount = body[O.TEMP_SENSOR_COUNT] ?? 0
  const cellCount = Math.min(body[O.CELL_COUNT_FIELD] ?? 0, 32) // safety cap
  out.cell_count = cellCount

  // Cells — only attempt if the body is long enough to hold the start of
  // the cell array. Anything shorter produces an empty cells_mv.
  out.cells_mv = []
  if (body.length >= O.CELL_START_MV + 2) {
    for (let i = 0; i < cellCount; i++) {
      const off = O.CELL_START_MV + i * 2
      if (off + 2 > body.length) break
      out.cells_mv.push(readU16LE(body, off))
    }
  }

  // After cells: temp_sensors + 2 special temps (mosfet, balancer), per
  // syssi. Each is i16 LE in 0.1 °C units (syssi multiplies by 1.0f so
  // actually plain integer °C).
  let off = O.CELL_START_MV + cellCount * 2
  const temps: (number | null)[] = []
  for (let i = 0; i < tempCount; i++) {
    const t = readI16LE(body, off)
    temps.push(t)
    off += 2
  }
  // Mosfet temperature (always 1)
  const mosfetT = readI16LE(body, off)
  temps.push(mosfetT)
  off += 2
  // Balancer temperature (always 1)
  const balancerT = readI16LE(body, off)
  temps.push(balancerT)
  off += 2
  out.temps_c = temps

  // Total voltage (u16 LE × 0.01)
  const tv = readU16LE(body, off)
  out.total_voltage_v = tv === null ? null : tv / 100
  off += 2

  // Current (i16 LE × 0.1) — syssi multiplies by 0.1.
  // BMS reports positive for discharge (riding), negative for charge.
  // Negate so the UI shows negative=discharge, positive=charge.
  const ca = readI16LE(body, off)
  out.current_a = ca === null ? null : -(ca / 10)
  off += 2

  // SOC (u16)
  const soc = readU16LE(body, off)
  out.soc_pct = soc
  off += 2

  // SOH (u16)
  const soh = readU16LE(body, off)
  out.soh_pct = soh
  off += 2

  // 1 byte each: charge_mosfet, discharge_mosfet, balancer, reserved
  out.charge_mosfet_code = body[off] ?? null
  off += 1
  out.discharge_mosfet_code = body[off] ?? null
  off += 1
  out.balancer_code = body[off] ?? null
  off += 1
  off += 1 // reserved

  // u32 LE × 0.000001 — total battery capacity setting (Ah)
  const tc = readU32LE(body, off)
  out.capacity_total_ah = tc === null ? null : tc / 1_000_000
  off += 4

  // u32 LE × 0.000001 — remaining capacity (Ah)
  const rc = readU32LE(body, off)
  out.capacity_remaining_ah = rc === null ? null : rc / 1_000_000
  off += 4

  // u32 LE × 0.001 — ANT's lifetime discharged-capacity counter is in mAh,
  // unlike the two neighbouring configured/remaining capacity fields (µAh).
  const cc = readU32LE(body, off)
  out.cycle_capacity_ah = cc === null ? null : cc / 1_000
  off += 4

  // i32 LE × 1 — board-displayed power (fallback only). Canonical power is
  // V × I from the same frame, so it has one auditable physical definition.
  const pw = readI32LE(body, off)
  const boardPowerW = pw === null ? null : -pw
  out.power_w = out.total_voltage_v !== null && out.current_a !== null
    ? Math.round(out.total_voltage_v * out.current_a * 10) / 10
    : boardPowerW
  off += 4

  // The user's ANT-BLE16ZNUB-H7H8 has ~42 extra status bytes (max/min cell
  // voltage + index, drive voltages, battery type, total discharge/charge
  // capacity/time) between power and runtime. Skip over them by reading
  // runtime at STATUS_OFFSETS.RUNTIME_SECONDS directly.
  // If the body is too short for that offset, leave runtime as null.
  if (body.length >= ANT_BMS.STATUS_OFFSETS.RUNTIME_SECONDS + 4) {
    const rt = readU32LE(body, ANT_BMS.STATUS_OFFSETS.RUNTIME_SECONDS)
    out.runtime_seconds = rt
  }
  off += 4
}

// ──────────────────────────────────────────────────────────────────────────
// Device-info body parser (cmd 0x12, address 0x026c only). The body
// contains a 16-byte hardware-version string and a 16-byte software-
// version string (syssi's on_device_info_data_).
// ──────────────────────────────────────────────────────────────────────────

function extractDeviceInfoFields(
  frame: Uint8Array,
  body: Uint8Array,
  out: AntBmsFrame,
): void {
  const addr = frame[3]! | (frame[4]! << 8)
  if (addr !== ANT_BMS.DEVICE_INFO_ADDR_MODEL) return
  if (body.length < 32) return

  out.device_model = extractAscii(body, 0, 16)
  out.software_version = extractAscii(body, 16, 16)
}

function extractAscii(bytes: Uint8Array, start: number, maxLen: number): string | null {
  let s = ''
  for (let i = start; i < start + maxLen && i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 0) break
    if (b >= 0x20 && b < 0x7f) s += String.fromCharCode(b)
  }
  return s.length > 0 ? s : null
}

// ──────────────────────────────────────────────────────────────────────────
// Value sanity filtering (M6). A misaligned parse (wrong offsets, truncated
// reassembly, garbage stream) produces absurd values — cell=30000mV,
// SOC=65535 — that used to flow straight into the UI and the backend history
// upload. Filter per field so one bad field never poisons the merged view.
//
// Ranges are deliberately wider than the pack's healthy operating window
// (14S NMC, 42–60.9V) to only catch parse garbage, never real data.
// ──────────────────────────────────────────────────────────────────────────

const RANGE = {
  cellMv: [2000, 5000] as const,
  packV: [20, 90] as const,
  currentA: [-200, 200] as const,
  socPct: [0, 100] as const,
  tempC: [-40, 120] as const,
  powerW: [-30000, 30000] as const,
  capacityAh: [0, 1000] as const,
}

function inRange(v: number | null, [lo, hi]: readonly [number, number]): number | null {
  return v !== null && v >= lo && v <= hi ? v : null
}

/** Null out every implausible field value (nulls never override in merge). */
export function filterImplausibleValues(frame: AntBmsFrame): AntBmsFrame {
  return {
    ...frame,
    cells_mv: frame.cells_mv.map(v => inRange(v, RANGE.cellMv)),
    temps_c: frame.temps_c.map(v => inRange(v, RANGE.tempC)),
    total_voltage_v: inRange(frame.total_voltage_v, RANGE.packV),
    current_a: inRange(frame.current_a, RANGE.currentA),
    soc_pct: inRange(frame.soc_pct, RANGE.socPct),
    soh_pct: inRange(frame.soh_pct, RANGE.socPct),
    power_w: inRange(frame.power_w, RANGE.powerW),
    capacity_total_ah: inRange(frame.capacity_total_ah, RANGE.capacityAh),
    capacity_remaining_ah: inRange(frame.capacity_remaining_ah, RANGE.capacityAh),
    cycle_capacity_ah: inRange(frame.cycle_capacity_ah, RANGE.capacityAh),
  }
}

/**
 * Frame-level gate for cmd 0x11 status frames: after per-field filtering,
 * does anything usable remain? A fully-garbage parse (all fields nulled)
 * is dropped instead of merged/uploaded.
 */
export function hasPlausibleStatusData(frame: AntBmsFrame): boolean {
  if (frame.cmd !== ANT_BMS.CMD.STATUS) return true // non-status frames pass
  return (
    frame.total_voltage_v !== null ||
    frame.soc_pct !== null ||
    frame.current_a !== null ||
    frame.cells_mv.some(v => v !== null)
  )
}

// ──────────────────────────────────────────────────────────────────────────
// Merge two snapshots — `next` overrides `prev` for any non-null field.
// Multi-cmd streams (status + device info + …) build a unified view.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Per-index merge for array fields (M15): a truncated frame that only
 * parsed 3 of 14 cells must NOT replace the full array — positions the new
 * frame didn't provide keep their previous values.
 */
function mergeArraysByIndex(prev: (number | null)[], next: (number | null)[]): (number | null)[] {
  const len = Math.max(prev.length, next.length)
  const out: (number | null)[] = new Array(len)
  for (let i = 0; i < len; i++) {
    out[i] = next[i] ?? prev[i] ?? null
  }
  return out
}

export function mergeFrames(prev: AntBmsFrame | null, next: AntBmsFrame): AntBmsFrame {
  if (!prev) return next
  const pick = <T>(a: T | null, b: T | null): T | null => (b === null ? a : b)
  return {
    cmd: next.cmd,
    body: next.body,
    permissions: pick(prev.permissions, next.permissions),
    battery_status: pick(prev.battery_status, next.battery_status),
    cell_count: pick(prev.cell_count, next.cell_count),
    cells_mv: mergeArraysByIndex(prev.cells_mv, next.cells_mv),
    temps_c: mergeArraysByIndex(prev.temps_c, next.temps_c),
    total_voltage_v: pick(prev.total_voltage_v, next.total_voltage_v),
    current_a: pick(prev.current_a, next.current_a),
    soc_pct: pick(prev.soc_pct, next.soc_pct),
    soh_pct: pick(prev.soh_pct, next.soh_pct),
    runtime_seconds: pick(prev.runtime_seconds, next.runtime_seconds),
    power_w: pick(prev.power_w, next.power_w),
    capacity_total_ah: pick(prev.capacity_total_ah, next.capacity_total_ah),
    capacity_remaining_ah: pick(prev.capacity_remaining_ah, next.capacity_remaining_ah),
    cycle_capacity_ah: pick(prev.cycle_capacity_ah, next.cycle_capacity_ah),
    charge_mosfet_code: pick(prev.charge_mosfet_code, next.charge_mosfet_code),
    discharge_mosfet_code: pick(prev.discharge_mosfet_code, next.discharge_mosfet_code),
    balancer_code: pick(prev.balancer_code, next.balancer_code),
    device_model: pick(prev.device_model, next.device_model),
    software_version: pick(prev.software_version, next.software_version),
  }
}
