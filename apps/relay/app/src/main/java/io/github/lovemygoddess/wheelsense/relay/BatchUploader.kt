package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.GZIPOutputStream
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drains the offline outbox whenever the phone finds usable Wi-Fi.
 *
 * The relay has no SIM, so "online" means the owner's hotspot happened to come
 * into range. Two subtleties drive the design:
 *
 *  - **VALIDATED, not just CONNECTED.** A hotspot whose own mobile data is off
 *    still associates fine; uploading into it produces timeouts and a queue
 *    that never drains. Requiring NET_CAPABILITY_VALIDATED means we only try
 *    when the network actually reaches the internet.
 *  - **Delete only on acknowledgement.** Rows are removed strictly after the
 *    server confirms a sequence, so a hotspot that vanishes mid-batch costs a
 *    retry rather than a hole in the dataset.
 *
 * Payloads are gzipped (roughly 6:1 on this JSON) but the HMAC signs the
 * *uncompressed* body, matching the single-sample endpoint's semantics.
 */
class BatchUploader(
    private val ctx: Context,
    private val store: RelayStore,
) {

    companion object {
        /** Rows per request. Keeps a single failure cheap to retry. */
        private const val BATCH_SIZE = 500

        /** Pause between successive batches so we don't monopolise the link. */
        private const val INTER_BATCH_DELAY_MS = 300L

        private const val RETRY_MIN_MS = 30_000L
        private const val RETRY_MAX_MS = 15 * 60_000L

        /** Upload wakelock ceiling — a stuck socket must never hold the CPU. */
        private const val WAKELOCK_TIMEOUT_MS = 10 * 60_000L

        /** Periodic no-callback drain, in case the OEM ROM (Samsung) never
         *  fires onAvailable even when a link is up. */
        private const val DRAIN_FALLBACK_MS = 60_000L
    }

    var onStatus: ((String) -> Unit)? = null
    var onDrained: (() -> Unit)? = null

    @Volatile var lastSuccessAt: Long = 0L
        private set
    @Volatile var lastError: String? = null
        private set

    private val executor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())
    private val draining = AtomicBoolean(false)

    @Volatile private var online = false
    @Volatile private var batchUrl: String = deriveBatchUrl(RelayConfig.DEFAULT_SERVER_URL)
    @Volatile private var token: String = RelayConfig.DEFAULT_TOKEN
    @Volatile private var hmacSecret: String = RelayConfig.DEFAULT_HMAC_SECRET
    @Volatile private var deviceSn: String = RelayConfig.DEFAULT_DEVICE_SN
    private var retryMs = RETRY_MIN_MS

    /**
     * 实时上行节流（毫秒），由服务端配置 upload_ms 动态驱动：
     *  - 活跃采样：1000ms
     *  - 缓慢（其余）：5000ms
     *  - 缺省：3000ms
     * 只作用于「实时少量待发」的回传；大批量离线积压（尾箱机无 SIM 一周的数据，
     * 通常 ≥ BATCH_SIZE）走下方的 INTER_BATCH_DELAY_MS 尽快刷完，不被节流拖慢。
     */
    var uploadIntervalMs: Long = 3_000L
        set(v) {
            field = v.coerceIn(1_000L, 10_000L)
        }

    private var lastSendMs = 0L

    private var cm: ConnectivityManager? = null
    private var callback: ConnectivityManager.NetworkCallback? = null

    /** Periodic safety-net drain; runs even if the connectivity callback is
     *  never delivered (heavily customized OEM ROMs). */
    private val fallbackRunnable = object : Runnable {
        override fun run() {
            requestDrain(force = true)
            mainHandler.postDelayed(this, DRAIN_FALLBACK_MS)
        }
    }

    fun configure(cfg: RelayConfig) {
        batchUrl = deriveBatchUrl(cfg.serverUrl)
        token = cfg.token
        hmacSecret = cfg.hmacSecret
        deviceSn = cfg.deviceSn
    }

    /**
     * `serverUrl` points at the single-sample endpoint; the batch endpoint is
     * its sibling. Derived rather than configured separately so the user only
     * ever maintains one URL in settings.
     */
    private fun deriveBatchUrl(single: String): String =
        if (single.endsWith("/api/bms-live-snapshot")) {
            single.removeSuffix("/api/bms-live-snapshot") + "/api/relay/batch"
        } else {
            single
        }

    // ── Connectivity ────────────────────────────────────────────

    fun start() {
        val manager = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        cm = manager ?: return

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .apply {
                // VALIDATED is API 23+. Below that we accept any network and
                // let the upload attempt itself be the validation.
                if (Build.VERSION.SDK_INT >= 23) {
                    addCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                }
            }
            // Intentionally NO addTransportType(): the relay was Wi-Fi-only
            // (no SIM), but with a data SIM it stays online over the cellular
            // transport, which would never satisfy TRANSPORT_WIFI — leaving
            // `online` false so every buffered row stays undrained forever.
            // INTERNET+VALIDATED above already excludes captive/offline Wi-Fi.
            .build()

        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                online = true
                retryMs = RETRY_MIN_MS
                lastError = null
                onStatus?.invoke("已联网，开始回传")
                requestDrain()
            }

            override fun onLost(network: Network) {
                online = if (Build.VERSION.SDK_INT >= 23) {
                    val active = manager.activeNetwork
                    val caps = active?.let { manager.getNetworkCapabilities(it) }
                    caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED) == true
                } else false
                if (!online) onStatus?.invoke("网络断开，转离线缓存")
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                if (Build.VERSION.SDK_INT >= 23) {
                    val ok = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    if (ok && !online) {
                        online = true
                        requestDrain()
                    }
                }
            }
        }
        callback = cb
        try {
            manager.registerNetworkCallback(request, cb)
        } catch (_: Exception) {
        }
        // Safety net: even if onAvailable never fires, keep trying to drain.
        mainHandler.postDelayed(fallbackRunnable, DRAIN_FALLBACK_MS)
    }

    fun stop() {
        // Mark offline first so any in-flight drainLoop exits at its next check
        // instead of issuing another batch into a dead service.
        online = false
        // removeCallbacksAndMessages(null) also clears the anonymous retry
        // lambdas posted by scheduleRetry() — removeCallbacks(fallbackRunnable)
        // alone would let a queued retry fire requestDrain() into a shut-down
        // executor (RejectedExecutionException, swallowed, but noisy).
        mainHandler.removeCallbacksAndMessages(null)
        try {
            callback?.let { cm?.unregisterNetworkCallback(it) }
        } catch (_: Exception) {
        }
        callback = null
        // The executor thread would otherwise live for the rest of the process:
        // every service restart leaked one more thread (and its wakelock ref).
        executor.shutdownNow()
        // Give an in-flight upload a brief chance to finish before the store is
        // closed underneath it; HTTP timeouts are the real bound.
        try {
            executor.awaitTermination(3, java.util.concurrent.TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
        }
    }

    fun isOnline(): Boolean = online

    // ── Draining ────────────────────────────────────────────────

    /**
     * Kick a drain if one isn't already running. Safe from any thread.
     * @param force bypass the [online] guard — used by the periodic fallback so
     *   a missed connectivity callback (common on Samsung's customized ROM)
     *   cannot strand buffered rows forever.
     */
    fun requestDrain(force: Boolean = false) {
        if (!online && !force) return
        if (!draining.compareAndSet(false, true)) return
        executor.execute {
            val wl = acquireWakeLock()
            try {
                drainLoop(force)
            } catch (_: Throwable) {
            } finally {
                releaseWakeLock(wl)
                draining.set(false)
            }
        }
    }

    private fun drainLoop(force: Boolean) {
        var sent = 0
        publishLivePreviewWhenBacklogged()
        // `online || force` lets the forced attempt run at least one batch even
        // when the connectivity callback never fired; force mode then bails
        // after a single pass instead of looping forever.
        while (online || force) {
            val rows = store.peekBatch(BATCH_SIZE)
            if (rows.isEmpty()) {
                if (sent > 0) {
                    postStatus("回传完成，已上传 $sent 条")
                    mainHandler.post { onDrained?.invoke() }
                }
                retryMs = RETRY_MIN_MS
                return
            }

            val lastSeq = uploadBatch(rows)
            if (lastSeq == null) {
                if (force) return
                scheduleRetry()
                return
            }

            store.deleteThrough(lastSeq)
            sent += rows.count { it.id <= lastSeq }
            postStatus("回传中... 已上传 $sent，剩余 ${store.pendingCount()}")
            lastSendMs = System.currentTimeMillis()

            // Forced fallback does one pass then yields; the timer re-kicks it.
            // Normal mode keeps draining until the outbox is empty.
            if (force) return

            // 节流策略：大批量离线积压（≥ BATCH_SIZE）走小间隔尽快刷完；
            // 实时少量待发（1..BATCH_SIZE-1）按 upload_ms 节流，省电省流量；
            // 无待发则下一轮 while 直接退出。
            val pending = store.pendingCount()
            val gap = when {
                pending >= BATCH_SIZE -> INTER_BATCH_DELAY_MS
                pending >= 1 -> uploadIntervalMs
                else -> 0L
            }
            if (gap > 0) {
                try {
                    Thread.sleep(gap)
                } catch (_: InterruptedException) {
                    return
                }
            }
        }
    }

    /**
     * A short hotspot window must show current board data immediately. The
     * durable queue still drains oldest-first, but when it is over two minutes
     * behind we first upload the newest BMS row as an idempotent preview and
     * deliberately do not delete anything. Its normal ordered replay later is
     * acknowledged and removed with the rest of the queue.
     */
    private fun publishLivePreviewWhenBacklogged() {
        val oldest = store.oldestCreatedAt() ?: return
        if (System.currentTimeMillis() - oldest < 120_000L) return
        val latest = store.peekLatestBoardFrame() ?: return
        postStatus("检测到回传积压，优先刷新最新保护板数据")
        uploadBatch(listOf(latest))
    }

    /** @return the acknowledged last sequence, or null on any failure. */
    private fun uploadBatch(rows: List<RelayStore.Row>): Long? {
        val items = JSONArray()
        for (r in rows) {
            val item = JSONObject()
            item.put("seq", r.id)
            item.put("kind", r.kind)
            // payload is already a JSON document; embed it as an object rather
            // than a string so the server doesn't have to double-decode.
            item.put("data", try {
                JSONObject(r.payload)
            } catch (_: Exception) {
                JSONObject()
            })
            items.put(item)
        }

        val body = JSONObject().apply {
            put("device_sn", deviceSn)
            put("items", items)
        }.toString()

        val sig = hmacHex(body, hmacSecret)
        val gz = gzip(body)

        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(batchUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Content-Encoding", "gzip")
                setRequestProperty("Authorization", "Bearer $token")
                setRequestProperty("X-Relay-Sig", sig)
                doOutput = true
                // Generous: a 500-row batch over a phone hotspot in a garage.
                connectTimeout = 15_000
                readTimeout = 60_000
                setFixedLengthStreamingMode(gz.size)
            }
            conn.outputStream.use { it.write(gz) }

            val code = conn.responseCode
            if (code !in 200..299) {
                val err = try {
                    conn.errorStream?.bufferedReader()?.use { it.readText() }?.take(160) ?: ""
                } catch (_: Exception) {
                    ""
                }
                lastError = "HTTP $code ${err.trim()}".trim()
                postStatus("回传失败 $code ${err.trim()}")
                return null
            }

            val text = conn.inputStream.bufferedReader().use { it.readText() }
            val root = try {
                JSONObject(text)
            } catch (_: Exception) {
                lastError = "服务器响应格式错误"
                postStatus("回传失败：服务器响应格式错误")
                return null
            }
            val holder = root.optJSONObject("snapshot")
                ?: root.optJSONObject("data")
                ?: root
            val ack = if (holder.has("last_seq")) {
                try { holder.getLong("last_seq") } catch (_: Exception) { null }
            } else {
                rows.last().id // compatibility with older successful server builds
            }
            if (ack == null || ack < rows.first().id || ack > rows.last().id) {
                lastError = "服务器确认序号异常"
                postStatus("回传失败：服务器确认序号异常")
                return null
            }
            lastSuccessAt = System.currentTimeMillis()
            online = true
            lastError = null
            ack
        } catch (e: Exception) {
            lastError = e.javaClass.simpleName
            postStatus("回传异常: ${e.javaClass.simpleName}")
            null
        } finally {
            try {
                conn?.disconnect()
            } catch (_: Exception) {
            }
        }
    }

    private fun scheduleRetry() {
        val delay = retryMs
        retryMs = (retryMs * 2).coerceAtMost(RETRY_MAX_MS)
        postStatus("回传失败，${delay / 1000}s 后重试")
        mainHandler.postDelayed({ requestDrain() }, delay)
    }

    // ── Helpers ─────────────────────────────────────────────────

    private fun gzip(text: String): ByteArray {
        val bos = ByteArrayOutputStream()
        GZIPOutputStream(bos).use { it.write(text.toByteArray(Charsets.UTF_8)) }
        return bos.toByteArray()
    }

    private fun hmacHex(data: String, key: String): String {
        val mac = javax.crypto.Mac.getInstance("HmacSHA256")
        mac.init(javax.crypto.spec.SecretKeySpec(key.toByteArray(), "HmacSHA256"))
        return mac.doFinal(data.toByteArray(Charsets.UTF_8))
            .joinToString("") { b -> "%02x".format(b) }
    }

    private fun acquireWakeLock(): PowerManager.WakeLock? {
        return try {
            val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BmsRelay::upload").apply {
                setReferenceCounted(false)
                acquire(WAKELOCK_TIMEOUT_MS)
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun releaseWakeLock(wl: PowerManager.WakeLock?) {
        try {
            if (wl?.isHeld == true) wl.release()
        } catch (_: Throwable) {
        }
    }

    private fun postStatus(msg: String) {
        mainHandler.post { onStatus?.invoke(msg) }
    }
}
