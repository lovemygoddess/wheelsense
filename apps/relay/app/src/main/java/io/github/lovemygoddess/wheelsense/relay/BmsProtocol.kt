package io.github.lovemygoddess.wheelsense.relay

import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import kotlin.math.roundToInt

/**
 * Parser for the compatible ANT BMS BLE frame format.
 *
 * Frame:  [7E][A1][func:u8][addr:u16 LE][len:u8][body:len][crc16 LE][AA][55]
 * total   = 10 + len
 * CRC     = CRC-16/MODBUS over frame[1 .. 5+len]  (i.e. 0xA1 ... last body byte)
 *
 * The reassembler is LENGTH-DRIVEN (cut at 10+dataLen, verify the AA 55
 * trailer at that position). The old delimiter-search variant cut at the
 * first internal 0xAA55 pair, which silently truncated 140+ byte status
 * frames — most reads were dropped. This matches the canonical parser in
 * mobile/src/antBmsProtocol.ts.
 */
class BmsProtocol {

    private val START: Byte = 0x7E
    private val MARKER: Byte = 0xA1.toByte()
    private val END: Byte = 0xAA.toByte()
    private val END2: Byte = 0x55

    private val HEADER_BYTES = 6
    private val CRC_BYTES = 2
    private val TRAILER_BYTES = 2
    private val MIN_LEN = 10

    // status body offsets (matches antBmsProtocol.ts STATUS_OFFSETS)
    private val O_CELL_START_MV = 28
    private val O_TEMP_SENSOR_COUNT = 2
    private val O_CELL_COUNT = 3
    private val O_RUNTIME_SECONDS = 134

    data class ExtractResult(val frames: List<ByteArray>, val remainder: ByteArray)

    data class ParsedFrame(
        val cmd: Int,
        val cellCount: Int?,
        val cellsMv: IntArray?,
        val tempsC: FloatArray?,
        val totalVoltageV: Float?,
        val currentA: Float?,
        val batteryStatus: Int?,
        val socPct: Int?,
        val sohPct: Int?,
        val chargeMosfetCode: Int?,
        val dischargeMosfetCode: Int?,
        val balancerCode: Int?,
        val powerW: Int?,
        val capacityTotalAh: Float?,
        val capacityRemainingAh: Float?,
        /**
         * Lifetime discharged amp-hours as counted by the ANT board itself —
         * a hardware coulomb counter. Previously skipped by the parser. This
         * is strictly better than any SOC-derived figure: it is an integral of
         * measured current, so it is immune to the voltage-curve knee that
         * makes the upstream `ec` field read 100% anywhere from 4.32 V down to
         * 4.2 V per cell. Differencing it across a ride yields true Ah drawn.
         */
        val cycleCapacityAh: Float?,
        val runtimeSeconds: Long?,
        val crcOk: Boolean,
        val frameHex: String,
    )

    // ── CRC-16/MODBUS (poly 0xA001, init 0xFFFF) ──
    private fun crc16Modbus(bytes: ByteArray, start: Int, end: Int): Int {
        var crc = 0xFFFF
        for (i in start until end.coerceAtMost(bytes.size)) {
            crc = crc xor (bytes[i].toInt() and 0xFF)
            for (j in 0 until 8) {
                crc = if ((crc and 1) != 0) (crc shr 1) xor 0xA001 else crc shr 1
            }
        }
        return crc and 0xFFFF
    }

    // ── Byte readers ──
    private fun readU16LE(b: ByteArray, off: Int): Int? {
        if (off + 2 > b.size) return null
        return (b[off].toInt() and 0xFF) or ((b[off + 1].toInt() and 0xFF) shl 8)
    }

    private fun readI16LE(b: ByteArray, off: Int): Int? {
        val v = readU16LE(b, off) ?: return null
        return if (v > 0x7FFF) v - 0x10000 else v
    }

    private fun readU32LE(b: ByteArray, off: Int): Long? {
        if (off + 4 > b.size) return null
        return ((b[off].toLong() and 0xFF)
                or ((b[off + 1].toLong() and 0xFF) shl 8)
                or ((b[off + 2].toLong() and 0xFF) shl 16)
                or ((b[off + 3].toLong() and 0xFF) shl 24)) and 0xFFFFFFFFL
    }

    private fun readI32LE(b: ByteArray, off: Int): Int? {
        val v = readU32LE(b, off) ?: return null
        return if (v > 0x7FFFFFFF) (v - 0x100000000L).toInt() else v.toInt()
    }

    private fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (x in bytes) sb.append(String.format(Locale.US, "%02X", x))
        return sb.toString()
    }

    // ── Length-driven reassembler ──
    fun extractFrames(buffer: ByteArray): ExtractResult {
        val frames = mutableListOf<ByteArray>()
        val len = buffer.size
        var cursor = 0

        while (cursor + MIN_LEN <= len) {
            var start = -1
            for (i in cursor until len - 1) {
                if (buffer[i] == START && buffer[i + 1] == MARKER) {
                    start = i
                    break
                }
            }
            if (start == -1) {
                // No header at all; keep a trailing 0x7E (could be split header),
                // drop the rest so the buffer can't grow unbounded.
                cursor = if (len > 0 && buffer[len - 1] == START) len - 1 else len
                break
            }
            if (start > cursor) cursor = start

            val dataLen = buffer[start + 5].toInt() and 0xFF
            val total = HEADER_BYTES + dataLen + CRC_BYTES + TRAILER_BYTES

            if (start + total > len) {
                // Incomplete. If a LATER header already arrived, this was a
                // false positive inside a payload; rescan past it.
                var next = -1
                for (i in start + 1 until len - 1) {
                    if (buffer[i] == START && buffer[i + 1] == MARKER) {
                        next = i
                        break
                    }
                }
                if (next != -1) {
                    cursor = next
                    continue
                }
                cursor = start // genuine partial frame — wait for the rest
                break
            }

            if (buffer[start + total - 2] == END && buffer[start + total - 1] == END2) {
                frames.add(buffer.copyOfRange(start, start + total))
                cursor = start + total
            } else {
                // Trailer mismatch at length-derived position → false header.
                cursor = start + 1
            }
        }

        return ExtractResult(frames, buffer.copyOfRange(cursor, len))
    }

    // ── Per-frame parser ──
    fun parseFrame(frame: ByteArray): ParsedFrame? {
        if (frame.size < MIN_LEN) return null
        if (frame[0] != START || frame[1] != MARKER) return null
        if (frame[frame.size - 2] != END || frame[frame.size - 1] != END2) return null

        val func = frame[2].toInt() and 0xFF
        val dataLen = frame[5].toInt() and 0xFF
        val expectedTotal = HEADER_BYTES + dataLen + CRC_BYTES + TRAILER_BYTES
        if (frame.size != expectedTotal) return null
        if (func != 0x11) return null

        // CRC over frame[1 .. 5+dataLen]
        val computedCrc = crc16Modbus(frame, 1, 6 + dataLen)
        val remoteCrc = (frame[6 + dataLen].toInt() and 0xFF) or
                ((frame[7 + dataLen].toInt() and 0xFF) shl 8)
        val crcOk = computedCrc == remoteCrc
        val frameHex = toHex(frame)

        return parseStatusBody(frame.copyOfRange(HEADER_BYTES, HEADER_BYTES + dataLen), crcOk, frameHex)
    }

    private fun parseStatusBody(body: ByteArray, crcOk: Boolean, frameHex: String): ParsedFrame? {
        // A noise frame that merely *looks* like a header (e.g. 10 bytes with
        // dataLen = 0) yields an empty body; indexing it would throw on the
        // GATT binder thread, which has no handler and kills the process.
        // Everything below O_CELL_START_MV must exist for a status frame.
        if (body.size <= O_CELL_START_MV) return null

        val cellCount = body[O_CELL_COUNT].toInt() and 0xFF
        val batteryStatus = body[1].toInt() and 0xFF
        val realCellCount = cellCount.coerceIn(0, 32)
        val cellsMv = IntArray(realCellCount)
        for (i in 0 until realCellCount) {
            val off = O_CELL_START_MV + i * 2
            if (off + 2 > body.size) break
            cellsMv[i] = readU16LE(body, off) ?: 0
        }

        val tempSensorCount = body[O_TEMP_SENSOR_COUNT].toInt() and 0xFF
        val tempsList = mutableListOf<Float>()
        var off = O_CELL_START_MV + realCellCount * 2
        for (i in 0 until tempSensorCount) {
            val t = readI16LE(body, off)
            if (t != null) tempsList.add(t.toFloat())
            off += 2
        }
        // mosfet + balancer temperatures (always present per syssi)
        for (i in 0 until 2) {
            val t = readI16LE(body, off)
            if (t != null) tempsList.add(t.toFloat())
            off += 2
        }

        val tv = readU16LE(body, off)
        val totalVoltageV = if (tv != null) tv / 100f else null
        off += 2

        val ca = readI16LE(body, off)
        val currentA = if (ca != null) -(ca / 10f) else null
        off += 2

        val soc = readU16LE(body, off)?.toInt()
        off += 2
        val soh = readU16LE(body, off)?.toInt()
        off += 2
        val chargeMosfetCode = body.getOrNull(off)?.toInt()?.and(0xFF)
        val dischargeMosfetCode = body.getOrNull(off + 1)?.toInt()?.and(0xFF)
        val balancerCode = body.getOrNull(off + 2)?.toInt()?.and(0xFF)
        off += 4

        val tc = readU32LE(body, off)
        val capacityTotalAh = if (tc != null) tc / 1_000_000f else null
        off += 4

        val rc = readU32LE(body, off)
        val capacityRemainingAh = if (rc != null) rc / 1_000_000f else null
        off += 4

        // Cycle capacity — same µAh scaling as the two capacity fields above.
        val cc = readU32LE(body, off)
        val cycleCapacityAh = if (cc != null) cc / 1_000_000f else null
        off += 4

        val pw = readI32LE(body, off)
        val boardPowerW = if (pw != null) -pw else null
        // One canonical definition for live power and later Wh integration:
        // pack voltage × signed current from the same valid BMS frame.
        val powerW = if (totalVoltageV != null && currentA != null) {
            (totalVoltageV * currentA).roundToInt()
        } else boardPowerW
        off += 4

        val rt = if (body.size >= O_RUNTIME_SECONDS + 4) readU32LE(body, O_RUNTIME_SECONDS) else null

        return ParsedFrame(
            cmd = 0x11, cellCount = cellCount,
            cellsMv = cellsMv, tempsC = if (tempsList.isNotEmpty()) tempsList.toFloatArray() else null,
            totalVoltageV = totalVoltageV, currentA = currentA,
            batteryStatus = batteryStatus,
            socPct = soc, sohPct = soh, powerW = powerW,
            chargeMosfetCode = chargeMosfetCode,
            dischargeMosfetCode = dischargeMosfetCode,
            balancerCode = balancerCode,
            capacityTotalAh = capacityTotalAh, capacityRemainingAh = capacityRemainingAh,
            cycleCapacityAh = cycleCapacityAh,
            runtimeSeconds = rt, crcOk = crcOk, frameHex = frameHex,
        )
    }

    /**
     * Serialise a decoded BMS frame for the batch endpoint.
     */
    fun frameToJson(
        frame: ParsedFrame,
        deviceSn: String,
        phone: PhoneBatteryMonitor.Sample? = null,
        boardConnected: Boolean = true,
        isHeartbeat: Boolean = false,
        includeHex: Boolean = false,
        capturedAtIso: String? = null,
    ): String {
        val cells = JSONArray()
        frame.cellsMv?.forEach { cells.put(it) }
        val temps = JSONArray()
        frame.tempsC?.forEach { temps.put(it.toDouble()) }

        val obj = JSONObject()
        obj.put("device_sn", deviceSn)
        obj.put("cmd", frame.cmd)
        obj.put("cell_count", frame.cellCount ?: JSONObject.NULL)
        obj.put("cells_mv", cells)
        obj.put("temps_c", temps)
        obj.put("total_voltage_v", frame.totalVoltageV ?: JSONObject.NULL)
        obj.put("current_a", frame.currentA ?: JSONObject.NULL)
        obj.put("battery_status", frame.batteryStatus ?: JSONObject.NULL)
        obj.put("soc_pct", frame.socPct ?: JSONObject.NULL)
        obj.put("soh_pct", frame.sohPct ?: JSONObject.NULL)
        obj.put("charge_mosfet_code", frame.chargeMosfetCode ?: JSONObject.NULL)
        obj.put("discharge_mosfet_code", frame.dischargeMosfetCode ?: JSONObject.NULL)
        obj.put("balancer_code", frame.balancerCode ?: JSONObject.NULL)
        obj.put("power_w", frame.powerW ?: JSONObject.NULL)
        obj.put("capacity_total_ah", frame.capacityTotalAh ?: JSONObject.NULL)
        obj.put("capacity_remaining_ah", frame.capacityRemainingAh ?: JSONObject.NULL)
        obj.put("cycle_capacity_ah", frame.cycleCapacityAh ?: JSONObject.NULL)
        obj.put("runtime_seconds", frame.runtimeSeconds ?: JSONObject.NULL)
        obj.put("crc_ok", frame.crcOk)
        // frame_hex is a full-frame hex echo (~300 chars) that dwarfs every
        // parsed field combined (~35% of the payload). It only has forensic
        // value, so it rides along on the FIRST frame of each BLE session
        // (one raw sample to verify parsing against) instead of all of them.
        // The backend column is nullable — omitting it is safe.
        if (includeHex) obj.put("frame_hex", frame.frameHex)

        // Relay phone's own battery health (so a dead phone relay is visible too).
        if (phone != null) {
            obj.put("phone_battery_level_pct", phone.levelPct ?: JSONObject.NULL)
            obj.put("phone_battery_temp_c", phone.tempC ?: JSONObject.NULL)
            obj.put("phone_charging", phone.charging)
            obj.put("phone_battery_voltage_v", phone.voltageV ?: JSONObject.NULL)
        }

        obj.put("board_connected", boardConnected)
        obj.put("is_heartbeat", isHeartbeat)
        obj.put("captured_at", capturedAtIso ?: nowIsoUtc())
        return obj.toString()
    }

    private fun isoUtcOf(millis: Long): String {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return sdf.format(java.util.Date(millis))
    }

    /**
     * Phone-only status heartbeat. Sent on a timer even when no BMS frame
     * arrives, so the dashboard can show the relay phone as online
     * independently of whether the ANT board is attached.
     */
    fun phoneStatusJson(
        deviceSn: String,
        phone: PhoneBatteryMonitor.Sample?,
        boardConnected: Boolean,
        capturedAtIso: String? = null,
        pendingRows: Long = 0,
        bleStatus: String = "",
        bleState: String = "",
        appVer: String = "",
        screenOn: Boolean? = null,
    ): String {
        val obj = JSONObject()
        obj.put("device_sn", deviceSn)
        obj.put("board_connected", boardConnected)
        obj.put("is_heartbeat", true)
        // Outstanding offline backlog, so the dashboard can show "N samples
        // waiting" instead of implying everything is already synced.
        obj.put("pending_rows", pendingRows)
        // Remote-diagnostics: WHY the board is/ isn't attached, so the owner
        // can tell "扫描中" / "未发现设备" / "蓝牙权限不足" without touching the relay phone.
        if (bleStatus.isNotBlank()) obj.put("ble_status", bleStatus)
        if (bleState.isNotBlank()) obj.put("ble_state", bleState)
        // Which build is actually running — versionName was 1.0.0 for every
        // historical build, making a stale install indistinguishable from a
        // fresh one. The server stores this so version checks are one query.
        if (appVer.isNotBlank()) obj.put("app_ver", appVer)
        if (phone != null) {
            obj.put("phone_battery_level_pct", phone.levelPct ?: JSONObject.NULL)
            obj.put("phone_battery_temp_c", phone.tempC ?: JSONObject.NULL)
            obj.put("phone_charging", phone.charging)
            obj.put("phone_battery_voltage_v", phone.voltageV ?: JSONObject.NULL)
        }
        // Relay phone screen-on/off (Android 8 PARTIAL_WAKE_LOCK lets it sleep
        // even while relaying — see BleManager.heartbeatJson). null = unknown.
        if (screenOn != null) obj.put("phone_screen_on", screenOn)
        obj.put("captured_at", capturedAtIso ?: nowIsoUtc())
        return obj.toString()
    }

    // API 21+ safe ISO-8601 UTC timestamp (java.time requires API 26+).
    private fun nowIsoUtc(): String {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US)
        sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return sdf.format(java.util.Date())
    }
}
