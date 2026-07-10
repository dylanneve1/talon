package org.talon.companion

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var shizuku: ShizukuBridge? = null

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
    }
}
