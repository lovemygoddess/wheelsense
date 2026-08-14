package io.github.lovemygoddess.wheelsense.relay

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The relay's SOLE BLE scanner. It listens for the Xiaomi LYWSD03MMC running
 * the pvvx "Custom" firmware AND forwards every device it sees to
 * [BleManager.considerDevice] so the ANT BMS board can be connected.
 *
 * Why one scanner only:
 *   [BleManager] used to run its own scan, but two concurrent startScan() calls
 *   on the single BluetoothLeScanner the OS exposes per adapter clobber each
 *   other's callback registration on Samsung firmware — neither onScanResult
 *   ever fired (the hygrometer feed dying at 08:49 was the visible symptom).
 *   Routing both consumers through this one scanner removes the contention.
 *
 * The scan is intentionally UNFILTERED and LOW_LATENCY: the board advertises by
 * name only (no service data), so any filter would hide it; the relay is
 * mains-powered, so power isn't a concern. [handleResult] ignores non-thermo
 * frames and the forwarded callback ignores non-board devices, so the extra
 * callbacks are effectively free.
 *
 * No connection is ever made to the sensor — passive listening is what lets the
 * CR2032 last ~a year.
 */
@SuppressLint("MissingPermission")
class MiThermoScanner(
    private val ctx: Context,
    private val store: RelayStore,
    private val deviceSn: String,
    private val sensorMac: String?,
    /** Every device this sole scanner sees is forwarded here so the BMS board
     *  path ([BleManager.considerDevice]) can connect. The relay no longer runs
     *  its own BLE scan. */
    private val onDeviceSeen: ((ScanResult) -> Unit)? = null,
    /** Device-name prefixes captured for TPMS decoding. Empty = capture off. */
    private val tpmsCapturePrefixes: Set<String> = TPMS_CAPTURE_PREFIXES,
    /** Debug: capture a throttled sample of EVERY advertiser (see RelayConfig). */
    private val tpmsSurveyMode: Boolean = false,
) {

    data class Reading(
        val sensorMac: String,
        val tempC: Float,
        val humidityPct: Float,
        val sensorBatteryMv: Int,
        val rssi: Int,
        val capturedAtIso: String,
    )

    /** Latest reading, surfaced to the UI / debug. */
    @Volatile var latest: Reading? = null
        private set

    var onReading: ((Reading) -> Unit)? = null

    companion object {
        private val ENV_UUID = UUID.fromString("0000181a-0000-1000-8000-00805f9b34fb")

        /**
         * Device-name prefixes we passively capture for TPMS decoding. The
         * compatible Z07 tire-pressure/temp sensors may advertise with names like
         * "Z07FFHTW2KYZ" (front) / "Z07G0GNSZCPY" (rear); any BLE device whose
         * advertised name starts with one of these prefixes gets its full raw
         * advertisement PDU recorded for later decoding. Set empty to disable
         * capture entirely.
         */
        val TPMS_CAPTURE_PREFIXES: Set<String> = setOf("Z07")

        /**
         * Throttle: at most one env record every this many ms, and only when the
         * reading moved past the delta thresholds. The sensor broadcasts a few
         * times a second; the dashboard only needs a fresh value a few times a
         * minute, so we keep the outbox tiny.
         */
        private const val MIN_INTERVAL_MS = 30_000L
        private const val DELTA_TEMP_C = 0.1f
        private const val DELTA_HUM_PCT = 0.5f
        private const val DELTA_BATT_MV = 10

        // ---- Diagnostics -----------------------------------------------------
        // Surfaced in the relay's own UI. Without these a "no data" report is
        // unfalsifiable: not scanning, scanning but filtered out, wrong MAC and
        // wrong payload length all look identical from the dashboard.

        /** Human-readable scan state, e.g. "扫描中(0x181A过滤)" / "蓝牙未开启". */
        @Volatile var diagScanState: String = "未启动"

        /** 0x181A service-data frames seen, regardless of MAC. */
        @Volatile var diagRawHits: Long = 0

        /** Frames dropped because the embedded MAC wasn't the configured one. */
        @Volatile var diagMacMismatch: Long = 0

        /** Most recent non-matching MAC — lets the user spot a mistyped address. */
        @Volatile var diagLastOtherMac: String? = null

        /** Payload length of the last frame too short to be a pvvx Custom frame. */
        @Volatile var diagLastBadLen: Int = -1

        /** Rows actually pushed into the outbox. */
        @Volatile var diagEnqueued: Long = 0

        /** Z07 TPMS frames seen (device name matched a capture prefix). */
        @Volatile var diagTpmsSeen: Long = 0

        /** Z07 TPMS raw captures actually pushed into the outbox. */
        @Volatile var diagTpmsEnqueued: Long = 0

        /** Times startScan() failed (SCAN_FAILED_*). A climbing count with no
         *  board/env data means the scan session keeps dying on (re)start — the
         *  classic Samsung "scan running but 0 results forever" symptom. */
        @Volatile var diagScanFailures: Long = 0

        /** Failures since the last delivered scan result. Unlike the running
         *  total this drops back to 0 the moment the scanner works again, so a
         *  non-zero value in a heartbeat means "broken right now". */
        @Volatile var diagConsecFailures: Int = 0

        /** Wall-clock ms of the last accepted reading, 0 if never. */
        @Volatile var diagLastReadingMs: Long = 0

        /** One-line summary for the settings screen. */
        fun diagLine(): String {
            val sb = StringBuilder("温湿度: ").append(diagScanState)
            sb.append(" 命中").append(diagRawHits)
            if (diagMacMismatch > 0) {
                sb.append(" MAC不符").append(diagMacMismatch)
                diagLastOtherMac?.let { sb.append('(').append(it).append(')') }
            }
            if (diagLastBadLen >= 0) sb.append(" 短包").append(diagLastBadLen).append('B')
            sb.append(" 入队").append(diagEnqueued)
            if (diagTpmsSeen > 0) sb.append(" 胎压命中").append(diagTpmsSeen).append(" 抓包").append(diagTpmsEnqueued)
            if (diagScanFailures > 0) sb.append(" 扫描失败").append(diagScanFailures)
            if (diagConsecFailures > 0) sb.append(" 连续失败").append(diagConsecFailures)
            if (diagLastReadingMs > 0) {
                val age = (System.currentTimeMillis() - diagLastReadingMs) / 1000
                sb.append(" 距上次").append(age).append('s')
            }
            return sb.toString()
        }
    }

    @Volatile private var running = false
    /** True between a successful startScan and the next stopScan. Guards against
     *  re-issuing startScan on an already-running scan, which on Samsung Oreo
     *  returns SCAN_FAILED_ALREADY_STARTED and, via onScanFailed, spins a
     *  start/stop storm that parks the scan as opportunistic (0 results). */
    private var isScanning = false
    private val mainHandler = Handler(Looper.getMainLooper())
    private var scanner: android.bluetooth.le.BluetoothLeScanner? = null

    /** Samsung Oreo parks a background scan as opportunistic once the device
     *  idles in the tail box, so onScanResult stops firing while the scan still
     *  "runs". Re-issuing the scan every few minutes wakes it back up. The relay
     *  is mains-powered, so the churn is free. */
    private val HIGH_PERF_KEEPALIVE_MS = 90_000L
    private val LOW_POWER_KEEPALIVE_MS = 5 * 60_000L
    @Volatile private var highPerformance = true
    private val discoveryDowngrade = Runnable {
        if (!running || !highPerformance) return@Runnable
        highPerformance = false
        restartScan()
    }

    /** Delay between stopScan() and the next startScan(). See [restartScan] —
     *  without it Samsung Oreo coalesces the two into one call and the scan
     *  stays parked at 0 results. */
    private val SCAN_RESTART_DELAY_MS = 1_000L

    /** First retry delay after a scan failure; doubles up to [FAIL_BACKOFF_MAX_MS]. */
    private val FAIL_BACKOFF_MIN_MS = 2_000L
    private val FAIL_BACKOFF_MAX_MS = 60_000L
    private var failBackoffMs = FAIL_BACKOFF_MIN_MS

    /** Consecutive failures before we declare the BLE stack wedged. With the
     *  backoff above that is roughly 4 minutes of solid failure — long enough
     *  that a transient (BT toggling, Doze) never trips it. */
    private val WEDGE_FAIL_THRESHOLD = 8

    /**
     * Raised when startScan() has failed [WEDGE_FAIL_THRESHOLD] times in a row.
     * The stack's per-process client table is full and nothing this class can
     * do will free it — the owner has to recover (restart the bluetooth
     * process, or failing that this process). Argument is the last error code.
     */
    @Volatile var onStackWedged: ((Int) -> Unit)? = null

    // Last uploaded values, for the change-based throttle.
    private var lastUploadMs = 0L
    private var lastTempC = Float.NaN
    private var lastHumPct = Float.NaN
    private var lastBattMv = -1

    /** Z07 TPMS capture cadence — at most one raw frame per device name per window.
     *  Pressure and temperature drift slowly, so a few frames a minute is plenty
     *  to decode the static layout without flooding the offline outbox. */
    private val TPMS_CAPTURE_MIN_INTERVAL_MS = 10_000L

    /** Per-MAC wall-clock of the last TPMS capture, for the throttle. */
    private val lastTpmsCaptureMs = ConcurrentHashMap<String, Long>()

    /** Debug survey: hard cap on total captured advertisers so it can't grow
     *  unbounded in the offline outbox / server table. High enough to survive a
     *  multi-minute ride while still bounding the debug table. TPMS frames do
     *  NOT count against this cap (see [isTpmsLike] / [TPMS_DEDICATED_CAP]). */
    private val TPMS_SURVEY_CAP = 8000
    private val tpmsSurveyCount = java.util.concurrent.atomic.AtomicInteger(0)

    /** Known TPMS manufacturer company IDs, aligned with the backend decoder
     *  (TpmsController::TPMS_COMPANY_IDS). A frame from one of these is always
     *  captured (even with no device name) and never counts against the survey
     *  cap, so the tire sensor's data frames can't be squeezed out by the noisy
     *  BLE neighbourhood while the vehicle is parked for days. */
    private val TPMS_MANUFACTURER_IDS: Set<Int> = setOf(0x1E00, 0x1E01, 0x1E02)

    /** Dedicated, much higher cap for TPMS frames. They only arrive while the
     *  wheels move, so even a long ride produces a bounded number; this just
     *  prevents a pathological multi-day capture from growing without limit. */
    private val TPMS_DEDICATED_CAP = 20000
    private val tpmsDedicatedCount = java.util.concurrent.atomic.AtomicInteger(0)

    /** True if a scan result looks like a TPMS advertisement: by advertised name
     *  prefix, by a name token anywhere in the raw PDU, or by a known TPMS
     *  manufacturer company ID (covers nameless data frames). */
    private fun isTpmsLike(result: ScanResult): Boolean {
        val record = result.scanRecord ?: return false
        val name = record.deviceName
        if (name != null && tpmsCapturePrefixes.any { name.startsWith(it, ignoreCase = true) }) {
            return true
        }
        val raw = record.bytes
        if (raw != null) {
            val rawAscii = String(raw, Charsets.US_ASCII)
            if (tpmsCapturePrefixes.any { rawAscii.contains(it, ignoreCase = true) }) return true
        }
        val manuData = record.manufacturerSpecificData
        if (manuData != null) {
            for (i in 0 until manuData.size()) {
                if (TPMS_MANUFACTURER_IDS.contains(manuData.keyAt(i))) return true
            }
        }
        return false
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            try {
                // Any delivered result proves the scan session is genuinely
                // alive, so the failure streak and its backoff start over.
                if (diagConsecFailures != 0) diagConsecFailures = 0
                if (failBackoffMs != FAIL_BACKOFF_MIN_MS) failBackoffMs = FAIL_BACKOFF_MIN_MS
                val nm = result.scanRecord?.deviceName
                val ad = result.device?.address
                Log.d("MiThermo", "seen name=\"$nm\" addr=$ad rssi=${result.rssi}")
                // Forward every device to the BMS board path (which needs an
                // unfiltered scan to see the ANT board), then try to decode this
                // frame as a thermo reading. Non-thermo frames bail out of
                // handleResult on the first byte, so the extra work is cheap.
                onDeviceSeen?.invoke(result)
                handleResult(result)
                captureTpms(result)
            } catch (_: Throwable) {
                // Never let a scan callback kill the binder thread.
            }
        }

        override fun onScanFailed(errorCode: Int) {
            Log.e("MiThermo", "scan failed code=$errorCode")
            isScanning = false
            diagScanFailures++
            diagConsecFailures++
            diagScanState = "扫描失败(code=$errorCode)"
            if (!running) return
            // A wedged stack cannot be retried out of. SCAN_FAILED_APPLICATION_
            // REGISTRATION_FAILED (2) means the process has no client interface
            // slots left; every later startScan AND connectGatt fails too. A
            // fixed short retry loop cannot recover, so escalate to the owner.
            if (diagConsecFailures >= WEDGE_FAIL_THRESHOLD) {
                Log.e("MiThermo", "BLE stack looks wedged ($diagConsecFailures consecutive failures)")
                diagConsecFailures = 0
                failBackoffMs = FAIL_BACKOFF_MAX_MS
                onStackWedged?.invoke(errorCode)
            }
            // Back off exponentially. A tight retry also blows past Android's
            // 5-scans-per-30 s ceiling, which makes matters worse.
            val delay = failBackoffMs
            failBackoffMs = (failBackoffMs * 2).coerceAtMost(FAIL_BACKOFF_MAX_MS)
            mainHandler.postDelayed({ restartScan() }, delay)
        }
    }

    fun start() {
        running = true
        tryStartScan()
    }

    fun stop() {
        running = false
        isScanning = false
        try {
            scanner?.stopScan(scanCallback)
        } catch (_: Exception) {
        }
        scanner = null
        diagScanState = "已停止"
        mainHandler.removeCallbacksAndMessages(null)
    }

    /** Switches scan duty without creating a second scanner. */
    fun setHighPerformance(enabled: Boolean) {
        mainHandler.post {
            mainHandler.removeCallbacks(discoveryDowngrade)
            if (highPerformance == enabled) return@post
            highPerformance = enabled
            if (running) restartScan()
        }
    }

    /** Fast initial discovery, then automatically returns to LOW_POWER. */
    fun startDiscoveryBurst() {
        mainHandler.post {
            mainHandler.removeCallbacks(discoveryDowngrade)
            if (!highPerformance) {
                highPerformance = true
                if (running) restartScan()
            }
            mainHandler.postDelayed(discoveryDowngrade, 20_000L)
        }
    }

    private fun tryStartScan() {
        if (!running) return
        val adapter = (ctx.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        if (adapter == null || !adapter.isEnabled) {
            // Bluetooth off / still coming up. Retry later; the service's BT
            // receiver also re-triggers start() if needed.
            Log.w("MiThermo", "BT not ready, retry in 30s")
            diagScanState = "蓝牙未开启"
            mainHandler.postDelayed({ tryStartScan() }, 30_000L)
            return
        }
        val sc = try {
            adapter.bluetoothLeScanner
        } catch (_: Exception) {
            null
        }
        if (sc == null) {
            Log.w("MiThermo", "no BluetoothLeScanner, retry in 30s")
            mainHandler.postDelayed({ tryStartScan() }, 30_000L)
            return
        }
        scanner = sc
        startScanInternal(sc)
    }

    /**
     * Start one scan pass with NO filter. The relay is mains-powered (tail box),
     * so power is no object; an unfiltered LOW_LATENCY pass is what lets this
     * single scanner surface BOTH the thermo beacon (0x181A service data) and
     * the ANT board (advertised by name only — no service data, so any filter
     * would hide it from the board path). [handleResult] ignores non-thermo
     * frames and the forwarded [onDeviceSeen] ignores non-board devices, so the
     * extra callbacks cost nothing.
     *
     * @return true if the scan actually started.
     */
    private fun startScanInternal(sc: android.bluetooth.le.BluetoothLeScanner): Boolean {
        if (isScanning) return true // already running; don't re-issue (Samsung Oreo ALREADY_STARTED storm)
        return try {
            val filters = emptyList<ScanFilter>()
            // The sensor advertises on its own slow cadence and the board may
            // only broadcast briefly, so a low-duty scan can sit in a gap for
            // minutes. Trade the power budget for a prompt first reading.
            val mode = if (highPerformance) {
                ScanSettings.SCAN_MODE_LOW_LATENCY
            } else {
                ScanSettings.SCAN_MODE_LOW_POWER
            }
            val settings = ScanSettings.Builder()
                .setScanMode(mode)
                .build()
            sc.startScan(filters, settings, scanCallback)
            isScanning = true
            val profile = if (highPerformance) "快速" else "省电"
            Log.i("MiThermo", "scan started ($profile, unfiltered)")
            diagScanState = "扫描中($profile)"
            scheduleKeepalive()
            true
        } catch (_: SecurityException) {
            // Permission revoked mid-run; nothing to do but wait for a retry.
            Log.e("MiThermo", "scan start denied: missing location/scan permission")
            diagScanState = "缺少定位/扫描权限"
            false
        } catch (e: Exception) {
            Log.e("MiThermo", "scan start failed", e)
            diagScanState = "扫描启动失败"
            mainHandler.postDelayed({ tryStartScan() }, 30_000L)
            false
        }
    }

    /**
     * Stop the current scan and start a FRESH one after a short delay.
     *
     * The delay is load-bearing, not cosmetic. On Samsung Oreo a startScan()
     * issued in the same looper tick as stopScan() is coalesced into the
     * still-active (background-parked) session and returns
     * SCAN_FAILED_ALREADY_STARTED — which strands us in a permanent retry loop
     * that delivers 0 results forever (the "scan running but finds nothing"
     * symptom). Giving the stack ~1 s to actually tear the old session down is
     * what lets the next startScan() register a genuinely new scan that will
     * deliver onScanResult again.
     */
    private fun restartScan() {
        if (!running) return
        try { scanner?.stopScan(scanCallback) } catch (_: Exception) { }
        isScanning = false
        mainHandler.postDelayed({ tryStartScan() }, SCAN_RESTART_DELAY_MS)
    }

    /**
     * Samsung Oreo silently parks a background BLE scan as opportunistic once
     * the device is idle in the tail box, so onScanResult stops firing even
     * though the scan still "runs" (see the 0-results-forever dumpsys symptom).
     * Re-issuing the scan every [SCAN_KEEPALIVE_MS] wakes it back up. The relay
     * is mains-powered, so the extra churn is free.
     *
     * The re-issue goes through [restartScan] (stop + delayed start) so each
     * wake-up actually creates a fresh scan session instead of re-binding to the
     * parked one.
     *
     * CRITICAL: exactly ONE pending keepalive may ever exist. A previous build
     * posted the lambda inline (so removeCallbacks couldn't find it) AND called
     * scheduleKeepalive() twice per cycle (once via startScanInternal's success
     * path, once at the runnable's end). Every 90 s the timer count doubled;
     * ~15 min in, thousands of concurrent stop/startScan calls tripped Samsung's
     * 5-scans/30 s rate limit and killed the scan for good. A NAMED Runnable +
     * removeCallbacks before every post makes the singleton invariant hold no
     * matter how many times scheduleKeepalive() is called.
     */
    private val keepaliveRunnable = object : Runnable {
        override fun run() {
            if (!running) return
            Log.d("MiThermo", "keepalive: re-issuing scan")
            restartScan()
            scheduleKeepalive()
        }
    }

    private fun scheduleKeepalive() {
        mainHandler.removeCallbacks(keepaliveRunnable)
        val delay = if (highPerformance) HIGH_PERF_KEEPALIVE_MS else LOW_POWER_KEEPALIVE_MS
        if (running) mainHandler.postDelayed(keepaliveRunnable, delay)
    }

    /**
     * Some BLE stacks offload filtering to the controller and handle
     * service-data matching poorly. If the filtered pass yields nothing at all
     * within the probe window, drop the filter and match in software instead —
     * [handleResult] bails out on the very first byte for non-0x181A frames, so
     * the extra callbacks are cheap.
     */
    private fun handleResult(result: ScanResult) {
        val record = result.scanRecord ?: return
        val data = record.getServiceData(ParcelUuid(ENV_UUID)) ?: return
        diagRawHits++
        val reading = parse(data, result.rssi) ?: return
        // Whitelist by the MAC embedded in the payload (authoritative), not the
        // possibly-randomized Android device address.
        if (!reading.sensorMac.equals(sensorMac, ignoreCase = true)) {
            diagMacMismatch++
            diagLastOtherMac = reading.sensorMac
            return
        }

        diagLastBadLen = -1
        diagLastReadingMs = System.currentTimeMillis()
        latest = reading
        onReading?.invoke(reading)
        maybeEnqueue(reading)
    }

    /**
     * Passive TPMS capture. Compatible Z07 tire-pressure/temp sensors broadcast
     * over BLE; the relay — locked in the tail box and already the sole BLE
     * scanner — records their full raw advertisement PDU (plus the
     * manufacturer- and service-data maps) so we can reverse-engineer the
     * pressure/temperature encoding off-device, without connecting to or
     * disturbing the sensor.
     *
     * Matching is by advertised device-name prefix, OR — as a fallback for
     * sensors that don't surface a name via [android.bluetooth.le.ScanRecord.getDeviceName]
     * — by the "Z07" token appearing anywhere in the raw advertising PDU. The
     * raw-bytes fallback is what actually fires for sensors that carry the name
     * only inside the advertisement body / scan response. Capture is throttled
     * per device (name when present, else MAC) so a chatty sensor can't flood
     * the offline outbox; a few frames a minute is more than enough to decode a
     * layout that barely changes.
     */
    private fun captureTpms(result: ScanResult) {
        val record = result.scanRecord ?: return

        // ---- Debug survey: capture a throttled sample of EVERY advertiser ----
        // We still don't know the Z07 sensor's real BLE advertisement name, so
        // dump a bounded sample of everything the relay hears and identify the
        // tire sensor from the data. Capped by TPMS_SURVEY_CAP.
        if (tpmsSurveyMode) {
            val tpms = isTpmsLike(result)
            // TPMS frames bypass the survey cap so they're never dropped; the cap
            // only bounds the noisy non-TPMS neighbourhood capture.
            if (!tpms && tpmsSurveyCount.get() >= TPMS_SURVEY_CAP) return
            diagTpmsSeen++
            // Throttle per MAC so co-located sensors that share a BLE name
            // (e.g. front/rear TPMS both advertising "JH.TPMS") are captured
            // as distinct rows instead of collapsing onto one throttle key.
            if (!throttleTpms(result.device.address)) return
            val key = record.deviceName ?: result.device.address
            enqueueTpms(result, key, survey = true, isTpms = tpms)
            return
        }

        if (tpmsCapturePrefixes.isEmpty()) return

        // Match by name prefix, raw-PDU token, or a known TPMS manufacturer
        // company ID — the last is what catches nameless data frames (only a
        // 0xFF manufacturer record, no device name).
        if (!isTpmsLike(result)) return

        diagTpmsSeen++
        if (!throttleTpms(result.device.address)) return
        val key = record.deviceName ?: result.device.address
        enqueueTpms(result, key, survey = false, isTpms = true)
    }

    /** Per-device throttle for TPMS captures; true => this capture may proceed. */
    private fun throttleTpms(key: String): Boolean {
        val nowMs = System.currentTimeMillis()
        val last = lastTpmsCaptureMs[key] ?: 0L
        if (nowMs - last < TPMS_CAPTURE_MIN_INTERVAL_MS) return false
        lastTpmsCaptureMs[key] = nowMs
        return true
    }

    /** Build the capture JSON from a ScanResult and enqueue it (counts a capture). */
    private fun enqueueTpms(result: ScanResult, sensorName: String, survey: Boolean, isTpms: Boolean = false) {
        // TPMS frames have their own (much higher) cap so a long ride can't be
        // truncated; the survey cap is reserved for the noisy neighbourhood.
        if (isTpms && tpmsDedicatedCount.get() >= TPMS_DEDICATED_CAP) return
        val record = result.scanRecord ?: return
        val raw = record.bytes ?: return
        val mac = result.device.address

        // Manufacturer-specific data: SparseArray<companyId, bytes>.
        val manu = JSONObject()
        val manuData = record.manufacturerSpecificData
        if (manuData != null) {
            for (i in 0 until manuData.size()) {
                val cid = manuData.keyAt(i)
                val b = manuData.valueAt(i) ?: continue
                manu.put("%04X".format(cid), toHex(b))
            }
        }

        // Service data: iterate advertised UUIDs (no flat map accessor exists).
        val svc = JSONObject()
        val uuids = record.serviceUuids
        if (uuids != null) {
            for (u in uuids) {
                val b = record.getServiceData(u) ?: continue
                svc.put(u.uuid.toString(), toHex(b))
            }
        }

        // Co-located sensors can share a BLE name (front/rear TPMS both advertise
        // "JH.TPMS"). Suffix a short MAC tail so they stay distinguishable in the
        // store / dashboard, and always record the raw MAC for grouping.
        val distinctName = if (sensorName == mac) mac
        else "$sensorName#${mac.replace(":", "").takeLast(4)}"

        val json = JSONObject().apply {
            put("sensor_name", distinctName)
            put("mac", mac)
            put("rssi", result.rssi)
            put("raw_bytes", Base64.encodeToString(raw, Base64.NO_WRAP))
            put("manufacturer_data", manu)
            put("service_data", svc)
            put("captured_at", nowIsoUtc())
            if (survey) put("survey", true)
        }.toString()

        val id = store.enqueue(RelayStore.KIND_TPMS_CAPTURE, json)
        if (id > 0) {
            diagTpmsEnqueued++
            if (survey && !isTpms) tpmsSurveyCount.incrementAndGet()
            if (isTpms) tpmsDedicatedCount.incrementAndGet()
        }
    }

    /** Hex-encode a byte array (uppercase, no separators). */
    private fun toHex(b: ByteArray): String =
        buildString(b.size * 2) {
            for (byte in b) append("%02X".format(byte.toInt() and 0xFF))
        }

    /**
     * Decode the pvvx "Custom" advertising payload carried in the 0x181A
     * service-data record. Layout per the upstream `adv_custom_t` struct
     * (the 1-byte size / 1-byte AD-type / 2-byte UUID header is already
     * stripped by [android.bluetooth.le.ScanRecord.getServiceData]):
     *
     *   bytes 0-5  : MAC, **little-endian** — `MAC[0]` is the LOW digit pair,
     *                so it must be reversed to match the printed address.
     *   bytes 6-7  : temperature,     int16  LE, * 0.01 °C
     *   bytes 8-9  : humidity,        uint16 LE, * 0.01 %
     *   bytes 10-11: battery voltage, uint16 LE, mV
     *   byte  12   : battery level, 0..100 %
     *   byte  13   : frame counter
     *   byte  14   : GPIO_TRG flags
     *
     * Total 15 bytes. The older atc1441 format also rides on 0x181A but is
     * 13 bytes with different scaling, so the exact length check doubles as a
     * format guard — decoding an atc1441 frame with these offsets would emit
     * plausible-looking garbage.
     */
    private fun parse(data: ByteArray, rssi: Int): Reading? {
        if (data.size < 15) {
            diagLastBadLen = data.size
            return null
        }
        val mac = buildMac(data)
        val tempC = byteArrayToInt16LE(data, 6) / 100f
        val humPct = byteArrayToUint16LE(data, 8) / 100f
        val battMv = byteArrayToUint16LE(data, 10)
        return Reading(
            sensorMac = mac,
            tempC = tempC,
            humidityPct = humPct,
            sensorBatteryMv = battMv,
            rssi = rssi,
            capturedAtIso = nowIsoUtc(),
        )
    }

    private fun nowIsoUtc(): String {
        val sdf = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", java.util.Locale.US)
        sdf.timeZone = java.util.TimeZone.getTimeZone("UTC")
        return sdf.format(java.util.Date())
    }

    /** Reverse the little-endian MAC into the printed `AA:BB:CC:DD:EE:FF` form. */
    private fun buildMac(data: ByteArray): String =
        (5 downTo 0).joinToString(":") { "%02X".format(data[it].toInt() and 0xFF) }

    private fun byteArrayToInt16LE(b: ByteArray, off: Int): Short =
        ((b[off + 1].toInt() shl 8) or (b[off].toInt() and 0xFF)).toShort()

    private fun byteArrayToUint16LE(b: ByteArray, off: Int): Int =
        ((b[off + 1].toInt() and 0xFF) shl 8) or (b[off].toInt() and 0xFF)

    /**
     * Throttle uploads: enqueue only when at least [MIN_INTERVAL_MS] elapsed AND
     * the reading moved beyond the delta thresholds. Keeps the outbox small while
     * still capturing real changes promptly.
     */
    private fun maybeEnqueue(r: Reading) {
        val now = System.currentTimeMillis()
        val changed = lastTempC.isNaN() ||
            kotlin.math.abs(r.tempC - lastTempC) >= DELTA_TEMP_C ||
            kotlin.math.abs(r.humidityPct - lastHumPct) >= DELTA_HUM_PCT ||
            kotlin.math.abs(r.sensorBatteryMv - lastBattMv) >= DELTA_BATT_MV
        val due = now - lastUploadMs >= MIN_INTERVAL_MS

        if (!changed && !due) return

        val json = JSONObject().apply {
            put("sensor_mac", r.sensorMac)
            put("temp_c", r.tempC)
            put("humidity_pct", r.humidityPct)
            put("sensor_battery_mv", r.sensorBatteryMv)
            put("rssi", r.rssi)
            put("captured_at", r.capturedAtIso)
        }.toString()

        val id = store.enqueue(RelayStore.KIND_ENV, json)
        if (id > 0) {
            diagEnqueued++
            lastUploadMs = now
            lastTempC = r.tempC
            lastHumPct = r.humidityPct
            lastBattMv = r.sensorBatteryMv
        }
    }
}
