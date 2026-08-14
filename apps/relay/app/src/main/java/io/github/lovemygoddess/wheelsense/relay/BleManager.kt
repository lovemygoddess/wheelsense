package io.github.lovemygoddess.wheelsense.relay

import android.annotation.SuppressLint
import android.bluetooth.*
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.util.*
import java.util.concurrent.atomic.AtomicBoolean

/**
 * BLE link to the ANT BMS board, modelled as an explicit connection state
 * machine.
 *
 * Why a state machine rather than "scan -> connect -> postDelayed(5s) on drop":
 *  - Scan results keep arriving after stopScan() (they were already queued in
 *    the binder), so a naive callback would call connectGatt() several times
 *    and overwrite the `gatt` field, leaking every previous handle. After
 *    ~32 leaks connectGatt() returns status 133 forever and only a Bluetooth
 *    stack restart recovers. A single-shot latch closes that door.
 *  - Android 7+ silently refuses more than 5 startScan() calls per 30 s
 *    window (no callback, no error). A fixed 5 s retry hits that ceiling in
 *    25 s and then scans "forever" without ever being registered, so we back
 *    off exponentially and bound each scan to a window instead.
 *  - If Bluetooth is off (or is still coming up during BOOT_COMPLETED),
 *    bluetoothLeScanner is null. Without a state-change receiver the relay
 *    parks itself permanently; with one it resumes on its own.
 */
@SuppressLint("MissingPermission")
class BleManager {

    companion object {
        private const val SERVICE_UUID = "0000ffe0-0000-1000-8000-00805f9b34fb"
        private const val NOTIFY_UUID = "0000ffe1-0000-1000-8000-00805f9b34fb"
        private const val CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb"

        // ANT read-status poll command (CRC16/MODBUS over bytes 1..5 = A1 01 00 00 F5)
        // -> 0x6258 -> LE bytes 58 62.
        private val POLL_CMD = byteArrayOf(
            0x7E.toByte(), 0xA1.toByte(), 0x01, 0x00, 0x00,
            0xF5.toByte(), 0x58, 0x62,
            0xAA.toByte(), 0x55
        )

        /** Each scan runs at most this long before we stop and back off. */
        private const val SCAN_WINDOW_MS = 20_000L
        private const val BACKOFF_MIN_MS = 5_000L
        private const val BACKOFF_MAX_MS = 60_000L
        /** How long to wait for an OS auto-connect (see reconnectKnownBoard)
         *  before re-enabling active scanning as a fallback. */
        private const val AUTO_RECONNECT_TIMEOUT_MS = 30_000L

        /**
         * Minimum spacing between OS auto-connect attempts.
         *
         * 1.1.23 fired one from every scheduleRetry() — roughly one new
         * BluetoothGatt every 50 s. Each handle that is closed before the
         * stack finishes registering it leaks a GATT client interface
         * (BluetoothGatt.close() no-ops while mClientIf == 0), and Android
         * only allows a bounded number per process. Once exhausted,
         * registerScanner() fails with code 2 and connectGatt() with
         * status 257 — the whole BLE stack was dead until the bluetooth
         * process was restarted. Auto-connect is a nice-to-have; scanning is
         * the primary path, so keep the handle churn rare.
         */
        private const val AUTO_RECONNECT_MIN_INTERVAL_MS = 300_000L

        /**
         * A BluetoothGatt must be allowed to live at least this long before
         * close(), or the close races the asynchronous registerClient() and
         * silently leaks the client interface. See above.
         */
        private const val GATT_MIN_LIFETIME_MS = 1_500L

        /** 0x101 GATT_FAILURE — what a full client table returns on connect. */
        private const val GATT_ERROR_STACK_FULL = 257

        /**
         * Consecutive 257s before we call the stack wedged. Attempts are minutes
         * apart, so this is several minutes of hard failure — well past anything
         * a flaky radio or a sleeping board explains.
         */
        private const val WEDGE_GATT_FAILURE_THRESHOLD = 6

        /** GATT can report "connected" long after the board stopped answering. */
        private const val FRAME_WATCHDOG_MS = 45_000L

        /** Hard ceiling on the reassembly buffer so a stuck partial frame
         *  (valid header, length that never completes) can't grow unbounded. */
        private const val MAX_BUFFER_BYTES = 4096

        // ── Offline sampling gate ──
        // Storage, not bandwidth, is the constraint now: the phone lives in the
        // tail box with no SIM and only drains its queue when it meets the
        // owner's hotspot. A parked pack's numbers are frozen, so recording
        // them every second would fill the outbox with duplicates.
        //
        // While RIDING every frame is kept — the energy integral (∫V·I·dt) and
        // the ride's voltage curve are only as good as their sample density.
        // While PARKED a frame is kept on significant change, or every
        // idleKeepaliveMs as a heartbeat sample. Those slow parked samples
        // are also where resting OCV comes from, which is the one measurement
        // this whole setup gets that the live relay never could.
        // idleKeepaliveMs is instance-level and dashboard-configurable (the
        // "停车间隔" slider); it defaults to 10 min.

        /** BLE poll cadence while parked. Long enough to save power, short
         *  enough that the link stays up and a ride is noticed promptly. */
        private const val IDLE_POLL_MS = 30_000L

        // "Significant change" thresholds. Below these the frame carries no
        // new information worth a POST.
        private const val DELTA_VOLT_V = 0.05f
        private const val DELTA_CURRENT_A = 0.3f
        private const val DELTA_TEMP_C = 1.0f
    }

    private enum class State { STOPPED, IDLE, BT_OFF, SCANNING, CONNECTING, CONNECTED, BACKOFF }

    var onStatusUpdate: ((String) -> Unit)? = null

    /** Supplies the scanner's one-line diagnostics (scan state / failure count)
     *  so the heartbeat can surface WHY a board isn't attaching without touching
     *  the relay phone. Set by the service; null means "no extra detail". */
    var scannerDiagProvider: (() -> String)? = null

    /**
     * Every CRC-valid frame, before any storage gating. The segmenter needs the
     * full stream to integrate energy and detect ride boundaries; whether a
     * frame is also persisted is decided separately via [shouldRecord].
     */
    var onFrameDecoded: ((BmsProtocol.ParsedFrame) -> Unit)? = null

    /** Notifies the service when the physical protection-board link changes. */
    var onBoardConnectionChanged: ((Boolean) -> Unit)? = null

    /** Frames that passed the storage gate and should be queued for upload. */
    var onFrameRecorded: ((BmsProtocol.ParsedFrame, includeHex: Boolean) -> Unit)? = null

    /**
     * Raised when the BLE stack refuses to work at all — every connect attempt
     * comes back 257 (GATT_FAILURE) because the per-process client-interface
     * table is full. Nothing the app does can free those slots; the service
     * answers by restarting the bluetooth process. See [GATT_MIN_LIFETIME_MS].
     */
    @Volatile var onStackWedged: ((Int) -> Unit)? = null

    /** Consecutive connect attempts that died with a hard GATT error. */
    private var consecutiveGattFailures = 0

    var phoneBattery: PhoneBatteryMonitor? = null

    /**
     * Set by the service from the ride segmenter. In ride mode every frame is
     * recorded and the fast poll cadence is used; parked, both are throttled.
     */
    @Volatile var rideMode: Boolean = false

    /**
     * Dashboard-configurable BMS storage gate (ms). Mirrors the "停车间隔"
     * slider. While parked+stable, at most one sample per this interval is
     * kept (plus any significant-change frame). Pushed from BmsRelayService.
     */
    @Volatile var idleKeepaliveMs: Long = 10 * 60_000L

    /**
     * Dashboard-configurable ride-poll cadence (ms). Mirrors the "骑行间隔"
     * slider and drives how often POLL_CMD is sent while riding. Pushed from
     * BmsRelayService.
     */
    @Volatile var ridePollMs: Long = 1000L

    /**
     * Dashboard-configurable idle-poll cadence (ms). Mirrors the "停车间隔"
     * slider and drives how often POLL_CMD is sent while parked (idle mode).
     * Previously this was hard-coded to [IDLE_POLL_MS], so the slider silently
     * did nothing for the actual read rate — only the upload keepalive gate
     * honoured it. Now both follow the same configured value. Pushed from
     * BmsRelayService.
     */
    @Volatile var idlePollMs: Long = IDLE_POLL_MS

    /**
     * Drops the poll rate hard when the power bank has cut out, to stretch the
     * phone's own battery until someone finds it. Uses a fixed slow constant
     * (independent of the idle slider) so an unpowered relay always goes
     * ultra-low-power regardless of the parked sampling setting.
     */
    @Volatile var lowPowerMode: Boolean = false

    private var ctx: Context? = null
    private var cfg: RelayConfig? = null
    private var bluetoothAdapter: BluetoothAdapter? = null
    private var gatt: BluetoothGatt? = null
    private var notifyChar: BluetoothGattCharacteristic? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** elapsedRealtime when [gatt] was handed to us by connectGatt(). Used to
     *  keep close() from racing the async client registration. */
    private var gattOpenedAt = 0L

    /** elapsedRealtime of the last OS auto-connect attempt, for rate limiting. */
    private var lastAutoConnectAt = 0L

    @Volatile private var state: State = State.STOPPED

    /** Single-shot latch: only the first scan result may start a connection. */
    private val connectGate = AtomicBoolean(false)

    /**
     * MACs the board scan must never latch onto. The passive thermo sensor in
     * the tail box broadcasts 24/7 and, in the old code, would win the
     * "first discovered" fallback — latching the relay onto a device with no
     * 0xFFE0 service and looping forever without ever touching the ANT board.
     * Our own adapter address is excluded for the same reason.
     */
    private var ownMac: String? = null
    private var thermoMac: String? = null
    private val excludeMacs = mutableSetOf<String>()

    /** Last board MAC that successfully exposed the 0xFFE0 service. Persisted
     *  across runs so we connect straight to it (like the phone dashboard's
     *  remembered-device auto-connect) instead of re-guessing from scan names
     *  every cycle — which used to latch onto the wrong device (e.g. the
     *  dashboard phone) when the board advertised no recognizable name. */
    private var boardMac: String? = null
    private var connectedMac: String? = null
    private val BOARD_MAC_PREFS = "bms_relay_board"

    private fun rebuildExclude() {
        excludeMacs.clear()
        ownMac?.let { excludeMacs.add(it) }
        thermoMac?.let { excludeMacs.add(it) }
    }

    private fun loadBoardMac(): String? {
        return try {
            ctx?.getSharedPreferences(BOARD_MAC_PREFS, Context.MODE_PRIVATE)
                ?.getString("mac", null)
                ?.takeIf { it.isNotBlank() }
                ?.uppercase(Locale.US)
        } catch (_: Throwable) {
            null
        }
    }

    private fun saveBoardMac(mac: String?) {
        try {
            ctx?.getSharedPreferences(BOARD_MAC_PREFS, Context.MODE_PRIVATE)
                ?.edit()
                ?.putString("mac", mac?.uppercase(Locale.US))
                ?.apply()
        } catch (_: Throwable) {
        }
    }

    /** The tail-box thermo's MAC, pushed from the server config. Excluded from
     *  the board scan so its constant advertising can't shadow the ANT board. */
    fun setThermoMac(mac: String?) {
        thermoMac = mac?.takeIf { it.isNotBlank() }?.uppercase(Locale.US)
        rebuildExclude()
    }

    private fun isExcluded(device: BluetoothDevice): Boolean {
        val a = device.address ?: return false
        return excludeMacs.contains(a.uppercase(Locale.US))
    }

    private var backoffMs = BACKOFF_MIN_MS
    private var lastFrameAtMs = 0L
    private var btReceiverRegistered = false

    private val reassemblyBuffer = mutableListOf<Byte>()
    private val bmsProtocol = BmsProtocol()
    private var connectedName: String = ""

    // Upload-gate state. Written on the GATT binder thread (processReassembly),
    // read on the main thread only via the @Volatile idle flag.
    @Volatile private var idleMode = false
    private var sessionHexSent = false
    private var lastUploadMs = 0L
    private var lastUpSoc = Int.MIN_VALUE
    private var lastUpVolt = Float.NaN
    private var lastUpCurr = Float.NaN
    private var lastUpTempMax = Float.NaN

    // Current ANT board attachment state, surfaced to the heartbeat so the
    // dashboard can distinguish "relay online / board not attached" from
    // "relay offline". Updated by the GATT connection callback.
    @Volatile var boardConnected: Boolean = false
        private set

    private fun setBoardConnected(connected: Boolean) {
        if (boardConnected == connected) return
        boardConnected = connected
        onBoardConnectionChanged?.invoke(connected)
    }

    /** Latest BLE status text, surfaced to the heartbeat so the dashboard can
     *  show WHY the board is (or isn't) attached — e.g. "未发现设备",
     *  "蓝牙权限不足", "已连接 xxx". Driven by report(). */
    @Volatile var bleStatusText: String = "等待启动"
        private set

    /** Connection-state-machine label, for remote diagnostics on the dashboard. */
    fun bleStateName(): String = state.name

    // ── Lifecycle ──

    fun start(context: Context, config: RelayConfig) {
        ctx = context.applicationContext
        cfg = config
        val btManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
        bluetoothAdapter = btManager?.adapter
        ownMac = bluetoothAdapter?.address?.uppercase(Locale.US)
        rebuildExclude()
        boardMac = loadBoardMac()
        registerBtStateReceiver()

        if (bluetoothAdapter == null) {
            state = State.BT_OFF
            report("蓝牙不可用")
            return
        }
        backoffMs = BACKOFF_MIN_MS
        // Transition out of STOPPED before invoking the scan cycle: its first
        // line is `if (state == State.STOPPED) return`, so a freshly-started
        // manager (state still STOPPED) would skip scanning forever and the
        // relay would never look for the board. IDLE means "started, about to
        // scan"; beginScanCycle promotes it to SCANNING immediately.
        state = State.IDLE
        beginScanCycle()
    }

    fun stop() {
        state = State.STOPPED
        mainHandler.removeCallbacksAndMessages(null)
        stopPolling()
        teardownGatt()
        unregisterBtStateReceiver()
        setBoardConnected(false)
    }

    // ── Bluetooth adapter state ──

    private val btStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            when (intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)) {
                // Covers both "user re-enabled Bluetooth" and "the stack
                // restarted underneath us" — either way, rebuild from scratch.
                BluetoothAdapter.STATE_ON -> resumeAfterBtOn()
                BluetoothAdapter.STATE_OFF, BluetoothAdapter.STATE_TURNING_OFF -> {
                    if (state == State.STOPPED) return
                    mainHandler.removeCallbacksAndMessages(null)
                    stopPolling()
                    teardownGatt()
                    setBoardConnected(false)
                    state = State.BT_OFF
                    report("蓝牙已关闭，等待开启")
                }
                else -> {}
            }
        }
    }

    private fun resumeAfterBtOn() {
        if (state == State.STOPPED) return
        mainHandler.removeCallbacksAndMessages(null)
        teardownGatt()
        bluetoothAdapter = (ctx?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        backoffMs = BACKOFF_MIN_MS
        report("蓝牙已开启，重新扫描")
        // Give the stack a moment to publish the scanner after STATE_ON.
        mainHandler.postDelayed({ beginScanCycle() }, 1500L)
    }

    private fun registerBtStateReceiver() {
        if (btReceiverRegistered) return
        try {
            ctx?.registerReceiver(
                btStateReceiver,
                IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED)
            )
            btReceiverRegistered = true
        } catch (_: Exception) {
        }
    }

    private fun unregisterBtStateReceiver() {
        if (!btReceiverRegistered) return
        try {
            ctx?.unregisterReceiver(btStateReceiver)
        } catch (_: Exception) {
        }
        btReceiverRegistered = false
    }

    // ── Scanning ──

    /**
     * Fed by MiThermoScanner for every device it sees. The relay no longer runs
     * its own BLE scan — two concurrent startScan() calls on the single shared
     * BluetoothLeScanner (this + MiThermo) clobber each other's callback
     * registration on Samsung firmware, so neither onScanResult ever fired.
     * MiThermoScanner is now the sole scanner and forwards every device here.
     */
    fun considerDevice(result: ScanResult) {
        if (state == State.STOPPED || state == State.BT_OFF) return
        if (state == State.CONNECTED || state == State.CONNECTING) return
        val device = result.device ?: return
        val addr = device.address ?: return
        val name = safeName(device)
        val addrUp = addr.uppercase(Locale.US)
        val boardByName = isBoardName(name)
        val boardByMac = boardMac != null && addrUp == boardMac
        val excl = isExcluded(device)
        // Only log board candidates / excluded devices so we don't flood logcat
        // with every phone/earbud in range.
        if (boardByName || boardByMac || excl) {
            Log.d("BleManager", "scan name=\"$name\" addr=$addr rssi=${result.rssi} boardName=$boardByName excluded=$excl")
        }
        if ((boardByName || boardByMac) && !excl
            && connectGate.compareAndSet(false, true)
        ) {
            connect(device)
        }
    }

    /**
     * Enter "listening" mode. We deliberately do NOT run our own BLE scan:
     * two concurrent startScan() calls on the single BluetoothLeScanner the
     * OS exposes per adapter (this manager + MiThermoScanner) clobber each
     * other's callback registration on Samsung firmware — which is exactly why
     * neither onScanResult ever fired (the hygrometer feed also died at 08:49).
     * MiThermoScanner is now the sole scanner; it forwards every device via
     * [considerDevice], which connects the moment the board appears.
     */
    private fun beginScanCycle() {
        if (state == State.STOPPED) return
        if (state == State.CONNECTED || state == State.CONNECTING) return
        connectGate.set(false)
        state = State.SCANNING
        report("监听中（等待保护板广播）...")
        // If no board surfaces through considerDevice() within the window,
        // back off and retry. A board arriving promotes state straight to
        // CONNECTING, so this only drives the backoff path.
        mainHandler.postDelayed({
            if (state != State.SCANNING) return@postDelayed
            report("未发现设备，${backoffMs / 1000}秒后重试")
            scheduleRetry()
        }, SCAN_WINDOW_MS)
    }

    /** Exponential backoff, capped — keeps us under the 5-scans/30s ceiling. */
    private fun scheduleRetry() {
        if (state == State.STOPPED || state == State.BT_OFF) return
        state = State.BACKOFF
        // A fresh drop should retry fast — don't carry the backoff accumulated
        // from prior cycles, or the first auto-connect attempt gets needlessly
        // delayed.
        backoffMs = BACKOFF_MIN_MS
        // Let a board that shows up DURING backoff connect immediately, instead
        // of waiting for the next scan-cycle window to reset the gate. A stuck
        // gate here is what made some drops take a full backoff to recover.
        connectGate.set(false)
        // Known board? Kick an OS-level auto-connect so the stack relinks the
        // moment it advertises again, independent of our scan thread. Heavily
        // rate limited — see AUTO_RECONNECT_MIN_INTERVAL_MS. Most cycles this
        // is a no-op and we fall straight through to active scanning, which is
        // the path that kept the board linked for 2.5 h straight on 1.1.22.
        reconnectKnownBoard()
        val delay = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(BACKOFF_MAX_MS)
        mainHandler.postDelayed({ beginScanCycle() }, delay)
    }

    // ── Connection ──

    private fun connect(device: BluetoothDevice, autoConnect: Boolean = false) {
        if (state == State.STOPPED) return
        // Drop any stale handle before opening a new one — a leaked gatt is
        // exactly what makes connectGatt return status 133 forever on some
        // Samsung firmwares, after which only a Bluetooth restart recovers.
        teardownGatt()
        // Commit to this connection so a later scan candidate can't double-connect
        // (overwriting the gatt handle mid-link).
        connectGate.set(true)
        state = State.CONNECTING
        connectedName = safeName(device)
        connectedMac = device.address?.uppercase(Locale.US)
        report("连接 $connectedName${if (autoConnect) " (自动重连)" else ""}...")
        try {
            gattOpenedAt = SystemClock.elapsedRealtime()
            gatt = if (Build.VERSION.SDK_INT >= 23) {
                device.connectGatt(ctx, autoConnect, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(ctx, autoConnect, gattCallback)
            }
            if (gatt == null) {
                report("连接创建失败，${backoffMs / 1000}秒后重试")
                scheduleRetry()
            }
        } catch (_: Exception) {
            scheduleRetry()
        }
    }

    /**
     * Proactively reconnect to the board we already know, instead of waiting
     * for the scanner to rediscover it. The ANT board goes to sleep (stops
     * advertising) after ~3 min with no current AND no BT link, so a
     * scan-only recovery can never find it once it's asleep — it just loops
     * "未发现设备" forever. A direct `autoConnect=true` hands the job to the
     * OS Bluetooth stack, which reconnects the instant the board advertises
     * again (e.g. after it wakes or the scooter starts moving) — no polling
     * required. We still fall back to active scanning after
     * [AUTO_RECONNECT_TIMEOUT_MS] in case auto-connect is slow to fire.
     */
    private fun reconnectKnownBoard(): Boolean {
        if (state == State.STOPPED || state == State.BT_OFF) return false
        val mac = boardMac ?: return false
        val adapter = bluetoothAdapter ?: return false
        // Rate limit. One BluetoothGatt per retry cycle is what exhausted the
        // stack's client table (see AUTO_RECONNECT_MIN_INTERVAL_MS).
        val now = SystemClock.elapsedRealtime()
        if (lastAutoConnectAt != 0L && now - lastAutoConnectAt < AUTO_RECONNECT_MIN_INTERVAL_MS) {
            return false
        }
        val device = try {
            adapter.getRemoteDevice(mac)
        } catch (_: Throwable) {
            return false
        }
        lastAutoConnectAt = now
        // connect() owns the gate/state; hand it the device with autoConnect on.
        connect(device, autoConnect = true)
        // Fallback: if the OS auto-connect hasn't linked within the window,
        // re-enable active scanning so an awake-but-not-yet-linked board is
        // still discovered. Exactly one of these may ever be pending — a stale
        // one firing against a newer connection would tear down a link that is
        // only seconds old.
        mainHandler.removeCallbacks(autoConnectFallback)
        mainHandler.postDelayed(autoConnectFallback, AUTO_RECONNECT_TIMEOUT_MS)
        return true
    }

    /** See [reconnectKnownBoard]. Kept as a field so it can be cancelled. */
    private val autoConnectFallback = Runnable {
        if (state == State.CONNECTING && gatt != null) {
            teardownGatt()
            // Drop out of CONNECTING so beginScanCycle()'s guard lets the
            // active scan actually start (its first lines return early for
            // CONNECTED/CONNECTING).
            state = State.BACKOFF
            connectGate.set(false)
            beginScanCycle()
        }
    }

    /**
     * Always close through here so a handle is never abandoned.
     *
     * The close is deferred until the handle is at least [GATT_MIN_LIFETIME_MS]
     * old. connectGatt() registers its client interface asynchronously, and
     * BluetoothGatt.close() returns without unregistering anything while that
     * registration is still in flight (mClientIf == 0) — the interface is then
     * registered a moment later and never released. Repeat that ~32 times and
     * the process can no longer register scanners or GATT clients at all.
     */
    private fun teardownGatt() {
        val g = gatt ?: run {
            notifyChar = null
            reassemblyBuffer.clear()
            return
        }
        gatt = null
        notifyChar = null
        reassemblyBuffer.clear()
        mainHandler.removeCallbacks(autoConnectFallback)
        val age = SystemClock.elapsedRealtime() - gattOpenedAt
        if (age < GATT_MIN_LIFETIME_MS) {
            mainHandler.postDelayed({ closeGatt(g) }, GATT_MIN_LIFETIME_MS - age)
        } else {
            closeGatt(g)
        }
    }

    private fun closeGatt(g: BluetoothGatt) {
        try {
            g.disconnect()
        } catch (_: Exception) {
        }
        try {
            g.close()
        } catch (_: Exception) {
        }
    }

    private fun safeName(d: BluetoothDevice): String {
        return try {
            d.name ?: d.address
        } catch (_: SecurityException) {
            d.address
        }
    }

    /** True for an advertised name that looks like the ANT BMS board. */
    private fun isBoardName(name: String): Boolean {
        if (name.isBlank()) return false
        return name.contains("ANT", ignoreCase = true) ||
            name.contains("BMS", ignoreCase = true) ||
            name.contains("保护板", ignoreCase = true) ||
            name.contains("蚂蚁", ignoreCase = true)
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            try {
                if (newState == BluetoothProfile.STATE_CONNECTED &&
                    status == BluetoothGatt.GATT_SUCCESS
                ) {
                    state = State.CONNECTED
                    setBoardConnected(true)
                    backoffMs = BACKOFF_MIN_MS // healthy link resets the backoff
                    consecutiveGattFailures = 0 // the stack is demonstrably fine
                    // The link is up — a pending auto-connect fallback would
                    // otherwise still be armed and could tear it down.
                    mainHandler.removeCallbacks(autoConnectFallback)
                    report("已连接，发现服务...")
                    mainHandler.post {
                        try {
                            g.discoverServices()
                        } catch (_: Exception) {
                        }
                        try {
                            // Shorter connection interval (~7.5–15 ms) makes the
                            // link far more resilient to the 2.4 GHz noise the
                            // scooter's motor controller throws off while riding.
                            // Without this, sustained BLE drops were common.
                            g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                        } catch (_: Exception) {
                        }
                    }
                    return
                }

                if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                    setBoardConnected(false)
                    stopPolling()
                    stopWatchdog()
                    // Close the handle the callback handed us — the field may
                    // already point at a newer connection. Deferred while the
                    // handle is younger than GATT_MIN_LIFETIME_MS: a rejected
                    // connect reports DISCONNECTED within milliseconds, often
                    // before registerClient() has come back, and close() on a
                    // not-yet-registered handle is a silent no-op that leaks the
                    // slot for the life of the process.
                    val age = SystemClock.elapsedRealtime() - gattOpenedAt
                    if (age < GATT_MIN_LIFETIME_MS) {
                        mainHandler.postDelayed({ closeGatt(g) }, GATT_MIN_LIFETIME_MS - age)
                    } else {
                        closeGatt(g)
                    }
                    if (gatt === g) {
                        gatt = null
                        notifyChar = null
                    }
                    // 257 (0x101 GATT_FAILURE) on every attempt is the signature
                    // of an exhausted client table — the radio is fine, the stack
                    // simply has no slot left to hand out. Only a stack restart
                    // clears it, so escalate once it's clearly not transient.
                    if (status == GATT_ERROR_STACK_FULL) {
                        consecutiveGattFailures++
                        if (consecutiveGattFailures >= WEDGE_GATT_FAILURE_THRESHOLD) {
                            consecutiveGattFailures = 0
                            onStackWedged?.invoke(status)
                        }
                    } else if (status == BluetoothGatt.GATT_SUCCESS) {
                        consecutiveGattFailures = 0
                    }
                    reassemblyBuffer.clear()
                    // Only an *unsolicited* drop should trigger a retry. When we
                    // tore the link down ourselves (forceReconnect / BT off /
                    // stop) a retry is already scheduled or deliberately not
                    // wanted — scheduling a second one would run two scan
                    // cycles in parallel.
                    if (state != State.CONNECTED && state != State.CONNECTING) return
                    val why = if (status == 133) "(133)" else if (status != 0) "($status)" else ""
                    report("断开$why，${backoffMs / 1000}秒后重连")
                    scheduleRetry()
                }
            } catch (_: Throwable) {
                // A crash here would take down the whole process (binder thread).
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            try {
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    report("服务发现失败($status)")
                    forceReconnect()
                    return
                }
                val svc = g.getService(UUID.fromString(SERVICE_UUID)) ?: run {
                    report("未找到服务 0xFFE0")
                    forceReconnect()
                    return
                }
                val char = svc.getCharacteristic(UUID.fromString(NOTIFY_UUID)) ?: run {
                    report("未找到特征 0xFFE1")
                    forceReconnect()
                    return
                }
                notifyChar = char
                // Remember this MAC as the board so future cycles connect
                // straight to it instead of re-guessing from scan names.
                connectedMac?.let { m ->
                    boardMac = m
                    saveBoardMac(m)
                }
                try {
                    g.setCharacteristicNotification(char, true)
                    val desc = char.getDescriptor(UUID.fromString(CCCD_UUID))
                    desc?.let {
                        @Suppress("DEPRECATION")
                        it.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        g.writeDescriptor(it)
                    }
                } catch (_: SecurityException) {
                    report("通知权限不足")
                    return
                }
                // Negotiate a larger MTU so a 140+ byte status frame fits in fewer
                // transfers (less radio time, lower latency). Falls back silently
                // to the default 23 if the board rejects it.
                try {
                    g.requestMtu(247)
                } catch (_: Exception) {
                }
                report("已连接 $connectedName，开始轮询")
                startPolling()
                startWatchdog()
            } catch (_: Throwable) {
            }
        }

        @Suppress("DEPRECATION")
        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic
        ) {
            try {
                val data = characteristic.value ?: return
                onNotifyBytes(data)
            } catch (_: Throwable) {
                // Malformed input must never kill the binder thread.
                reassemblyBuffer.clear()
            }
        }

        override fun onCharacteristicChanged(
            g: BluetoothGatt,
            characteristic: BluetoothGattCharacteristic,
            value: ByteArray
        ) {
            try {
                onNotifyBytes(value)
            } catch (_: Throwable) {
                reassemblyBuffer.clear()
            }
        }
    }

    private fun onNotifyBytes(data: ByteArray) {
        if (data.isEmpty()) return
        reassemblyBuffer.addAll(data.toList())
        if (reassemblyBuffer.size > MAX_BUFFER_BYTES) {
            // Desynchronised beyond recovery (e.g. a bogus length byte);
            // drop everything and resynchronise on the next header.
            reassemblyBuffer.clear()
            return
        }
        processReassembly()
    }

    /** Drop the current link and go through the normal backoff/rescan path. */
    fun reconnectNow() {
        mainHandler.post { forceReconnect() }
    }

    private fun forceReconnect() {
        if (state == State.STOPPED || state == State.BT_OFF) return
        // Leave CONNECTED *before* tearing down, otherwise the disconnect
        // callback (binder thread) can slip in and schedule its own retry.
        state = State.BACKOFF
        stopPolling()
        stopWatchdog()
        setBoardConnected(false)
        teardownGatt()
        scheduleRetry()
    }

    // ── Polling ──

    private val pollRunnable = object : Runnable {
        override fun run() {
            writePoll()
            mainHandler.postDelayed(this, currentPollIntervalMs())
        }
    }

    /**
     * Three-tier cadence. Riding wins outright — the energy integral needs
     * 1 Hz. Otherwise a parked pack gets the slow poll, and a pack whose power
     * bank has died gets slower still. Single source of truth so the frame
     * watchdog can derive its threshold from the ACTUAL cadence.
     */
    private fun currentPollIntervalMs(): Long = when {
        rideMode -> ridePollMs
        lowPowerMode -> IDLE_POLL_MS * 4
        idleMode -> idlePollMs
        else -> ridePollMs
    }

    private fun startPolling() {
        stopPolling()
        lastFrameAtMs = System.currentTimeMillis()
        // New BLE session: force-upload the first frame (baseline for the
        // gate), re-attach one frame_hex sample, start in fast-poll mode.
        idleMode = false
        sessionHexSent = false
        lastUploadMs = 0L
        lastUpSoc = Int.MIN_VALUE
        lastUpVolt = Float.NaN
        lastUpCurr = Float.NaN
        lastUpTempMax = Float.NaN
        mainHandler.post(pollRunnable)
    }

    private fun stopPolling() {
        mainHandler.removeCallbacks(pollRunnable)
    }

    private fun writePoll() {
        val char = notifyChar ?: return
        val g = gatt ?: return
        try {
            // Match the phone dashboard: write WITHOUT response. HM-10-class
            // modules expose 0xFFE1 with the write-no-response property only;
            // a write-with-response (WRITE_TYPE_DEFAULT) is silently dropped,
            // so the poll never reaches the board and no frame ever comes back.
            if (Build.VERSION.SDK_INT >= 33) {
                g.writeCharacteristic(char, POLL_CMD, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE)
            } else {
                @Suppress("DEPRECATION")
                char.writeType = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                @Suppress("DEPRECATION")
                char.value = POLL_CMD
                @Suppress("DEPRECATION")
                g.writeCharacteristic(char)
            }
        } catch (_: Exception) {
        }
    }

    // ── Silent-link watchdog ──
    // GATT sometimes stays "connected" after the board is powered down or the
    // link goes stale; polls then vanish into the void forever. If no frame
    // arrives within the window, tear the link down and reconnect.

    private val watchdogRunnable = object : Runnable {
        override fun run() {
            if (state != State.CONNECTED) return
            // The threshold must follow the CURRENT poll cadence: in low-power
            // mode polls run every IDLE_POLL_MS*4 (120 s), far beyond the fixed
            // 45 s window, so a fixed threshold mistook "waiting for the next
            // scheduled poll" for a dead link and force-reconnected every 45 s —
            // burning the very battery the mode exists to save while the
            // reconnect churn starved actual sampling. Allow two full poll
            // intervals plus slack before declaring the link silent.
            //
            // While RIDING the poll runs at 1 Hz, so a healthy link gets frames
            // every ~1-2 s; if it goes quiet for 20 s that is clearly abnormal
            // (motor/controller RF interference killing the link), not normal
            // cadence — recover promptly instead of waiting the full 45 s.
            val threshold = if (rideMode) {
                maxOf(20_000L, currentPollIntervalMs() * 3 + 5_000L)
            } else {
                maxOf(FRAME_WATCHDOG_MS, currentPollIntervalMs() * 2 + 10_000L)
            }
            val silentFor = System.currentTimeMillis() - lastFrameAtMs
            if (silentFor > threshold) {
                report("板无响应 ${silentFor / 1000}s，重连")
                forceReconnect()
                return
            }
            mainHandler.postDelayed(this, FRAME_WATCHDOG_MS / 3)
        }
    }

    private fun startWatchdog() {
        stopWatchdog()
        mainHandler.postDelayed(watchdogRunnable, FRAME_WATCHDOG_MS / 3)
    }

    private fun stopWatchdog() {
        mainHandler.removeCallbacks(watchdogRunnable)
    }

    // ── Frame Reassembly ──

    private fun processReassembly() {
        val bytes = reassemblyBuffer.toByteArray()
        val result = bmsProtocol.extractFrames(bytes)
        reassemblyBuffer.clear()
        reassemblyBuffer.addAll(result.remainder.toList())
        for (frame in result.frames) {
            val parsed = try {
                bmsProtocol.parseFrame(frame)
            } catch (_: Throwable) {
                null
            } ?: continue

            // A frame that fails CRC carries garbage in every field. Uploading
            // it used to poison the dashboard with a "latest reading" of
            // 54 V / null everything, so it is dropped at the source.
            if (!parsed.crcOk) continue

            val now = System.currentTimeMillis()
            lastFrameAtMs = now // watchdog feeds on every frame, recorded or not

            // The segmenter sees everything — gating happens only for storage.
            onFrameDecoded?.invoke(parsed)

            if (!shouldRecord(parsed, now)) continue

            val withHex = !sessionHexSent
            sessionHexSent = true
            lastUploadMs = now
            onFrameRecorded?.invoke(parsed, withHex)
        }
    }

    /**
     * Storage gate.
     *
     * Riding: keep everything — sample density is what makes the energy
     * integral and the ride voltage curve trustworthy.
     * Parked: keep on significant change, else one sample per
     * idleKeepaliveMs (dashboard "停车间隔"). Those slow samples double as the resting-OCV series.
     */
    private fun shouldRecord(f: BmsProtocol.ParsedFrame, now: Long): Boolean {
        if (rideMode) return true
        if (lastUploadMs == 0L) return true // first frame of the session

        val volt = f.totalVoltageV ?: Float.NaN
        val curr = f.currentA ?: Float.NaN
        val soc = f.socPct ?: Int.MIN_VALUE
        val tempMax = f.tempsC?.maxOrNull() ?: Float.NaN

        val changed =
            (soc != lastUpSoc) ||
                movedBy(volt, lastUpVolt, DELTA_VOLT_V) ||
                movedBy(curr, lastUpCurr, DELTA_CURRENT_A) ||
                movedBy(tempMax, lastUpTempMax, DELTA_TEMP_C)

        val keepaliveDue = now - lastUploadMs >= idleKeepaliveMs
        if (!changed && !keepaliveDue) {
            idleMode = true
            return false
        }

        // Only a real change lifts us out of idle; a keepalive on its own means
        // the pack is still asleep, so keep the slow poll.
        if (changed) idleMode = false

        lastUpSoc = soc
        lastUpVolt = volt
        lastUpCurr = curr
        lastUpTempMax = tempMax
        return true
    }

    /** NaN-safe delta test: a field appearing/disappearing counts as a change. */
    private fun movedBy(a: Float, b: Float, threshold: Float): Boolean {
        if (a.isNaN() && b.isNaN()) return false
        if (a.isNaN() != b.isNaN()) return true
        return Math.abs(a - b) >= threshold
    }

    /**
     * Build a phone-only status heartbeat JSON (no board data) for the
     * periodic liveness ping. Reports the current board attachment state so
     * the dashboard can show "online / board not attached" vs "offline".
     */
    fun heartbeatJson(capturedAtIso: String? = null, pendingRows: Long = 0): String {
        val sn = cfg?.deviceSn ?: RelayConfig.DEFAULT_DEVICE_SN
        // Screen-on/off is cheap liveness metadata: a lit screen means the relay
        // app is foreground/visible (extra drain + heat); OFF means headless in
        // the tail box. Helps diagnose "why is the relay warm" without touching the relay phone.
        val pm = ctx?.getSystemService(Context.POWER_SERVICE) as? PowerManager
        val screenOn = pm?.isInteractive ?: null
        // Append the scanner's self-diagnostics so a "scan running but 0 results"
        // failure is visible from the dashboard without rooting the phone.
        val scannerDiag = scannerDiagProvider?.invoke()?.takeIf { it.isNotBlank() }
        val bleStatus = if (scannerDiag != null) "$bleStatusText | 扫描:$scannerDiag" else bleStatusText
        return bmsProtocol.phoneStatusJson(
            sn, phoneBattery?.sample(), boardConnected, capturedAtIso, pendingRows,
            bleStatus = bleStatus, bleState = state.name, appVer = appVersionName(),
            screenOn = screenOn,
        )
    }

    /** Installed versionName, read from PackageManager (no BuildConfig needed).
     *  versionName was frozen at 1.0.0 across builds, so a stale install was
     *  indistinguishable from a fresh one — the heartbeat now carries it. */
    private fun appVersionName(): String {
        val c = ctx ?: return ""
        return try {
            @Suppress("DEPRECATION")
            c.packageManager.getPackageInfo(c.packageName, 0).versionName ?: ""
        } catch (_: Throwable) {
            ""
        }
    }

    /** Shared parser instance, so the service can reuse the JSON builders. */
    fun protocol(): BmsProtocol = bmsProtocol

    private fun report(msg: String) {
        Log.d("BleManager", "status: $msg")
        bleStatusText = msg
        mainHandler.post { onStatusUpdate?.invoke(msg) }
    }
}
