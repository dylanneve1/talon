package org.talon.companion

import android.util.Log
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Receives `talon://pair` links — the last hop of the daemon's `/mesh link`.
 *
 * The chain: `/mesh link` mints a single-use grant, the operator opens the
 * link on the phone, the bridge serves a page whose button is a
 * `talon://pair?u=…&t=…&f=…` deep link, and Android routes that back here.
 * The credentials ride in the link itself, so this side never has to redeem
 * anything over a network that may not be reachable yet.
 *
 * Deliberately a mailbox rather than a stream: a cold start delivers the
 * intent long before Dart is listening, so the URI is *held* until Dart asks
 * for it. `consume` hands it over exactly once — a link that reconfigured the
 * connection on every rebuild would fight whatever the user did afterwards.
 */
class PairBridge(channel: MethodChannel) : MethodChannel.MethodCallHandler {

    companion object {
        const val CHANNEL = "talon/pair"
        private const val TAG = "TalonPair"
    }

    @Volatile
    private var pending: String? = null

    init {
        channel.setMethodCallHandler(this)
    }

    /** Hold a link that just arrived (cold start or warm re-launch). */
    fun offer(uri: String?) {
        if (uri.isNullOrEmpty()) return
        pending = uri
        // The link carries a bearer token; log that one arrived, never what.
        Log.i(TAG, "pairing link received")
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "consume" -> {
                val link = pending
                pending = null
                result.success(link)
            }
            else -> result.notImplemented()
        }
    }
}
