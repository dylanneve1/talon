package org.talon.companion

import android.content.Intent
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var shizuku: ShizukuBridge? = null
    private var root: RootBridge? = null
    private var pair: PairBridge? = null
    private var voice: VoiceBridge? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val channel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            ShizukuBridge.CHANNEL,
        )
        // Registers itself as the channel handler; harmless when the Shizuku
        // app is not installed (all calls report not-ready). Uses the
        // application context so the Shizuku binder request isn't tied to this
        // activity's lifecycle (the mesh answers exec commands while the app is
        // backgrounded).
        shizuku = ShizukuBridge(channel, applicationContext)

        // Root tier (su / adb-root agent), the rung above Shizuku. Same
        // application-context reasoning: the su shell is process-wide and must
        // outlive this activity, since the mesh answers commands with the app
        // backgrounded.
        val rootChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            RootBridge.CHANNEL,
        )
        root = RootBridge(rootChannel, applicationContext)

        // `talon://pair` deep links (the daemon's /mesh link). Created before
        // the intent is inspected below so a cold start's link is held for
        // Dart, which only asks for it once the UI is up.
        pair = PairBridge(
            MethodChannel(
                flutterEngine.dartExecutor.binaryMessenger,
                PairBridge.CHANNEL,
            ),
        )
        if (isPairIntent(intent)) pair?.offer(intent.dataString)

        // Voice mode: STT/TTS + default-assistant plumbing. Activity-scoped
        // (unlike Shizuku) because it drives runtime-permission prompts and
        // settings intents, which need a real activity.
        val voiceChannel = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            VoiceBridge.CHANNEL,
        )
        voice = VoiceBridge(voiceChannel, this)
        // Cold-started straight from the assist gesture (long-press home /
        // corner swipe while we're the default assistant): flag it so Dart
        // opens voice mode once the UI is up. Not `warm` — the Dart side
        // isn't listening yet; it polls consumeAssistLaunch at startup.
        if (isAssistIntent(intent)) voice?.onAssistLaunch(warm = false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        // Already running and the assist gesture re-launched us (singleTop):
        // push the event so the live UI jumps into voice mode immediately.
        if (isAssistIntent(intent)) voice?.onAssistLaunch(warm = true)
        if (isPairIntent(intent)) pair?.offer(intent.dataString)
    }

    private fun isPairIntent(intent: Intent?): Boolean =
        intent?.action == Intent.ACTION_VIEW &&
            intent.data?.scheme.equals("talon", ignoreCase = true)

    private fun isAssistIntent(intent: Intent?): Boolean =
        intent?.action == Intent.ACTION_ASSIST ||
            intent?.action == Intent.ACTION_VOICE_COMMAND

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        // Give the voice bridge first refusal (RECORD_AUDIO); everything else
        // flows to the Flutter plugin registry as before.
        if (voice?.onRequestPermissionsResult(requestCode, grantResults) == true) {
            return
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onDestroy() {
        voice?.dispose()
        voice = null
        super.onDestroy()
    }
}
