package org.talon.companion

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * MethodChannel bridge for the companion's own updater — the fallback tier of
 * [org.talon.companion] self-update.
 *
 * Talon prefers to install its own APK silently through [DeviceExec]'s
 * elevated `pm install` (root or Shizuku), exactly as the daemon's remote
 * `update_device` does. Neither is available on an ordinary phone, so this
 * bridge covers the ordinary case: hand the downloaded APK to Android's own
 * package installer and let the user tap Install.
 *
 * Dart (`PlatformUpdateInstaller`) calls:
 *   - stageDir                 → where a download may be written: the app's
 *                                external files dir, which needs no storage
 *                                permission AND is readable by the shell UID,
 *                                which is what the Shizuku install path needs
 *                                (it cannot read /data/data).
 *   - canInstallPackages       → whether "install unknown apps" is granted
 *                                (always true below API 26).
 *   - requestInstallPermission → open that settings page for this package.
 *   - installApk {path}        → ACTION_VIEW the APK through the FileProvider
 *                                declared in the manifest. A raw file:// URI
 *                                would throw FileUriExposedException on N+,
 *                                so the content:// URI plus a read grant is
 *                                the only working shape.
 *
 * Nothing here can install anything by itself: the system dialog, the user's
 * tap, and Android's signature check on `-r` reinstall all still apply.
 */
class UpdateBridge(channel: MethodChannel, private val context: Context) :
    MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/update"
        private const val TAG = "TalonUpdate"
        private const val APK_MIME = "application/vnd.android.package-archive"
    }

    init {
        channel.setMethodCallHandler(this)
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "stageDir" -> result.success(stageDir().absolutePath)
            "canInstallPackages" -> result.success(canInstallPackages())
            "requestInstallPermission" -> {
                result.success(requestInstallPermission())
            }
            "installApk" -> {
                val path = call.argument<String>("path")
                if (path.isNullOrEmpty()) {
                    result.error("no-path", "No APK path given.", null)
                } else {
                    result.success(installApk(path))
                }
            }
            else -> result.notImplemented()
        }
    }

    /** `…/Android/data/<pkg>/files/updates`, created on demand. */
    private fun stageDir(): File {
        val base = context.getExternalFilesDir(null) ?: context.cacheDir
        val dir = File(base, "updates")
        if (!dir.exists()) dir.mkdirs()
        return dir
    }

    private fun canInstallPackages(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            context.packageManager.canRequestPackageInstalls()

    private fun requestInstallPermission(): Boolean = try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            false
        } else {
            val intent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not open the unknown-sources settings", e)
        false
    }

    private fun installApk(path: String): Boolean = try {
        val apk = File(path)
        if (!apk.isFile) {
            Log.w(TAG, "no APK at the given path")
            false
        } else {
            val uri = FileProvider.getUriForFile(
                context,
                "${context.packageName}.updates",
                apk,
            )
            val intent = Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, APK_MIME)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            true
        }
    } catch (e: Exception) {
        Log.w(TAG, "could not start the package installer", e)
        false
    }
}
