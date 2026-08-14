package io.github.lovemygoddess.wheelsense

import android.content.Context
import android.location.GnssStatus
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * Bridges Android's `GnssStatus` so the JS side can show which satellite
 * constellations are in use (BEIDOU / GPS / GLONASS / GALILEO / QZSS / IRNSS /
 * SBAS) plus the total / used satellite counts and a coarse signal level.
 *
 * expo-location does NOT expose any of this (it only returns coords +
 * accuracy), so we listen to `LocationManager.registerGnssStatusCallback`
 * directly. Requires `ACCESS_FINE_LOCATION` (already declared / requested by
 * the dashboard tab). API 24+ only — below that `startListen` rejects.
 */
@ReactModule(name = GnssStatusModule.NAME)
class GnssStatusModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = NAME

    override fun getConstants(): MutableMap<String, Any> =
        hashMapOf("supportsGnss" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N))

    private val locationManager: LocationManager?
        get() = reactApplicationContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

    private var callback: GnssStatus.Callback? = null
    private val handler = Handler(Looper.getMainLooper())

    private val constellationNames = mapOf(
        GnssStatus.CONSTELLATION_GPS to "GPS",
        GnssStatus.CONSTELLATION_GLONASS to "GLONASS",
        GnssStatus.CONSTELLATION_BEIDOU to "BEIDOU",
        GnssStatus.CONSTELLATION_GALILEO to "GALILEO",
        GnssStatus.CONSTELLATION_QZSS to "QZSS",
        GnssStatus.CONSTELLATION_IRNSS to "IRNSS",
        GnssStatus.CONSTELLATION_SBAS to "SBAS",
        GnssStatus.CONSTELLATION_UNKNOWN to "UNKNOWN"
    )

    @ReactMethod
    fun startListen(promise: Promise) {
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) {
                promise.reject("GNSS_UNSUPPORTED", "Android N (API 24) required")
                return
            }
            val lm = locationManager
            if (lm == null) {
                promise.reject("GNSS_NO_MANAGER", "LocationManager unavailable")
                return
            }
            if (callback != null) {
                promise.resolve(null)
                return
            }
            val cb = object : GnssStatus.Callback() {
                override fun onSatelliteStatusChanged(status: GnssStatus) {
                    emitStatus(status)
                }
            }
            callback = cb
            @Suppress("DEPRECATION")
            lm.registerGnssStatusCallback(cb, handler)
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("GNSS_START_ERROR", e.message, e)
        }
    }

    @ReactMethod
    fun stopListen(promise: Promise) {
        try {
            callback?.let { loc ->
                locationManager?.let { lm ->
                    @Suppress("DEPRECATION")
                    lm.unregisterGnssStatusCallback(loc)
                }
            }
            callback = null
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("GNSS_STOP_ERROR", e.message, e)
        }
    }

    private fun emitStatus(status: GnssStatus) {
        val count = status.satelliteCount
        val constellationCounts = HashMap<Int, Int>()
        var used = 0
        for (i in 0 until count) {
            val type = status.getConstellationType(i)
            constellationCounts[type] = (constellationCounts[type] ?: 0) + 1
            if (status.usedInFix(i)) used++
        }
        val constellations = Arguments.createMap()
        for ((type, name) in constellationNames) {
            constellations.putInt(name, constellationCounts[type] ?: 0)
        }
        val map: WritableMap = Arguments.createMap()
        map.putMap("constellations", constellations)
        map.putInt("totalSatellites", count)
        map.putInt("usedSatellites", used)
        map.putInt("signalLevel", signalLevel(used, count))
        sendDeviceEvent("onGnssStatus", map)
    }

    /** 0 = none, 1 = weak, 2 = fair, 3 = good, 4 = strong. */
    private fun signalLevel(used: Int, total: Int): Int {
        if (total == 0) return 0
        return when {
            used >= 8 && total >= 12 -> 4
            used >= 5 -> 3
            used >= 3 -> 2
            used >= 1 -> 1
            else -> 0
        }
    }

    private fun sendDeviceEvent(event: String, params: WritableMap) {
        reactApplicationContext
            .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(event, params)
    }

    companion object {
        const val NAME = "GnssStatusModule"
    }
}
