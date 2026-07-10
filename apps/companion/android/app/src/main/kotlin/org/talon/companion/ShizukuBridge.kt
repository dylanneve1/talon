package org.talon.companion

import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import rikka.shizuku.Shizuku
import java.io.BufferedReader

/**
 * MethodChannel bridge for the optional Shizuku elevated-execution path.
 *
 * Dart (`DeviceExec`) calls:
 *   - isReady           → true when Shizuku is bound AND permission granted
 *   - requestPermission → prompt the user; returns whether granted
 *   - exec {cmd,cwd,timeoutMs} → run at shell (ADB) UID, return
 *                         {stdout, stderr, exitCode}
 *
 * Everything degrades gracefully: if the Shizuku app isn't installed/running
 * the calls report not-ready and Dart falls back to app-UID execution.
 *
 * `Shizuku.newProcess` is a hidden API, invoked reflectively (its signature is
 * stable across Shizuku 12/13). Any reflection/binding failure surfaces as a
 * FlutterError so the Dart side can fall back cleanly.
 */
class ShizukuBridge(channel: MethodChannel) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/shizuku"
        private const val REQUEST_CODE = 4021
    }

    private val pendingPermissions = mutableListOf<MethodChannel.Result>()

    /**
     * MethodChannel.Result is @UiThread-only — replying from a worker thread
     * (the exec thread, or Shizuku's binder callback) throws on the modern
     * Flutter embedding. Every reply funnels through this handler.
     */
    private val mainHandler = Handler(Looper.getMainLooper())

    private fun replySuccess(result: MethodChannel.Result, value: Any?) {
        mainHandler.post { result.success(value) }
    }

    private fun replyError(result: MethodChannel.Result, code: String, message: String?) {
        mainHandler.post { result.error(code, message, null) }
    }

    private val permissionListener =
        Shizuku.OnRequestPermissionResultListener { requestCode, grantResult ->
            if (requestCode == REQUEST_CODE) {
                val granted = grantResult == android.content.pm.PackageManager.PERMISSION_GRANTED
                val pending = pendingPermissions.toList()
                pendingPermissions.clear()
                pending.forEach { replySuccess(it, granted && isReady()) }
            }
        }

    init {
        channel.setMethodCallHandler(this)
        try {
            Shizuku.addRequestPermissionResultListener(permissionListener)
        } catch (_: Throwable) {
            // Shizuku not present — listener registration is a no-op path.
        }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getStatus" -> result.success(status())
            "requestPermission" -> requestPermission(result)
            "cancelPermissionRequest" -> cancelPermissionRequest(result)
            "exec" -> exec(call, result)
            else -> result.notImplemented()
        }
    }

    private fun binderAlive(): Boolean =
        try {
            Shizuku.pingBinder()
        } catch (_: Throwable) {
            false
        }

    private fun hasPermission(): Boolean =
        try {
            !Shizuku.isPreV11() &&
                Shizuku.checkSelfPermission() ==
                android.content.pm.PackageManager.PERMISSION_GRANTED
        } catch (_: Throwable) {
            false
        }

    private fun isReady(): Boolean = binderAlive() && hasPermission()

    private fun status(): Map<String, Any> {
        val binderAlive = binderAlive()
        val granted = binderAlive && hasPermission()
        val state = try {
            when {
                !binderAlive -> "not-running"
                granted -> "ready"
                Shizuku.shouldShowRequestPermissionRationale() -> "permission-denied"
                else -> "permission-needed"
            }
        } catch (_: Throwable) {
            "unavailable"
        }
        return mapOf("ready" to granted, "state" to state)
    }

    private fun requestPermission(result: MethodChannel.Result) {
        try {
            if (!binderAlive()) {
                result.success(false)
                return
            }
            if (hasPermission()) {
                result.success(true)
                return
            }
            if (Shizuku.shouldShowRequestPermissionRationale()) {
                result.success(false)
                return
            }
            // Several mesh requests can land together. Keep every caller
            // attached to the same Android permission prompt.
            if (pendingPermissions.isNotEmpty()) {
                pendingPermissions.add(result)
                return
            }
            pendingPermissions.add(result)
            Shizuku.requestPermission(REQUEST_CODE)
        } catch (_: Throwable) {
            val pending = pendingPermissions.toList()
            pendingPermissions.clear()
            if (pending.isEmpty()) {
                result.success(false)
            } else {
                pending.forEach { replySuccess(it, false) }
            }
        }
    }

    private fun cancelPermissionRequest(result: MethodChannel.Result) {
        val pending = pendingPermissions.toList()
        pendingPermissions.clear()
        pending.forEach { replySuccess(it, false) }
        result.success(null)
    }

    private fun exec(call: MethodCall, result: MethodChannel.Result) {
        if (!isReady()) {
            result.error("shizuku_unavailable", "Shizuku not ready", null)
            return
        }
        val cmd = call.argument<String>("cmd") ?: ""
        val cwd = call.argument<String>("cwd")
        val timeoutMs = (call.argument<Number>("timeoutMs")?.toLong()) ?: 60_000L
        Thread {
            try {
                val args = arrayOf("sh", "-c", cmd)
                val newProcess = Shizuku::class.java.getDeclaredMethod(
                    "newProcess",
                    Array<String>::class.java,
                    Array<String>::class.java,
                    String::class.java,
                )
                newProcess.isAccessible = true
                val process = newProcess.invoke(
                    null,
                    args,
                    null,
                    cwd,
                ) as Process

                val out = StringBuilder()
                val err = StringBuilder()
                val outThread = Thread {
                    process.inputStream.bufferedReader().useDrain(out)
                }
                val errThread = Thread {
                    process.errorStream.bufferedReader().useDrain(err)
                }
                outThread.start()
                errThread.start()

                val finished = process.waitForTimeout(timeoutMs)
                outThread.join(1_000)
                errThread.join(1_000)
                val exit = if (finished) process.exitValue() else {
                    process.destroy()
                    -1
                }
                replySuccess(
                    result,
                    mapOf(
                        "stdout" to out.toString(),
                        "stderr" to if (finished) err.toString()
                        else err.toString() + "\n[killed: timeout]",
                        "exitCode" to exit,
                    ),
                )
            } catch (t: Throwable) {
                replyError(result, "shizuku_exec_failed", t.message)
            }
        }.start()
    }
}

private fun BufferedReader.useDrain(sb: StringBuilder) {
    use { reader ->
        val buf = CharArray(4096)
        while (true) {
            val n = reader.read(buf)
            if (n < 0) break
            sb.append(buf, 0, n)
        }
    }
}

private fun Process.waitForTimeout(timeoutMs: Long): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < deadline) {
        try {
            exitValue()
            return true
        } catch (_: IllegalThreadStateException) {
            Thread.sleep(50)
        }
    }
    return false
}
