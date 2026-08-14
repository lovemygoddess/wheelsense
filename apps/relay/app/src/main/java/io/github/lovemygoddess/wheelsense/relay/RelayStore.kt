package io.github.lovemygoddess.wheelsense.relay

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

/**
 * Durable outbox for the offline-first relay.
 *
 * The phone now lives in the scooter's tail box with no SIM, so uploads only
 * happen when it finds the owner's hotspot. Everything sampled in between has
 * to survive on disk — including across a process death or a power cut when
 * the power bank shuts off.
 *
 * Design notes:
 *  - Raw SQLiteOpenHelper, not Room. Room would drag in KSP + annotation
 *    processing for what is genuinely one table, and this module currently
 *    compiles with nothing but core-ktx/appcompat.
 *  - `id` is INTEGER PRIMARY KEY AUTOINCREMENT, which SQLite guarantees to be
 *    strictly monotonic *even after rows are deleted* (plain rowid reuses
 *    freed ids). That property is what makes it safe to use as the server-side
 *    `client_seq` dedup key: a resumed upload can say "everything after N" and
 *    never accidentally re-mean an old row.
 *  - Rows are deleted only after the server acknowledges them. A partial batch
 *    upload therefore costs a retry, never data.
 */
class RelayStore(ctx: Context) : SQLiteOpenHelper(ctx.applicationContext, DB_NAME, null, DB_VERSION) {

    companion object {
        private const val DB_NAME = "relay_outbox.db"
        private const val DB_VERSION = 1

        const val KIND_BMS = "bms"

        /** Ambient reading from the Xiaomi LYWSD03MMC (pvvx, plaintext 0x181A). */
        const val KIND_ENV = "env"

        /**
         * Raw BLE advertisement PDU captured from the Z07 tire-pressure/temp
         * sensors, for off-device reverse-engineering of the pressure/temp
         * encoding. Debug-only — Task #9 replaces it with parsed fields.
         */
        const val KIND_TPMS_CAPTURE = "tpms_capture"

        /**
         * Hard ceiling on queued rows. At the planned cadence (1 Hz while
         * riding, one sample per 10 min while parked) a week offline is
         * ~26 000 rows / ~7 MB, so 200 000 is roughly seven weeks of slack
         * before the eviction path can even trigger.
         */
        private const val MAX_ROWS = 200_000

        /** How many rows to drop per eviction pass once MAX_ROWS is hit. */
        private const val EVICT_CHUNK = 5_000

        @Volatile var lastError: String? = null
            private set
        @Volatile var lostSamples: Long = 0
            private set
        @Volatile var evictedRows: Long = 0
            private set
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE outbox (
              id         INTEGER PRIMARY KEY AUTOINCREMENT,
              kind       TEXT    NOT NULL,
              payload    TEXT    NOT NULL,
              created_at INTEGER NOT NULL
            )
            """.trimIndent()
        )
        db.execSQL("CREATE INDEX idx_outbox_kind ON outbox(kind)")
        // WAL is enabled via enableWriteAheadLogging() in onConfigure, NOT here.
        // Do NOT run "PRAGMA journal_mode=WAL" through execSQL — journal_mode is a
        // row-returning PRAGMA, and execSQL of any row-returning statement crashes
        // on Samsung Android 8.0 (API 26). enableWriteAheadLogging() already sets
        // WAL for every pooled connection.
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // No schema migrations yet; the outbox is transient by nature, so a
        // rebuild is acceptable and far safer than a half-applied migration.
        db.execSQL("DROP TABLE IF EXISTS outbox")
        onCreate(db)
    }

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.enableWriteAheadLogging()
    }

    override fun onOpen(db: SQLiteDatabase) {
        super.onOpen(db)
        // Keeps a writer racing the uploader from throwing
        // SQLiteDatabaseLockedException instead of waiting. busy_timeout is a
        // row-returning PRAGMA, so it MUST go through rawQuery (yields a Cursor),
        // NOT execSQL — execSQL of any row-returning statement crashes on Samsung
        // Android 8.0 (API 26). onOpen runs after the db is fully open and applies
        // to each pooled connection.
        try {
            db.rawQuery("PRAGMA busy_timeout=5000", null).use { it.moveToFirst() }
        } catch (_: Throwable) {
            // Best-effort only: losing the timeout risks a rare lock exception,
            // never worth crashing the service over.
        }
    }

    // ── Write path ──────────────────────────────────────────────

    /**
     * Queue one payload. Returns the assigned monotonic sequence, or -1 when
     * the insert failed (disk full / db corrupt) — callers treat that as
     * "sample lost" rather than crashing the sampling loop.
     */
    fun enqueue(kind: String, payload: String): Long {
        return try {
            val db = writableDatabase
            val cv = ContentValues().apply {
                put("kind", kind)
                put("payload", payload)
                put("created_at", System.currentTimeMillis())
            }
            val id = db.insert("outbox", null, cv)
            maybeEvict(db)
            id
        } catch (t: Throwable) {
            lastError = "写入失败: ${t.javaClass.simpleName}"
            lostSamples++
            -1L
        }
    }

    /**
     * Keep exactly one unsent phone-status heartbeat. Heartbeats are required
     * for dashboard liveness even when Samsung misses a connectivity callback,
     * but accumulating one per minute while truly offline is pointless.
     */
    fun enqueueLatestHeartbeat(payload: String): Long {
        return try {
            val db = writableDatabase
            db.beginTransaction()
            try {
                db.delete(
                    "outbox",
                    "kind = ? AND payload LIKE ?",
                    arrayOf(KIND_BMS, "%\"is_heartbeat\":true%"),
                )
                val cv = ContentValues().apply {
                    put("kind", KIND_BMS)
                    put("payload", payload)
                    put("created_at", System.currentTimeMillis())
                }
                val id = db.insert("outbox", null, cv)
                db.setTransactionSuccessful()
                id
            } finally {
                db.endTransaction()
            }
        } catch (t: Throwable) {
            lastError = "心跳写入失败: ${t.javaClass.simpleName}"
            lostSamples++
            -1L
        }
    }

    /**
     * Enforce the row ceiling. Ride samples are the point of offline mode, so
     * pressure is taken out on the oldest raw BMS samples
     * first — they are the densest and the most redundant. Only if BMS rows
     * alone can't free enough do we fall back to dropping oldest-of-anything.
     */
    private fun maybeEvict(db: SQLiteDatabase) {
        val count = countRows(db)
        if (count <= MAX_ROWS) return
        try {
            db.execSQL(
                "DELETE FROM outbox WHERE id IN " +
                    "(SELECT id FROM outbox WHERE kind = ? ORDER BY id ASC LIMIT ?)",
                arrayOf(KIND_BMS, EVICT_CHUNK)
            )
            evictedRows += EVICT_CHUNK
            if (countRows(db) > MAX_ROWS) {
                db.execSQL(
                    "DELETE FROM outbox WHERE id IN " +
                        "(SELECT id FROM outbox ORDER BY id ASC LIMIT ?)",
                    arrayOf<Any>(EVICT_CHUNK)
                )
            }
        } catch (t: Throwable) {
            lastError = "清理失败: ${t.javaClass.simpleName}"
        }
    }

    private fun countRows(db: SQLiteDatabase): Long {
        // NOTE: must use rawQuery, NOT compileStatement(...).simpleQueryForLong().
        // On Samsung Android 8.0 (API 26) a SELECT compiled into a SQLiteStatement
        // throws "Queries can be performed using SQLiteDatabase query or rawQuery
        // methods only", which crashes the service on first pendingCount().
        return try {
            db.rawQuery("SELECT COUNT(*) FROM outbox", null).use { c ->
                if (c.moveToFirst()) c.getLong(0) else 0L
            }
        } catch (t: Throwable) {
            lastError = "计数失败: ${t.javaClass.simpleName}"
            0L
        }
    }

    // ── Read path ───────────────────────────────────────────────

    data class Row(val id: Long, val kind: String, val payload: String)

    /** Oldest-first page of queued rows, for the batch uploader. */
    fun peekBatch(limit: Int): List<Row> {
        val out = ArrayList<Row>(limit)
        try {
            readableDatabase.rawQuery(
                "SELECT id, kind, payload FROM outbox ORDER BY id ASC LIMIT ?",
                arrayOf(limit.toString())
            ).use { c ->
                while (c.moveToNext()) {
                    out.add(Row(c.getLong(0), c.getString(1), c.getString(2)))
                }
            }
        } catch (t: Throwable) {
            lastError = "读取失败: ${t.javaClass.simpleName}"
        }
        return out
    }

    /** Newest queued row of one kind, used for a live preview before backfill. */
    fun peekLatestBoardFrame(): Row? {
        return try {
            readableDatabase.rawQuery(
                "SELECT id, kind, payload FROM outbox WHERE kind = ? ORDER BY id DESC LIMIT 64",
                arrayOf(KIND_BMS),
            ).use { c ->
                while (c.moveToNext()) {
                    val payload = c.getString(2)
                    val heartbeat = try {
                        JSONObject(payload).optBoolean("is_heartbeat", false)
                    } catch (_: Exception) {
                        true
                    }
                    if (!heartbeat) return@use Row(c.getLong(0), c.getString(1), payload)
                }
                null
            }
        } catch (t: Throwable) {
            lastError = "读取最新帧失败: ${t.javaClass.simpleName}"
            null
        }
    }

    /**
     * Delete every row up to and including `lastId` — called only after the
     * server has confirmed receipt. Inclusive-upper-bound rather than an id
     * list so a truncated ack still advances the queue correctly.
     */
    fun deleteThrough(lastId: Long) {
        try {
            writableDatabase.execSQL("DELETE FROM outbox WHERE id <= ?", arrayOf<Any>(lastId))
        } catch (t: Throwable) {
            lastError = "删除失败: ${t.javaClass.simpleName}"
        }
    }

    fun pendingCount(): Long = countRows(readableDatabase)

    /** Wipe the entire outbox — used by the `clear-backlog` remote command. */
    fun clear() {
        try {
            writableDatabase.execSQL("DELETE FROM outbox")
        } catch (_: Throwable) {
        }
    }

    /** Oldest queued row's wall-clock time, for "backlog since ..." UI. */
    fun oldestCreatedAt(): Long? {
        return try {
            readableDatabase.rawQuery(
                "SELECT created_at FROM outbox ORDER BY id ASC LIMIT 1", null
            ).use { c -> if (c.moveToFirst()) c.getLong(0) else null }
        } catch (_: Throwable) {
            null
        }
    }
}
