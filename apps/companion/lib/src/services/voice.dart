import 'dart:async';

import 'package:flutter/foundation.dart'
    show defaultTargetPlatform, kIsWeb, TargetPlatform;
import 'package:flutter/services.dart';

import 'log.dart';

/// A speech-to-text error surfaced by the native recognizer.
class SttError {
  final int code;
  final String message;
  const SttError(this.code, this.message);

  /// Codes that just mean "nothing was heard" — routine in a hands-free loop
  /// (the user paused too long), not a real failure.
  /// 6 = ERROR_SPEECH_TIMEOUT, 7 = ERROR_NO_MATCH.
  bool get benign => code == 6 || code == 7;

  @override
  String toString() => 'SttError($code, $message)';
}

/// Dart half of the `talon/voice` platform channel (see VoiceBridge.kt):
/// on-device speech recognition, speech synthesis, mic permission, and the
/// Android "default digital assistant" role.
///
/// Voice ships on Android only — [supported] gates every UI entry point, and
/// every method degrades safely (returns false / no-ops) elsewhere, so
/// callers never need their own platform checks.
class VoiceService {
  VoiceService._() {
    if (supported) _channel.setMethodCallHandler(_onCall);
  }

  static final VoiceService instance = VoiceService._();

  static const _channel = MethodChannel('talon/voice');

  /// Whether this build can have voice at all (the native bridge only exists
  /// in the Android embedding).
  static bool get supported =>
      !kIsWeb && defaultTargetPlatform == TargetPlatform.android;

  // ── Event streams (native → Dart) ─────────────────────────────────────────

  final _partial = StreamController<String>.broadcast();
  final _finals = StreamController<String>.broadcast();
  final _rms = StreamController<double>.broadcast();
  final _sttErrors = StreamController<SttError>.broadcast();
  final _sttEnd = StreamController<void>.broadcast();
  final _ttsStart = StreamController<String>.broadcast();
  final _ttsDone = StreamController<String>.broadcast();
  final _ttsError = StreamController<String>.broadcast();
  final _assist = StreamController<void>.broadcast();

  /// Live partial transcript while the user is talking.
  Stream<String> get onPartial => _partial.stream;

  /// The final recognized utterance.
  Stream<String> get onFinal => _finals.stream;

  /// Mic input level, 0..1 — drives the orb's pulse.
  Stream<double> get onRms => _rms.stream;

  /// Recognition failures (including the benign no-speech codes).
  Stream<SttError> get onSttError => _sttErrors.stream;

  /// The recognizer detected end-of-speech (results follow shortly).
  Stream<void> get onSttEnd => _sttEnd.stream;

  Stream<String> get onTtsStart => _ttsStart.stream;
  Stream<String> get onTtsDone => _ttsDone.stream;
  Stream<String> get onTtsError => _ttsError.stream;

  /// The system assist gesture launched us while the app was running.
  Stream<void> get onAssistLaunch => _assist.stream;

  Future<dynamic> _onCall(MethodCall call) async {
    final args = call.arguments;
    String argText() => args is Map ? (args['text'] as String? ?? '') : '';
    String argId() => args is Map ? (args['id'] as String? ?? '') : '';
    switch (call.method) {
      case 'stt.partial':
        _partial.add(argText());
      case 'stt.final':
        _finals.add(argText());
      case 'stt.rms':
        final level = args is Map ? args['level'] : null;
        if (level is num) _rms.add(level.toDouble().clamp(0.0, 1.0));
      case 'stt.end':
        _sttEnd.add(null);
      case 'stt.error':
        final code = args is Map && args['code'] is num
            ? (args['code'] as num).toInt()
            : -1;
        final message = args is Map
            ? (args['message'] as String? ?? 'Speech error')
            : 'Speech error';
        _sttErrors.add(SttError(code, message));
      case 'tts.start':
        _ttsStart.add(argId());
      case 'tts.done':
        _ttsDone.add(argId());
      case 'tts.error':
        _ttsError.add(argId());
      case 'assist.launch':
        _assist.add(null);
    }
    return null;
  }

  // ── Commands (Dart → native) ──────────────────────────────────────────────

  Future<T> _invoke<T>(String method, T fallback, [dynamic args]) async {
    if (!supported) return fallback;
    try {
      final r = await _channel.invokeMethod<T>(method, args);
      return r ?? fallback;
    } on MissingPluginException {
      return fallback;
    } on PlatformException catch (e) {
      AppLog.warn('voice', '$method failed: ${e.code}', e.message);
      return fallback;
    }
  }

  /// Whether an on-device recognition service exists (mic permission aside).
  Future<bool> isSttAvailable() => _invoke('isSttAvailable', false);

  Future<bool> hasMicPermission() => _invoke('hasMicPermission', false);

  /// Prompts if needed; resolves with the final grant state.
  Future<bool> requestMicPermission() => _invoke('requestMicPermission', false);

  /// Begin a listening session. Events arrive on [onPartial] / [onFinal] /
  /// [onRms]; the session ends with exactly one final or error.
  Future<bool> startListening() => _invoke('startListening', false);

  /// Stop capturing and force the recognizer to conclude with what it heard.
  Future<void> stopListening() => _invoke<bool>('stopListening', false);

  /// Abort listening, discarding any pending result.
  Future<void> cancelListening() => _invoke<bool>('cancelListening', false);

  /// Speak [text]. Completion arrives on [onTtsDone]/[onTtsError] with [id].
  Future<bool> speak(
    String text, {
    required String id,
    double rate = 1.0,
    bool flush = true,
  }) =>
      _invoke('speak', false, {
        'text': text,
        'id': id,
        'rate': rate,
        'flush': flush,
      });

  Future<void> stopSpeaking() => _invoke<bool>('stopSpeaking', false);

  // ── Default-assistant role ────────────────────────────────────────────────

  Future<bool> isDefaultAssistant() => _invoke('isDefaultAssistant', false);

  /// Opens the closest system-settings screen where the user can pick Talon
  /// as the digital assistant (the role can't be granted programmatically).
  Future<bool> openAssistantSettings() =>
      _invoke('openAssistantSettings', false);

  /// True when the app was launched by the assist gesture and voice mode
  /// should open. Clears the flag (one launch → one open).
  Future<bool> consumeAssistLaunch() => _invoke('consumeAssistLaunch', false);
}

/// Convert assistant markdown into something that sounds natural when read
/// aloud: code blocks are summarized, link syntax collapses to its label,
/// URLs and formatting glyphs disappear.
String speechify(String markdown) {
  var s = markdown;
  // Fenced code blocks → a spoken placeholder (reading code aloud is noise).
  s = s.replaceAll(RegExp(r'```[\s\S]*?```'), ' Code block omitted. ');
  // Inline code keeps its content, loses the backticks.
  s = s.replaceAllMapped(RegExp(r'`([^`]*)`'), (m) => m[1] ?? '');
  // Images vanish; links keep their label.
  s = s.replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '');
  s = s.replaceAllMapped(RegExp(r'\[([^\]]+)\]\([^)]*\)'), (m) => m[1] ?? '');
  // Bare URLs → "link".
  s = s.replaceAll(RegExp(r'https?://\S+'), 'link');
  // Headings / quotes / list bullets / emphasis / tables — drop the syntax.
  s = s.replaceAll(RegExp(r'^#{1,6}\s*', multiLine: true), '');
  s = s.replaceAll(RegExp(r'^>\s?', multiLine: true), '');
  // ([ \t]*, not \s*: \s would swallow the preceding blank line's newline and
  // break paragraph-break detection below.)
  s = s.replaceAll(RegExp(r'^[ \t]*[-*+][ \t]+', multiLine: true), '');
  s = s.replaceAll(RegExp(r'[*_~#|]'), '');
  // Collapse whitespace runs left behind by the stripping.
  s = s.replaceAll(RegExp(r'[ \t]+'), ' ');
  s = s.replaceAll(RegExp(r'\n{2,}'), '. ').replaceAll('\n', ' ');
  s = s.replaceAll(RegExp(r'\s{2,}'), ' ').trim();
  // Android TTS rejects very long utterances; keep well under the limit.
  if (s.length > 3600) s = '${s.substring(0, 3600)}…';
  return s;
}
