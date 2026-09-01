package org.talon.companion

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.BufferedReader
import java.io.File
import java.io.FileFilter
import java.io.OutputStreamWriter
import java.util.UUID
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * MethodChannel bridge for the *root* execution tier — the rung above Shizuku
 * in [org.talon.companion] device control.
 *
 * Dart (`DeviceExec`) calls:
 *   - getStatus {probe} → the current privilege tier and everything needed to
 *                         explain/repair it (uid, su binary, agent liveness,
 *                         build type). `probe:true` may spawn `su`, which can
 *                         raise a Magisk-style grant dialog; `probe:false`
 *                         never does.
 *   - exec {cmd,cwd,timeoutMs} → run at uid 0, return {stdout,stderr,exitCode,via}
 *   - installAgent    → materialise the adb-root agent script, return the
 *                       one-liner the user runs over adb
 *   - stopAgent       → ask a running agent to exit
 *
 * Three ways this process can reach uid 0, tried in that order:
 *
 *  1. **Already root** — the process itself runs as uid 0 (a ROM that launches
 *     Talon from a root context). Plain `sh -c` is already root, no wrapper.
 *  2. **`su`** — Magisk / KernelSU / APatch, or any ROM whose `su` accepts an
 *     app uid. [RootShell] keeps ONE long-lived su shell for the whole
 *     process, so the user is prompted once and every later command is a
 *     write + read on an open pipe instead of a fresh grant round trip.
 *  3. **The adb-root agent** ([RootAgent]) — for a `userdebug` build where
 *     `adb root` works but `su` refuses app uids (AOSP's `su` only allows uid
 *     0 and uid 2000/shell, so a system app cannot use it either). The user
 *     starts a small shell agent once over root adb; it runs as uid 0 until
 *     reboot and takes commands through a spool directory inside Talon's own
 *     private storage — which only root and this app can reach.
 *
 * A fourth, non-root tier is *reported* but needs no wrapper: when the APK is
 * built into a ROM with `android:sharedUserId="android.uid.system"` and signed
 * with the platform key, the process is uid 1000 (`system`) and ordinary
 * `sh -c` already runs there. Being in `/system/priv-app` on its own does NOT
 * do this — see docs/companion-root.md.
 *
 * Every path degrades: nothing here throwing or missing changes the outcome
 * beyond "root unavailable", and Dart falls through to Shizuku and then to
 * app-uid execution.
 */
class RootBridge(
    channel: MethodChannel,
    private val context: Context,
) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/root"

        /**
         * Logcat tag for the whole root path. Release builds don't route
         * Dart's `developer.log` to logcat, so when elevation silently fails
         * this is the only trail. Diagnose with:
         *   adb logcat -s TalonRoot
         */
        internal const val TAG = "TalonRoot"

        /** uid of the Android `system` user — what a platform-signed build gets. */
        private const val SYSTEM_UID = 1000
    }

    private val agent = RootAgent(context)
    private val mainHandler = Handler(Looper.getMainLooper())

    init {
        channel.setMethodCallHandler(this)
    }

    private fun replySuccess(result: MethodChannel.Result, value: Any?) {
        mainHandler.post { result.success(value) }
    }

    private fun replyError(result: MethodChannel.Result, code: String, message: String?) {
        mainHandler.post { result.error(code, message, null) }
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "getStatus" -> {
                val probe = call.argument<Boolean>("probe") == true
                Thread { replySuccess(result, status(probe)) }.start()
            }
            "exec" -> exec(call, result)
            "installAgent" -> Thread {
                val ok = agent.install()
                replySuccess(
                    result,
                    mapOf(
                        "installed" to ok,
                        "script" to agent.script.absolutePath,
                        "command" to agent.adbCommand(),
                    ),
                )
            }.start()
            "stopAgent" -> Thread {
                agent.stop()
                replySuccess(result, null)
            }.start()
            else -> result.notImplemented()
        }
    }

    // ── status ────────────────────────────────────────────────────────────────

    /**
     * Snapshot of the privilege tier. Runs off the platform thread: [probe]
     * can spawn `su`, and even the cheap path stats the agent spool.
     */
    private fun status(probe: Boolean): Map<String, Any?> {
        val uid = android.os.Process.myUid()
        val agentAlive = agent.alive()
        val suUsable = when {
            uid == 0 -> false // already root; su is irrelevant
            probe -> RootShell.ensure()
            else -> RootShell.usable()
        }
        val method = when {
            uid == 0 -> "uid0"
            suUsable -> "su"
            agentAlive -> "agent"
            uid == SYSTEM_UID -> "system-uid"
            else -> "none"
        }
        val tier = when (method) {
            "uid0", "su", "agent" -> "root"
            "system-uid" -> "system"
            else -> "app"
        }
        val info = context.applicationInfo
        return mapOf(
            "tier" to tier,
            "method" to method,
            "state" to describe(method, agentAlive),
            "uid" to uid,
            "suDetected" to (RootShell.detectedSuPath() != null),
            "suPath" to RootShell.activeSuPath(),
            "suError" to RootShell.lastError,
            "agentAlive" to agentAlive,
            "agentScript" to agent.script.absolutePath,
            "agentCommand" to agent.adbCommand(),
            "buildType" to Build.TYPE,
            "debuggable" to isDebuggableBuild(),
            "systemApp" to ((info.flags and ApplicationInfo.FLAG_SYSTEM) != 0),
            "privilegedApp" to isPrivilegedApp(info),
        )
    }

    /** One human sentence for the settings row and for mesh status payloads. */
    private fun describe(method: String, agentAlive: Boolean): String = when (method) {
        "uid0" -> "root (process already runs as uid 0)"
        "su" -> "root via su (${RootShell.activeSuPath() ?: "su"})"
        "agent" -> "root via the adb agent"
        "system-uid" -> "system uid 1000 (platform-signed build)"
        else -> when {
            agentAlive -> "agent running but not answering"
            isDebuggableBuild() ->
                "no root yet — userdebug build: flash Magisk, or start the " +
                    "adb agent for this boot"
            else -> "no root — no usable su. Flash Magisk to make it permanent."
        }
    }

    /**
     * `ro.debuggable=1` — true on `userdebug`/`eng` builds. Read through
     * SystemProperties (hidden but stable and greylisted-max-target-o, so
     * still reachable) with a Build.TYPE fallback for when reflection is
     * blocked.
     */
    private fun isDebuggableBuild(): Boolean {
        val prop = try {
            val cls = Class.forName("android.os.SystemProperties")
            cls.getMethod("get", String::class.java, String::class.java)
                .invoke(null, "ro.debuggable", "0") as? String
        } catch (_: Throwable) {
            null
        }
        if (prop == "1") return true
        return Build.TYPE == "userdebug" || Build.TYPE == "eng"
    }

    /**
     * Whether the APK sits in `/system/priv-app` (privileged permissions).
     * `ApplicationInfo.isPrivilegedApp()` is hidden, so fall back to the
     * PRIVATE_FLAG_PRIVILEGED bit read reflectively.
     */
    private fun isPrivilegedApp(info: ApplicationInfo): Boolean {
        try {
            val m = info.javaClass.getMethod("isPrivilegedApp")
            return m.invoke(info) as Boolean
        } catch (_: Throwable) {
            // fall through
        }
        return try {
            val field = ApplicationInfo::class.java.getDeclaredField("privateFlags")
            field.isAccessible = true
            val flags = field.getInt(info)
            (flags and (1 shl 3)) != 0 // PRIVATE_FLAG_PRIVILEGED
        } catch (_: Throwable) {
            false
        }
    }

    // ── exec ──────────────────────────────────────────────────────────────────

    private fun exec(call: MethodCall, result: MethodChannel.Result) {
        val cmd = call.argument<String>("cmd") ?: ""
        val cwd = call.argument<String>("cwd")
        val timeoutMs = (call.argument<Number>("timeoutMs")?.toLong()) ?: 60_000L
        Thread {
            val uid = android.os.Process.myUid()
            // Already uid 0: the ordinary shell IS the root shell. Going
            // through su here would be a pointless (and on some ROMs failing)
            // round trip.
            if (uid == 0) {
                val res = RootShell.execDirect(cmd, cwd, timeoutMs)
                if (res != null) {
                    replySuccess(result, res.toMap("uid0"))
                    return@Thread
                }
            }
            if (uid != 0 && RootShell.ensure()) {
                val res = RootShell.exec(cmd, cwd, timeoutMs)
                if (res != null) {
                    replySuccess(result, res.toMap("su"))
                    return@Thread
                }
                Log.w(TAG, "su shell failed for: ${cmd.take(120)} — trying the agent")
            }
            if (agent.alive()) {
                val res = agent.exec(cmd, cwd, timeoutMs)
                if (res != null) {
                    replySuccess(result, res.toMap("agent"))
                    return@Thread
                }
                Log.w(TAG, "root agent failed for: ${cmd.take(120)}")
            }
            replyError(
                result,
                "root_unavailable",
                "No root path available (uid=$uid, su=${RootShell.usable()}, " +
                    "agent=${agent.alive()}, suError=${RootShell.lastError})",
            )
        }.start()
    }
}

/** stdout/stderr/exit of one elevated command. */
internal data class ShellResult(val stdout: String, val stderr: String, val exitCode: Int) {
    fun toMap(via: String): Map<String, Any?> = mapOf(
        "stdout" to stdout,
        "stderr" to stderr,
        "exitCode" to exitCode,
        "via" to via,
    )
}

/**
 * One process-wide `su` shell, kept open.
 *
 * Process-wide (an `object`, not a per-bridge field) because the activity
 * engine and the foreground-service engine each construct their own
 * [RootBridge] inside the SAME OS process: a shell per bridge would mean two
 * grant prompts and two root shells for one app.
 *
 * Long-lived rather than `su -c <cmd>` per command for three reasons: the root
 * manager prompts once instead of per command, each later command costs a pipe
 * write instead of a process spawn plus policy check, and a failed/denied
 * grant is remembered so the next mesh command doesn't re-prompt in a loop.
 */
internal object RootShell {
    /** Sentinel pushed by a reader thread when its stream hits EOF. */
    private const val EOF = " __TALON_EOF__"

    /**
     * How long a dead-end `su` probe is remembered before we try again. Without
     * this, every mesh exec on a stock phone would spawn (and fail) the whole
     * candidate list — the common case, since most devices have no root at all.
     */
    private const val FAILURE_TTL_MS = 60_000L

    /**
     * Candidate `su` binaries. Bare "su" first so PATH resolution finds the
     * root manager's own shim (Magisk relocates its binary and hides the path
     * from app-visible stats). `--mount-master` is tried first per candidate so
     * a Magisk shell sees the global mount namespace — otherwise `/sdcard` and
     * other per-app mounts differ from what the daemon expects.
     */
    private val CANDIDATES = listOf(
        "su",
        "/system/bin/su",
        "/system/xbin/su",
        "/sbin/su",
        "/debug_ramdisk/su",
        "/su/bin/su",
        "/magisk/.core/bin/su",
    )

    private val lock = Any()
    private var proc: Process? = null
    private var stdin: OutputStreamWriter? = null
    private val outQ = LinkedBlockingQueue<String>()
    private val errQ = LinkedBlockingQueue<String>()
    private var failedAt = 0L

    @Volatile
    var lastError: String? = null
        private set

    @Volatile
    private var suPath: String? = null

    fun activeSuPath(): String? = suPath

    /** A `su` binary we can see without executing anything. Best-effort: a
     *  hidden Magisk install reports null here yet still works when run. */
    fun detectedSuPath(): String? =
        CANDIDATES.firstOrNull { it.startsWith("/") && File(it).exists() }

    /** True when a root shell is open right now — never spawns or prompts. */
    fun usable(): Boolean = synchronized(lock) { isLive() }

    private fun isLive(): Boolean {
        val p = proc ?: return false
        return try {
            p.exitValue()
            false
        } catch (_: IllegalThreadStateException) {
            true
        }
    }

    /** Open a root shell if there isn't one. May prompt the root manager. */
    fun ensure(): Boolean = synchronized(lock) {
        if (isLive()) return true
        close()
        if (System.currentTimeMillis() - failedAt < FAILURE_TTL_MS) return false
        for (path in CANDIDATES) {
            if (tryOpen(arrayOf(path, "--mount-master"))) return true
            if (tryOpen(arrayOf(path))) return true
        }
        failedAt = System.currentTimeMillis()
        Log.i(RootBridge.TAG, "no usable su (last error: $lastError)")
        return false
    }

    private fun tryOpen(args: Array<String>): Boolean {
        val p = try {
            ProcessBuilder(*args).redirectErrorStream(false).start()
        } catch (t: Throwable) {
            lastError = "${args.first()}: ${t.message}"
            return false
        }
        proc = p
        stdin = OutputStreamWriter(p.outputStream)
        outQ.clear()
        errQ.clear()
        drain(p.inputStream.bufferedReader(), outQ)
        drain(p.errorStream.bufferedReader(), errQ)
        // Prove it: a shell that opened but didn't elevate (a denied grant
        // that still exec'd a normal shell) must not be mistaken for root.
        val probe = execLocked("id -u", null, 10_000L)
        if (probe != null && probe.stdout.trim() == "0") {
            suPath = args.first()
            lastError = null
            Log.i(RootBridge.TAG, "root shell open via ${args.joinToString(" ")}")
            return true
        }
        lastError = "${args.joinToString(" ")} did not yield uid 0" +
            (probe?.stderr?.trim()?.takeIf { it.isNotEmpty() }?.let { ": $it" } ?: "")
        close()
        return false
    }

    private fun drain(reader: BufferedReader, queue: LinkedBlockingQueue<String>) {
        Thread {
            try {
                while (true) {
                    val line = reader.readLine() ?: break
                    queue.put(line)
                }
            } catch (_: Throwable) {
                // Stream closed under us — the EOF sentinel below unblocks any
                // command still waiting on it.
            }
            queue.put(EOF)
        }.apply { isDaemon = true }.start()
    }

    private fun close() {
        try {
            stdin?.close()
        } catch (_: Throwable) {
        }
        try {
            proc?.destroy()
        } catch (_: Throwable) {
        }
        stdin = null
        proc = null
    }

    fun exec(cmd: String, cwd: String?, timeoutMs: Long): ShellResult? = synchronized(lock) {
        if (!isLive()) return null
        execLocked(cmd, cwd, timeoutMs)
    }

    /**
     * Run [cmd] in the open shell and read back its output.
     *
     * The shell is a single long-lived pipe shared by every command, so a
     * command's end has to be *in band*: a random marker is echoed on both
     * streams after the command, carrying the exit status on stdout. Both
     * streams are marked because stderr has no other end-of-command signal and
     * would otherwise leak into the next command's output.
     *
     * The command runs as `sh -c` inside a group with stdin closed, so a
     * program that reads stdin (`read`, an interactive prompt) can't eat the
     * protocol out of the pipe and desynchronise every later command.
     */
    private fun execLocked(cmd: String, cwd: String?, timeoutMs: Long): ShellResult? {
        val w = stdin ?: return null
        val mark = "__TALON_" + UUID.randomUUID().toString().replace("-", "") + "__"
        outQ.clear()
        errQ.clear()
        val script = buildString {
            append("{ ")
            if (!cwd.isNullOrEmpty()) append("cd ").append(shQuote(cwd)).append(" 2>/dev/null; ")
            append("sh -c ").append(shQuote(cmd))
            append("; } </dev/null\n")
            append("__talon_rc=$?\n")
            append("echo \"$mark\$__talon_rc\"\n")
            append("echo \"$mark\" 1>&2\n")
        }
        try {
            w.write(script)
            w.flush()
        } catch (t: Throwable) {
            lastError = "write to root shell failed: ${t.message}"
            close()
            return null
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        val out = StringBuilder()
        val exit = collect(outQ, mark, out, deadline) ?: run {
            // Timed out or the shell died mid-command: its pipe state is now
            // unknown (a half-read marker would corrupt the NEXT command), so
            // the shell is torn down rather than reused.
            close()
            return null
        }
        val err = StringBuilder()
        collect(errQ, mark, err, deadline)
        return ShellResult(out.toString(), err.toString(), exit.trim().toIntOrNull() ?: -1)
    }

    /**
     * Drain [queue] into [sink] until the marker. Returns whatever followed the
     * marker on that line (the exit code, for stdout), or null if the stream
     * ended or the deadline passed first.
     *
     * The marker is searched for anywhere in the line, not just at its start:
     * a command whose output has no trailing newline (`printf abc`) leaves the
     * marker echo appended to that same line.
     */
    private fun collect(
        queue: LinkedBlockingQueue<String>,
        mark: String,
        sink: StringBuilder,
        deadline: Long,
    ): String? {
        while (true) {
            val wait = deadline - System.currentTimeMillis()
            if (wait <= 0) return null
            val line = queue.poll(wait, TimeUnit.MILLISECONDS) ?: return null
            if (line === EOF) return null
            val at = line.indexOf(mark)
            if (at < 0) {
                sink.append(line).append('\n')
                continue
            }
            if (at > 0) sink.append(line, 0, at)
            return line.substring(at + mark.length)
        }
    }

    /**
     * Run a command in a plain shell — used only when the process is ALREADY
     * uid 0, where `sh -c` needs no elevation wrapper.
     */
    fun execDirect(cmd: String, cwd: String?, timeoutMs: Long): ShellResult? {
        return try {
            val pb = ProcessBuilder("sh", "-c", cmd)
            if (!cwd.isNullOrEmpty()) {
                val dir = File(cwd)
                if (dir.isDirectory) pb.directory(dir)
            }
            val p = pb.start()
            val out = StringBuilder()
            val err = StringBuilder()
            val to = Thread { p.inputStream.bufferedReader().copyInto(out) }
            val te = Thread { p.errorStream.bufferedReader().copyInto(err) }
            to.start()
            te.start()
            // Not Process.waitFor(long, TimeUnit): that overload is API 26+,
            // and desugaring doesn't cover java.lang.Process. A waiter thread
            // bounded by join() works on every level we ship to.
            val waiter = Thread {
                try {
                    p.waitFor()
                } catch (_: InterruptedException) {
                }
            }
            waiter.start()
            waiter.join(timeoutMs)
            val finished = !waiter.isAlive
            to.join(1_000)
            te.join(1_000)
            if (!finished) {
                p.destroy()
                ShellResult(out.toString(), err.toString() + "\n[killed: timeout]", -1)
            } else {
                ShellResult(out.toString(), err.toString(), p.exitValue())
            }
        } catch (t: Throwable) {
            lastError = "direct exec failed: ${t.message}"
            null
        }
    }

    /** POSIX single-quote for safe interpolation into a shell command. */
    fun shQuote(s: String): String = "'" + s.replace("'", "'\\''") + "'"
}

private fun BufferedReader.copyInto(sb: StringBuilder) {
    use { reader ->
        val buf = CharArray(4096)
        while (true) {
            val n = reader.read(buf)
            if (n < 0) break
            sb.append(buf, 0, n)
        }
    }
}

/**
 * The adb-root agent: root on a `userdebug` device that has no `su` an app may
 * use.
 *
 * The gap it fills: on a userdebug build `adb root` restarts adbd as uid 0, so
 * *the developer* has root — but the app still doesn't. AOSP's `su` refuses
 * every uid except 0 and 2000/shell, so neither an ordinary app nor a
 * system-uid app can call it. Something started from outside has to hold the
 * privilege and hand it over.
 *
 * That something is a ~20-line shell loop the user starts once over root adb.
 * It runs as uid 0 until reboot and polls a spool directory for work:
 *
 *   files/rootd/agent.sh   the loop itself, written by [install]
 *   files/rootd/alive      touched every tick — the liveness heartbeat
 *   files/rootd/q/<id>.cmd a request (renamed into place, never written there)
 *   files/rootd/q/<id>.{out,err,code,done}  the reply
 *
 * The spool lives in Talon's private storage, which is the access control: on
 * a stock Android only uid 0 and this app can enter that directory, so no
 * other app can queue work for a root shell. The agent chmods its replies so
 * the app can read files that root created.
 *
 * A request is written to `<id>.tmp` and *renamed* to `<id>.cmd` because rename
 * is atomic — a plain write would let the agent pick up a half-written command.
 */
internal class RootAgent(private val context: Context) {

    val dir: File get() = File(context.filesDir, "rootd")
    val script: File get() = File(dir, "agent.sh")
    private val queue: File get() = File(dir, "q")
    private val heartbeat: File get() = File(dir, "alive")

    /** Heartbeat older than this and the agent is treated as gone. */
    private val staleMs = 15_000L

    /** How often the reply spool is checked while a command is in flight. */
    private val pollMs = 25L

    fun alive(): Boolean {
        val hb = heartbeat
        return hb.exists() && System.currentTimeMillis() - hb.lastModified() < staleMs
    }

    /** Write (or refresh) the agent script. Idempotent. */
    fun install(): Boolean = try {
        dir.mkdirs()
        queue.mkdirs()
        if (!script.exists() || script.readText() != SCRIPT) script.writeText(SCRIPT)
        // World-readable so the root adb shell can read it out of app storage
        // without first having to chase SELinux labels.
        script.setReadable(true, false)
        dir.setExecutable(true, false)
        true
    } catch (t: Throwable) {
        Log.w(RootBridge.TAG, "agent install failed", t)
        false
    }

    /** The one-liner a user runs to start the agent. */
    fun adbCommand(): String =
        "adb root && adb shell \"setsid sh ${script.absolutePath} " +
            ">/dev/null 2>&1 </dev/null &\""

    fun stop() {
        try {
            File(dir, "stop").writeText("1")
        } catch (_: Throwable) {
        }
    }

    fun exec(cmd: String, cwd: String?, timeoutMs: Long): ShellResult? {
        if (!install()) return null
        val id = "t${System.currentTimeMillis()}-${UUID.randomUUID().toString().take(8)}"
        val tmp = File(queue, "$id.tmp")
        val req = File(queue, "$id.cmd")
        val done = File(queue, "$id.done")
        try {
            if (!cwd.isNullOrEmpty()) File(queue, "$id.cwd").writeText(cwd)
            // Trailing newline: the agent runs this file with `sh <file>`, and
            // a last line without one is a needless portability gamble.
            tmp.writeText(if (cmd.endsWith("\n")) cmd else "$cmd\n")
            if (!tmp.renameTo(req)) return null
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                if (done.exists()) {
                    return ShellResult(
                        File(queue, "$id.out").readTextOrEmpty(),
                        File(queue, "$id.err").readTextOrEmpty(),
                        File(queue, "$id.code").readTextOrEmpty().trim().toIntOrNull() ?: -1,
                    )
                }
                // The agent may have died between the liveness check and now;
                // don't burn the caller's whole timeout waiting on a corpse.
                if (!alive()) return null
                Thread.sleep(pollMs)
            }
            Log.w(RootBridge.TAG, "agent command timed out: ${cmd.take(120)}")
            return null
        } catch (t: Throwable) {
            Log.w(RootBridge.TAG, "agent command failed", t)
            return null
        } finally {
            // Explicit FileFilter: File.listFiles is overloaded for both
            // FileFilter and FilenameFilter, and a bare lambda leaves the
            // conversion to overload resolution.
            queue.listFiles(FileFilter { f -> f.name.startsWith("$id.") })
                ?.forEach { it.delete() }
        }
    }

    private fun File.readTextOrEmpty(): String = try {
        if (exists()) readText() else ""
    } catch (_: Throwable) {
        ""
    }

    private companion object {
        /**
         * Deliberately plain `/system/bin/sh` (mksh) + toybox: this has to run
         * on a bare AOSP userdebug image with nothing installed.
         *
         * The command runs in a subshell so a `cd` inside it can't leak into
         * the next request, and with stdin closed so an interactive program
         * can't stall the loop forever. Replies are chmod 666 because root
         * creates them inside the app's directory, where the app would
         * otherwise not be able to read its own results.
         */
        val SCRIPT = """
            #!/system/bin/sh
            # Talon root agent — started once over `adb root` on a userdebug
            # device; serves elevated commands to the Talon companion until
            # reboot. See docs/companion-root.md.
            case "${'$'}0" in */*) DIR=${'$'}{0%/*};; *) DIR=.;; esac
            Q="${'$'}DIR/q"
            mkdir -p "${'$'}Q"
            echo ${'$'}${'$'} > "${'$'}DIR/pid"; chmod 0666 "${'$'}DIR/pid" 2>/dev/null
            ticks=0
            while :; do
              if [ -f "${'$'}DIR/stop" ]; then
                rm -f "${'$'}DIR/stop" "${'$'}DIR/alive" "${'$'}DIR/pid"
                exit 0
              fi
              : > "${'$'}DIR/alive"; chmod 0666 "${'$'}DIR/alive" 2>/dev/null
              for req in "${'$'}Q"/*.cmd; do
                [ -f "${'$'}req" ] || continue
                id=${'$'}{req%.cmd}
                [ -f "${'$'}id.done" ] && continue
                cwd=""
                [ -f "${'$'}id.cwd" ] && cwd=${'$'}(cat "${'$'}id.cwd")
                (
                  [ -n "${'$'}cwd" ] && cd "${'$'}cwd" 2>/dev/null
                  sh "${'$'}req"
                ) > "${'$'}id.out" 2> "${'$'}id.err" < /dev/null
                echo ${'$'}? > "${'$'}id.code"
                chmod 0666 "${'$'}id.out" "${'$'}id.err" "${'$'}id.code" 2>/dev/null
                : > "${'$'}id.done"; chmod 0666 "${'$'}id.done" 2>/dev/null
              done
              # A command the app gave up on leaves its spool files behind
              # (the app cleans up only what it waited for). Sweep anything
              # older than 10 minutes, roughly once a minute.
              ticks=${'$'}((ticks + 1))
              if [ ${'$'}((ticks % 600)) -eq 0 ]; then
                find "${'$'}Q" -type f -mmin +10 -delete 2>/dev/null
              fi
              sleep 0.1
            done
        """.trimIndent() + "\n"
    }
}
