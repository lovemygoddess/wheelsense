<?php

namespace App\Support;

/**
 * WGS-84 → GCJ-02 coordinate transformation (火星坐标系 / 国测局坐标).
 *
 * Background:
 *   - GPS hardware (including the Ninebot BMS's reported location) uses
 *     WGS-84, the global standard.
 *   - Chinese map providers (AMap / 百度 / 腾讯 / 高德) display in GCJ-02,
 *     an obfuscated system that's offset by 50–700m from WGS-84 inside
 *     China. Outside China, GCJ-02 == WGS-84 (no offset applies).
 *
 * The frontend's MapView already converts WGS-84 → GCJ-02 before passing
 * to AMap's JS API so the marker renders at the correct spot. The backend's
 * reverseGeocode() was passing raw WGS-84 to AMap's REST Regeo API — which
 * expects GCJ-02 — so the cached location_desc was off by the same 50–700m
 * offset from the actual location.
 *
 * Algorithm ported from the canonical coordtransform library (wandergis)
 * which is itself a port of the open-source implementation originally
 * published as the GCJ-02 obfuscation spec.
 *
 * NOTE: outside China, returns the original coordinates. AMap will simply
 * return nothing for such requests.
 */
final class CoordTransform
{
    /** Krasovsky 1940 ellipsoid semi-major axis (m). */
    private const A = 6378245.0;

    /** Krasovsky 1940 first eccentricity squared. */
    private const EE = 0.00669342162296594323;

    /**
     * Convert WGS-84 (lat, lng) in degrees to GCJ-02 (lat, lng) in degrees.
     *
     * @return array{0: float, 1: float} [gcj_lat, gcj_lng]
     */
    public static function wgs84ToGcj02(float $lat, float $lng): array
    {
        if (! self::isInsideChina($lat, $lng)) {
            return [$lat, $lng];
        }

        $x = $lng - 105.0;
        $y = $lat - 35.0;

        $dLat = self::transformXyz($x, $y, true);
        $dLng = self::transformXyz($x, $y, false);

        $radLat = $lat * M_PI / 180.0;
        $magic = sin($radLat);
        $magic = 1.0 - self::EE * $magic * $magic;
        $sqrtMagic = sqrt($magic);

        $dLat = ($dLat * 180.0) / ((self::A * (1.0 - self::EE) / ($magic * $sqrtMagic)) * M_PI);
        $dLng = ($dLng * 180.0) / ((self::A / $sqrtMagic * cos($radLat)) * M_PI);

        return [$lat + $dLat, $lng + $dLng];
    }

    /**
     * China approximate bounding box (GCJ-02 offset only applies inside).
     * Reference: https://lbs.qq.com/webservice_v1/guide-coordinate
     */
    private static function isInsideChina(float $lat, float $lng): bool
    {
        return $lng >= 72.004 && $lng <= 137.8347
            && $lat >= 0.8293 && $lat <= 55.8271;
    }

    /**
     * The polynomial-trigonometric offset function used by both lat and lng.
     * Two variants: one for latitude offset, one for longitude offset.
     */
    private static function transformXyz(float $x, float $y, bool $isLat): float
    {
        if ($isLat) {
            $ret = -100.0 + 2.0 * $x + 3.0 * $y + 0.2 * $y * $y + 0.1 * $x * $y + 0.2 * sqrt(abs($x));
            $ret += (20.0 * sin(6.0 * $x * M_PI) + 20.0 * sin(2.0 * $x * M_PI)) * 2.0 / 3.0;
            $ret += (20.0 * sin($y * M_PI) + 40.0 * sin($y / 3.0 * M_PI)) * 2.0 / 3.0;
            $ret += (160.0 * sin($y / 12.0 * M_PI) + 320.0 * sin($y * $y / 30.0 * M_PI)) * 2.0 / 3.0;
        } else {
            $ret = 300.0 + $x + 2.0 * $y + 0.1 * $x * $x + 0.1 * $x * $y;
            $ret += (20.0 * sin(6.0 * $x * M_PI) + 20.0 * sin(2.0 * $x * M_PI)) * 2.0 / 3.0;
            $ret += (20.0 * sin($x * M_PI) + 40.0 * sin($x / 3.0 * M_PI)) * 2.0 / 3.0;
            $ret += (150.0 * sin($x / 12.0 * M_PI) + 300.0 * sin($x / 30.0 * M_PI)) * 2.0 / 3.0;
        }
        return $ret;
    }
}
