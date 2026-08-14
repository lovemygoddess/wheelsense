package io.github.lovemygoddess.wheelsense.relay

import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.hardware.camera2.params.StreamConfigurationMap
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Size
import androidx.core.content.ContextCompat
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * One-shot still capture using the Camera2 API, with no preview surface.
 *
 * The relay phone runs headless in the scooter's tail box, so there is no UI to
 * host a preview. We point the capture at an ImageReader's surface and pull the
 * JPEG out of it. Must be called OFF the main thread — it blocks on a latch
 * while the camera opens, focuses (auto), and delivers the frame.
 */
object Camera2PhotoCapture {

    private const val TIMEOUT_SEC = 12L

    /**
     * @param facing "front" or "back" (anything else defaults to back).
     * @return the captured JPEG file, or null on any failure (no camera, denied
     *   permission, timeout, or no image produced).
     */
    fun capture(context: Context, facing: String? = "back"): File? {
        if (ContextCompat.checkSelfPermission(context, android.Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED
        ) return null

        val cm = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager ?: return null
        val camId = pickCamera(cm, facing) ?: return null

        val thread = HandlerThread("relay-cam2").also { it.start() }
        val handler = Handler(thread.looper)
        val executor = Executors.newSingleThreadExecutor()

        val dir = File(context.cacheDir, "relay_photos")
        dir.mkdirs()
        val outFile = File(dir, "photo_${System.currentTimeMillis()}.jpg")

        var device: CameraDevice? = null
        var session: CameraCaptureSession? = null
        var reader: ImageReader? = null
        val latch = CountDownLatch(1)
        var captured: File? = null
        var failed = false

        val stateCallback = object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                device = camera
                try {
                    val chars = cm.getCameraCharacteristics(camId)
                    val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                    val size = chooseSize(map)
                    reader = ImageReader.newInstance(size.width, size.height, ImageFormat.JPEG, 1)
                    val surface = reader!!.surface
                    reader!!.setOnImageAvailableListener(
                        ImageReader.OnImageAvailableListener { readerRef ->
                            var image = readerRef.acquireLatestImage()
                            try {
                                if (image != null) {
                                    val buffer = image.planes[0].buffer
                                    val bytes = ByteArray(buffer.remaining())
                                    buffer.get(bytes)
                                    outFile.outputStream().use { it.write(bytes) }
                                    captured = outFile
                                }
                            } catch (_: Throwable) {
                                failed = true
                            } finally {
                                image?.close()
                                latch.countDown()
                            }
                        },
                        handler,
                    )

                    val sessionCallback = object : CameraCaptureSession.StateCallback() {
                        override fun onConfigured(s: CameraCaptureSession) {
                            session = s
                            try {
                                val req = camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE)
                                req.addTarget(surface)
                                s.capture(
                                    req.build(),
                                    object : CameraCaptureSession.CaptureCallback() {
                                        override fun onCaptureCompleted(
                                            session: CameraCaptureSession,
                                            request: CaptureRequest,
                                            result: TotalCaptureResult,
                                        ) {
                                            // Image arrives via the reader listener.
                                        }
                                    },
                                    handler,
                                )
                            } catch (_: Throwable) {
                                latch.countDown()
                            }
                        }

                        override fun onConfigureFailed(s: CameraCaptureSession) {
                            latch.countDown()
                        }
                    }
                    camera.createCaptureSession(listOf(surface), sessionCallback, handler)
                } catch (_: Throwable) {
                    latch.countDown()
                }
            }

            override fun onDisconnected(camera: CameraDevice) {
                latch.countDown()
            }

            override fun onError(camera: CameraDevice, error: Int) {
                failed = true
                latch.countDown()
            }
        }

        try {
            if (Build.VERSION.SDK_INT >= 30) {
                cm.openCamera(camId, executor, stateCallback)
            } else {
                cm.openCamera(camId, stateCallback, handler)
            }
        } catch (_: Throwable) {
            latch.countDown()
        }

        try {
            latch.await(TIMEOUT_SEC, TimeUnit.SECONDS)
        } catch (_: InterruptedException) {
        }

        // Tear down in reverse order.
        try { session?.close() } catch (_: Throwable) {}
        try { reader?.close() } catch (_: Throwable) {}
        try { device?.close() } catch (_: Throwable) {}
        executor.shutdownNow()
        thread.quitSafely()
        try { thread.join(2000) } catch (_: InterruptedException) {}

        return if (!failed && captured != null && outFile.exists() && outFile.length() > 0) outFile else null
    }

    private fun pickCamera(cm: CameraManager, facing: String?): String? {
        val wantFront = facing?.equals("front", ignoreCase = true) == true
        val target = if (wantFront) {
            CameraCharacteristics.LENS_FACING_FRONT
        } else {
            CameraCharacteristics.LENS_FACING_BACK
        }
        return try {
            cm.cameraIdList.firstOrNull { id ->
                cm.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == target
            } ?: cm.cameraIdList.firstOrNull()
        } catch (_: Throwable) {
            null
        }
    }

    private fun chooseSize(map: StreamConfigurationMap?): Size {
        if (map == null) return Size(1280, 720)
        val jpegSizes = map.getOutputSizes(ImageFormat.JPEG) ?: return Size(1280, 720)
        if (jpegSizes.isEmpty()) return Size(1280, 720)
        // Cap width at 1920 so uploads stay small; pick the largest within cap.
        return jpegSizes.filter { it.width <= 1920 }
            .maxByOrNull { it.width * it.height }
            ?: jpegSizes.maxByOrNull { it.width * it.height }!!
    }
}
