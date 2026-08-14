package io.github.lovemygoddess.wheelsense.relay

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build

/**
 * Receives the result of a PackageInstaller session we committed for a
 * self-update. On success the app simply restarts into the new version. If the
 * system wants the user to confirm the upgrade (STATUS_PENDING_USER_ACTION —
 * happens on some OEM/Android versions even for a same-signature update), we
 * launch the confirmation intent; on a tail-box phone with no one watching
 * this is a one-time manual tap after the very first self-update.
 */
class InstallStatusReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION = "io.github.lovemygoddess.wheelsense.relay.INSTALL_STATUS"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getIntExtra(
            PackageInstaller.EXTRA_STATUS,
            PackageInstaller.STATUS_FAILURE,
        )
        when (status) {
            PackageInstaller.STATUS_SUCCESS -> {
                // New version is installed; the process will restart shortly.
            }
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                }
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(confirm)
            }
            else -> {
                // Installation failed — command was already acked as
                // install_started; the owner can re-issue update_apk after
                // checking the relay log / storage space.
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "unknown"
            }
        }
    }
}
