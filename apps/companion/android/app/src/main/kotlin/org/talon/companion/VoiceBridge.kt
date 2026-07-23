package org.talon.companion

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Native half of the companion's voice mode: on-device speech-to-text
 * (android.speech.SpeechRecognizer), text-to-speech (android.speech.tts),
 * the RECORD_AUDIO runtime permission, and the "default digital assistant"
 * role plumbing (detection + a jump into system settings + assist-gesture
 * launches).
 *
 * Hand-rolled over the pub plugins (speech_to_text / flutter_tts) on purpose:
 * this app only ships voice on Android, the two platform APIs are small, and
 * owning the channel means no third-party AGP/embedding drift in the build —
 * the same reasoning as ShizukuBridge.
 *
 * Dart ↔ native protocol (channel `talon/voice`):
 *   Dart → native: isSttAvailable, hasMicPermission, requestMicPermission,
 *     startListening, stopListening, cancelListening,
 *     speak{text,id,rate,flush}, stopSpeaking,
 *     isDefaultAssistant, openAssistantSettings, consumeAssistLaunch
 *   native → Dart (invokeMethod, fire-and-forget):
 *     stt.partial{text}, stt.final{text}, stt.rms{level}, stt.end,
 *     stt.error{code,message}, tts.start{id}, tts.done{id}, tts.error{id},
 *     assist.launch
 */
class VoiceBridge(
    private val channel: MethodChannel,
    private val activity: Activity,
) {
    companion object {
        const val CHANNEL = "talon/voice"
        private const val PERMISSION_REQUEST = 7431
    }

    private val context: Context get() = activity.applicationContext
    private val main = Handler(Looper.getMainLooper())

    private var recognizer: SpeechRecognizer? = null
    private var listening = false

    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val pendingTtsInit = mutableListOf<(Boolean) -> Unit>()

    private var pendingPermission: MethodChannel.Result? = null

    /// Set when the activity was (re)launched by the system assist gesture;
    /// cleared when Dart consumes it. The warm path additionally pushes an
    /// `assist.launch` event, so a running UI reacts immediately while a
    /// cold-started one still finds the flag when it boots.
    @Volatile private var assistPending = false

    /// Rate-limit for stt.rms events (onRmsChanged fires ~every 40ms and the
    /// UI only needs ~20fps of level data).
    private var lastRmsAt = 0L

    init {
        channel.setMethodCallHandler { call, result -> onCall(call, result) }
    }

    // ── Channel dispatch ────────────────────────────────────────────────────

    private fun onCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "isSttAvailable" ->
                    result.success(SpeechRecognizer.isRecognitionAvailable(context))
                "hasMicPermission" -> result.success(hasMicPermission())
                "requestMicPermission" -> requestMicPermission(result)
                "startListening" -> startListening(result)
                "stopListening" -> {
                    recognizer?.stopListening()
                    result.success(true)
                }
                "cancelListening" -> {
                    destroyRecognizer()
                    result.success(true)
                }
                "speak" -> speak(
                    call.argument<String>("text") ?: "",
                    call.argument<String>("id") ?: "utt",
                    (call.argument<Number>("rate") ?: 1.0).toFloat(),
                    call.argument<Boolean>("flush") ?: true,
                    result,
                )
                "stopSpeaking" -> {
                    tts?.stop()
                    result.success(true)
                }
                "isDefaultAssistant" -> result.success(isDefaultAssistant())
                "openAssistantSettings" -> result.success(openAssistantSettings())
                "consumeAssistLaunch" -> {
                    val was = assistPending
                    assistPending = false
                    result.success(was)
                }
                else -> result.notImplemented()
            }
        } catch (e: Exception) {
            result.error("voice_error", e.message, null)
        }
    }

    // ── Mic permission ──────────────────────────────────────────────────────

    private fun hasMicPermission(): Boolean =
        context.checkPermission(
            Manifest.permission.RECORD_AUDIO,
            android.os.Process.myPid(),
            android.os.Process.myUid(),
        ) == PackageManager.PERMISSION_GRANTED

    private fun requestMicPermission(result: MethodChannel.Result) {
        if (hasMicPermission()) {
            result.success(true)
            return
        }
        if (Build.VERSION.SDK_INT < 23) {
            // Pre-M permissions are install-time; not granted means never.
            result.success(false)
            return
        }
        // One in-flight request at a time; a duplicate resolves as denied
        // rather than leaking the earlier Result.
        pendingPermission?.success(false)
        pendingPermission = result
        activity.requestPermissions(
            arrayOf(Manifest.permission.RECORD_AUDIO),
            PERMISSION_REQUEST,
        )
    }

    /** Routed from MainActivity. Returns true when the callback was ours. */
    fun onRequestPermissionsResult(
        requestCode: Int,
        grantResults: IntArray,
    ): Boolean {
        if (requestCode != PERMISSION_REQUEST) return false
        pendingPermission?.success(
            grantResults.isNotEmpty() &&
                grantResults[0] == PackageManager.PERMISSION_GRANTED,
        )
        pendingPermission = null
        return true
    }

    // ── Speech to text ──────────────────────────────────────────────────────

    private fun startListening(result: MethodChannel.Result) {
        if (!SpeechRecognizer.isRecognitionAvailable(context)) {
            result.error("stt_unavailable", "No speech recognition service", null)
            return
        }
        if (!hasMicPermission()) {
            result.error("no_permission", "RECORD_AUDIO not granted", null)
            return
        }
        // A fresh recognizer per utterance: SpeechRecognizer instances get
        // wedged after some error paths (BUSY/CLIENT), and re-creating is the
        // reliable pattern.
        destroyRecognizer()
        val r = SpeechRecognizer.createSpeechRecognizer(context)
        r.setRecognitionListener(recognitionListener)
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(
                RecognizerIntent.EXTRA_LANGUAGE_MODEL,
                RecognizerIntent.LANGUAGE_MODEL_FREE_FORM,
            )
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
        }
        recognizer = r
        listening = true
        r.startListening(intent)
        result.success(true)
    }

    private fun destroyRecognizer() {
        listening = false
        recognizer?.let {
            try {
                it.cancel()
                it.destroy()
            } catch (_: Exception) {
                // Already dead — nothing to release.
            }
        }
        recognizer = null
    }

    private val recognitionListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() {}
        override fun onBufferReceived(buffer: ByteArray?) {}

        override fun onRmsChanged(rmsdB: Float) {
            val now = System.currentTimeMillis()
            if (now - lastRmsAt < 50) return
            lastRmsAt = now
            // Empirically SpeechRecognizer reports roughly -2..10 dB.
            val level = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
            emit("stt.rms", mapOf("level" to level.toDouble()))
        }

        override fun onEndOfSpeech() = emit("stt.end", null)

        override fun onPartialResults(partialResults: Bundle?) {
            val text = partialResults
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull() ?: return
            if (text.isNotBlank()) emit("stt.partial", mapOf("text" to text))
        }

        override fun onResults(results: Bundle?) {
            listening = false
            val text = results
                ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                ?.firstOrNull()
                .orEmpty()
            if (text.isBlank()) {
                // Recognizer finished with nothing usable — surface as the
                // standard no-match code so Dart's retry logic has one path.
                emit(
                    "stt.error",
                    mapOf(
                        "code" to SpeechRecognizer.ERROR_NO_MATCH,
                        "message" to "No speech recognized",
                    ),
                )
            } else {
                emit("stt.final", mapOf("text" to text))
            }
        }

        override fun onError(error: Int) {
            listening = false
            emit(
                "stt.error",
                mapOf("code" to error, "message" to sttErrorMessage(error)),
            )
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private fun sttErrorMessage(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_AUDIO -> "Audio recording error"
        SpeechRecognizer.ERROR_CLIENT -> "Client error"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "Missing permission"
        SpeechRecognizer.ERROR_NETWORK -> "Network error"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "Network timeout"
        SpeechRecognizer.ERROR_NO_MATCH -> "No speech recognized"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "Recognizer busy"
        SpeechRecognizer.ERROR_SERVER -> "Recognition server error"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "No speech heard"
        else -> "Speech recognition error $code"
    }

    // ── Text to speech ──────────────────────────────────────────────────────

    private fun ensureTts(onReady: (Boolean) -> Unit) {
        if (ttsReady) {
            onReady(true)
            return
        }
        pendingTtsInit.add(onReady)
        if (tts != null) return // init already in flight
        tts = TextToSpeech(context) { status ->
            main.post {
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    tts?.setOnUtteranceProgressListener(utteranceListener)
                }
                val waiting = pendingTtsInit.toList()
                pendingTtsInit.clear()
                for (cb in waiting) cb(ttsReady)
            }
        }
    }

    private val utteranceListener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) =
            emit("tts.start", mapOf("id" to (utteranceId ?: "")))

        override fun onDone(utteranceId: String?) =
            emit("tts.done", mapOf("id" to (utteranceId ?: "")))

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) =
            emit("tts.error", mapOf("id" to (utteranceId ?: "")))

        override fun onError(utteranceId: String?, errorCode: Int) =
            emit("tts.error", mapOf("id" to (utteranceId ?: "")))
    }

    private fun speak(
        text: String,
        id: String,
        rate: Float,
        flush: Boolean,
        result: MethodChannel.Result,
    ) {
        if (text.isBlank()) {
            result.success(false)
            return
        }
        ensureTts { ok ->
            if (!ok) {
                result.error("tts_unavailable", "Text-to-speech failed to initialize", null)
                return@ensureTts
            }
            val engine = tts ?: run {
                result.error("tts_unavailable", "Text-to-speech disposed", null)
                return@ensureTts
            }
            engine.setSpeechRate(rate.coerceIn(0.4f, 2.0f))
            val queued = engine.speak(
                text,
                if (flush) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD,
                null,
                id,
            )
            result.success(queued == TextToSpeech.SUCCESS)
        }
    }

    // ── Default-assistant role ──────────────────────────────────────────────

    /// Whether this app currently holds the system "digital assistant" role.
    /// Settings.Secure `assistant` stores the flattened ComponentName of the
    /// chosen assist component (or empty/none). Reading it needs no
    /// permission; only writing is privileged.
    private fun isDefaultAssistant(): Boolean {
        val flat = Settings.Secure.getString(context.contentResolver, "assistant")
        if (flat.isNullOrEmpty()) return false
        val cn = ComponentName.unflattenFromString(flat)
        return (cn?.packageName ?: flat) == context.packageName
    }

    /// The assistant role can't be requested via RoleManager dialogs — the
    /// user must pick it in system settings. Deep-link as close as the device
    /// allows: the voice-input picker, else default-apps, else settings root.
    private fun openAssistantSettings(): Boolean {
        val candidates = listOf(
            Intent(Settings.ACTION_VOICE_INPUT_SETTINGS),
            Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS),
            Intent(Settings.ACTION_SETTINGS),
        )
        for (intent in candidates) {
            if (intent.resolveActivity(context.packageManager) == null) continue
            return try {
                activity.startActivity(intent)
                true
            } catch (_: Exception) {
                continue
            }
        }
        return false
    }

    /** Called by MainActivity when an assist-gesture intent arrives. */
    fun onAssistLaunch(warm: Boolean) {
        assistPending = true
        if (warm) emit("assist.launch", null)
    }

    // ── Plumbing ────────────────────────────────────────────────────────────

    /// All native → Dart traffic goes through the main thread (TTS progress
    /// callbacks arrive on a binder thread; channel calls must not).
    private fun emit(method: String, args: Map<String, Any?>?) {
        main.post {
            try {
                channel.invokeMethod(method, args)
            } catch (_: Exception) {
                // Engine tearing down — drop the event.
            }
        }
    }

    fun dispose() {
        destroyRecognizer()
        tts?.stop()
        tts?.shutdown()
        tts = null
        ttsReady = false
        pendingTtsInit.clear()
        pendingPermission = null
        channel.setMethodCallHandler(null)
    }
}
