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
        // app is not installed (all calls report not-ready).
        shizuku = ShizukuBridge(channel)
    }
}
