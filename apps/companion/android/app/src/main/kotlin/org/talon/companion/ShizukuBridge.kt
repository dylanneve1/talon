package org.talon.companion

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import rikka.shizuku.Shizuku
import rikka.shizuku.ShizukuProvider
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
 * The Shizuku binder is handed to this process *asynchronously* by
 * `ShizukuProvider`. We must not assume `pingBinder()` is already true — a mesh
 * exec that arrives before the handover (a backgrounded or cold-started
 * process answering an SSE command) would otherwise read isReady()==false and
 * silently run at app UID. So we request the binder for this process up front,
 * track its arrival via a sticky listener, and briefly *wait* for it off the
 * platform thread before reporting status / running exec — mirroring the
 * reference Shizuku clients (shizuku_apk_installer, MultiLocale).
 *
 * `Shizuku.newProcess` is a hidden API, invoked reflectively. Any
 * reflection/binding failure surfaces as a FlutterError so the Dart side can
 * fall back cleanly.
 */
class ShizukuBridge(
    channel: MethodChannel,
    private val context: Context,
) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/shizuku"
        private const val REQUEST_CODE = 4021

        /** How long a status/exec probe waits for the binder handover. */
        private const val BINDER_WAIT_MS = 2_000L

        /**
         * Logcat tag for the whole Shizuku path. In release builds Dart's
         * `developer.log` does NOT reach logcat, so when elevation silently
         * fails there is nothing to read — every decision here is logged under
         * this tag instead. Diagnose a future failure with:
         *   adb logcat -s TalonShizuku
         */
        private const val TAG = "TalonShizuku"
    }

    private val pendingPermissions = mutableListOf<MethodChannel.Result>()

    /**
     * Set by Shizuku's sticky binder-received listener (fires immediately if
     * the binder is already here). Lets a probe distinguish "binder not here
     * *yet*" from "Shizuku genuinely absent" and wait accordingly.
     */
    @Volatile
    private var binderReceived = false

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
            // Deliver the binder to THIS process (harmless if the provider
            // already did) so a non-foreground process can reach Shizuku.
            ShizukuProvider.requestBinderForNonProviderProcess(context)
        } catch (t: Throwable) {
            // Shizuku provider not present — no-op.
            Log.d(TAG, "requestBinderForNonProviderProcess failed: ${t.message}")
        }
        try {
            Shizuku.addBinderReceivedListenerSticky {
                binderReceived = true
                Log.i(TAG, "Shizuku binder received (uid=${shizukuUid()})")
            }
            Shizuku.addBinderDeadListener {
                binderReceived = false
                Log.w(TAG, "Shizuku binder died")
            }
            Shizuku.addRequestPermissionResultListener(permissionListener)
            Log.i(TAG, "ShizukuBridge initialised; listeners registered")
        } catch (t: Throwable) {
            // Shizuku not present — listener registration is a no-op path.
            Log.d(TAG, "Shizuku listener registration failed: ${t.message}")
        }
    }

    /** Best-effort Shizuku server UID for logs (2000=adb/shell, 0=root). */
    private fun shizukuUid(): Int =
        try {
            Shizuku.getUid()
        } catch (_: Throwable) {
            -1
        }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getStatus" -> status(result)
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

    /**
     * Block up to [timeoutMs] for the Shizuku binder to arrive in this process.
     * MUST be called off the platform (UI) thread. Returns as soon as the
     * binder is alive; returns false if it never arrives in the window (Shizuku
     * genuinely absent / not running).
     */
    private fun awaitBinder(timeoutMs: Long): Boolean {
        if (binderAlive()) return true
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (binderAlive()) return true
            try {
                Thread.sleep(50)
            } catch (_: InterruptedException) {
                break
            }
        }
        val alive = binderAlive()
        if (!alive) {
            Log.w(
                TAG,
                "Shizuku binder not available after ${timeoutMs}ms " +
                    "(received=$binderReceived) — is Shizuku running?",
            )
        }
        return alive
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

    private fun status(result: MethodChannel.Result) {
        Thread {
            // Wait briefly for the binder handover so a status probe issued
            // right before an exec (Dart's ensureShizukuReady) doesn't report
            // "not-running" during the race and force an app-UID downgrade.
            val binderAlive = awaitBinder(BINDER_WAIT_MS)
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
            Log.i(TAG, "getStatus -> ready=$granted state=$state uid=${shizukuUid()}")
            replySuccess(result, mapOf("ready" to granted, "state" to state))
        }.start()
    }

    private fun requestPermission(result: MethodChannel.Result) {
        // Wait for the binder off the platform thread, then run the (binder-
        // dependent) permission logic back on the main thread so the
        // pendingPermissions list and the permission dialog stay single-
        // threaded, matching the result listener.
        Thread {
            val alive = awaitBinder(BINDER_WAIT_MS)
            mainHandler.post {
                try {
                    if (!alive) {
                        result.success(false)
                        return@post
                    }
                    if (hasPermission()) {
                        result.success(true)
                        return@post
                    }
                    if (Shizuku.shouldShowRequestPermissionRationale()) {
                        result.success(false)
                        return@post
                    }
                    // Several mesh requests can land together. Keep every caller
                    // attached to the same Android permission prompt.
                    if (pendingPermissions.isNotEmpty()) {
                        pendingPermissions.add(result)
                        return@post
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
        }.start()
    }

    private fun cancelPermissionRequest(result: MethodChannel.Result) {
        val pending = pendingPermissions.toList()
        pendingPermissions.clear()
        pending.forEach { replySuccess(it, false) }
        result.success(null)
    }

    private fun exec(call: MethodCall, result: MethodChannel.Result) {
        val cmd = call.argument<String>("cmd") ?: ""
        val cwd = call.argument<String>("cwd")
        val timeoutMs = (call.argument<Number>("timeoutMs")?.toLong()) ?: 60_000L
        Thread {
            // Await the binder here (off the platform thread) rather than
            // gating on a synchronous isReady() up front: the command may have
            // arrived before the provider handed this process the binder.
            val binderOk = awaitBinder(BINDER_WAIT_MS)
            val permOk = binderOk && hasPermission()
            if (!binderOk || !permOk) {
                Log.w(
                    TAG,
                    "exec refused: binder=$binderOk permission=$permOk — " +
                        "falling back to app UID for: ${cmd.take(120)}",
                )
                replyError(
                    result,
                    "shizuku_unavailable",
                    "Shizuku not ready (binder=$binderOk permission=$permOk)",
                )
                return@Thread
            }
            try {
                val args = arrayOf("sh", "-c", cmd)
                // `Shizuku.newProcess` is a hidden, @Deprecated API (slated for
                // removal in Shizuku API 14) whose exact declared signature has
                // drifted across releases. Pinning one signature via
                // getDeclaredMethod(name, String[], String[], String) throws
                // NoSuchMethodException the moment the bundled Shizuku differs —
                // and because exec swallows the throw into an app-UID fallback,
                // that surfaces as "Shizuku is authorized but never actually
                // used". Locate it by name/arity among the declared methods
                // instead, so a param/return-type change no longer silently
                // disables elevated exec.
                val newProcess = Shizuku::class.java.declaredMethods
                    .firstOrNull { m ->
                        m.name == "newProcess" &&
                            m.parameterTypes.size == 3 &&
                            m.parameterTypes[0] == Array<String>::class.java
                    }
                    ?: throw NoSuchMethodException(
                        "Shizuku.newProcess is unavailable in the bundled " +
                            "Shizuku API — elevated exec needs the UserService " +
                            "path (Shizuku.newProcess is removed as of API 14).",
                    )
                newProcess.isAccessible = true
                val process = newProcess.invoke(null, args, null, cwd) as Process
                Log.i(TAG, "exec via Shizuku (uid=${shizukuUid()}): ${cmd.take(120)}")

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
                Log.i(TAG, "exec via Shizuku done: exit=$exit finished=$finished")
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
                // Full stack trace to logcat: this is the exact failure we were
                // blind to before (e.g. newProcess signature/removal, binder
                // transaction error). The Dart side still degrades to app UID.
                Log.e(TAG, "exec via Shizuku FAILED for: ${cmd.take(120)}", t)
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
