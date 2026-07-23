import 'dart:async';
import 'dart:collection';

import 'package:flutter/foundation.dart' show ChangeNotifier;

import '../models/bridge_models.dart';
import '../services/log.dart';
import '../services/voice.dart';
import 'app_state.dart';

/// Where the voice conversation currently is.
enum VoicePhase {
  /// Mic idle — tap the orb to talk.
  idle,

  /// Capturing the user's speech (partials streaming in).
  listening,

  /// Utterance sent; the agent is working (reasoning / calling tools).
  thinking,

  /// Reading the agent's reply aloud.
  speaking,

  /// Something broke — [errorText] says what; tap the orb to retry.
  error,
}

/// The voice-mode conversation loop, as a ChangeNotifier the full-screen UI
/// renders from:
///
///   listen → final transcript → send into the selected chat → watch the
///   turn (tools and streaming included) → speak each delivered reply →
///   listen again (hands-free) or rest (tap-to-talk).
///
/// Tool calling comes for free: the utterance goes through the normal bridge
/// pipeline, so the agent runs whatever tools it needs server-side — this
/// class just surfaces the activity ([toolLabel], [tools]) while it happens
/// and resumes the loop when the turn ends.
class VoiceSession extends ChangeNotifier {
  final AppState state;

  /// Keep listening after each reply (conversation style) vs tap-to-talk.
  bool handsFree;

  VoiceSession(this.state, {required this.handsFree}) {
    state.addListener(_onAppState);
    final v = VoiceService.instance;
    _subs.addAll([
      v.onPartial.listen(_onPartial),
      v.onFinal.listen(_onFinal),
      v.onRms.listen(_onRms),
      v.onSttError.listen(_onSttError),
      v.onTtsDone.listen((_) => _onUtteranceFinished()),
      v.onTtsError.listen((_) => _onUtteranceFinished()),
    ]);
  }

  final _subs = <StreamSubscription<dynamic>>[];

  VoicePhase phase = VoicePhase.idle;
  String? errorText;

  /// Live partial transcript while listening.
  String partial = '';

  /// The last utterance actually sent.
  String lastUserText = '';

  /// Smoothed mic level 0..1 (drives the orb pulse).
  double level = 0;

  /// Mic muted: no auto-relisten, orb rests. Speech keeps playing.
  bool muted = false;

  /// The chat this session is talking in (bound at first send; follows the
  /// app's selection until then).
  String? _chatId;
  String? get chatId => _chatId ?? state.selectedChatId;

  // Reply tracking for the in-flight turn.
  final Set<String> _seenMessageIds = {};
  final Queue<({String display, String speech})> _speakQueue = Queue();
  ({String display, String speech})? _current;
  bool _turnSeen = false;
  int _utteranceSeq = 0;
  Timer? _stallTimer;
  Timer? _relistenTimer;
  bool _disposed = false;

  /// What the captions panel should show for the assistant right now:
  /// the utterance being spoken, else the live streaming draft.
  String get assistantCaption {
    final cur = _current;
    if (cur != null) return cur.display;
    final id = chatId;
    if (id == null) return '';
    return state.turnFor(id).draft;
  }

  /// Live tool activity for the current turn (newest last).
  List<ToolActivity> get tools {
    final id = chatId;
    if (id == null) return const [];
    return state.turnFor(id).tools;
  }

  /// "Running bash…"-style status while the agent works, or null.
  String? get toolLabel {
    for (final t in tools.reversed) {
      if (!t.done) return t.name;
    }
    return null;
  }

  // ── Session control ───────────────────────────────────────────────────────

  /// Ask for the mic and start the loop. Call once, right after pushing the
  /// voice screen.
  Future<void> start() async {
    final v = VoiceService.instance;
    if (!await v.isSttAvailable()) {
      _fail('Speech recognition is not available on this device.');
      return;
    }
    if (!await v.requestMicPermission()) {
      _fail('Talon needs microphone access for voice mode.');
      return;
    }
    await listen();
  }

  /// Begin (or resume) capturing speech.
  Future<void> listen() async {
    if (_disposed || muted) return;
    _relistenTimer?.cancel();
    partial = '';
    errorText = null;
    phase = VoicePhase.listening;
    notifyListeners();
    final ok = await VoiceService.instance.startListening();
    if (!ok && !_disposed) _fail('Could not start the speech recognizer.');
  }

  /// The orb is the one big affordance; what a tap means depends on phase.
  Future<void> onOrbTap() async {
    switch (phase) {
      case VoicePhase.listening:
        // Done talking — wrap up and use what was heard.
        await VoiceService.instance.stopListening();
      case VoicePhase.speaking:
        // Barge-in: cut the reply short and talk.
        _speakQueue.clear();
        _current = null;
        await VoiceService.instance.stopSpeaking();
        await listen();
      case VoicePhase.idle:
      case VoicePhase.error:
        await listen();
      case VoicePhase.thinking:
        break; // Nothing sensible to do mid-turn.
    }
  }

  Future<void> toggleMute() async {
    muted = !muted;
    if (muted && phase == VoicePhase.listening) {
      await VoiceService.instance.cancelListening();
      partial = '';
      phase = VoicePhase.idle;
    } else if (!muted &&
        (phase == VoicePhase.idle || phase == VoicePhase.error)) {
      await listen();
      return; // listen() already notified.
    }
    notifyListeners();
  }

  // ── Speech events ─────────────────────────────────────────────────────────

  void _onPartial(String text) {
    if (_disposed || phase != VoicePhase.listening) return;
    partial = text;
    notifyListeners();
  }

  void _onRms(double v) {
    if (_disposed) return;
    // Light exponential smoothing so the orb breathes instead of jittering.
    level = level * 0.55 + v * 0.45;
    if (phase == VoicePhase.listening) notifyListeners();
  }

  Future<void> _onFinal(String text) async {
    if (_disposed) return;
    final trimmed = text.trim();
    if (trimmed.isEmpty) {
      _afterEmptyCapture();
      return;
    }
    partial = '';
    lastUserText = trimmed;
    phase = VoicePhase.thinking;
    _turnSeen = false;
    _speakQueue.clear();
    _current = null;
    notifyListeners();

    // Bind to a chat: the selected one, or a fresh chat when nothing is
    // selected (assist launches on a clean install land here).
    if (state.selectedChatId == null) {
      await state.newChat();
    }
    final id = state.selectedChatId;
    if (id == null) {
      _fail('Not connected to Talon yet.');
      return;
    }
    _chatId = id;
    _seenMessageIds
      ..clear()
      ..addAll(state.messagesFor(id).map((m) => m.id));
    final ok = await state.sendMessage(trimmed);
    if (!ok) {
      _fail('Could not send the message — check the connection.');
      return;
    }
    // Watchdog: if no turn starts and nothing arrives, don't hang forever.
    _stallTimer?.cancel();
    _stallTimer = Timer(const Duration(seconds: 30), () {
      if (_disposed || phase != VoicePhase.thinking) return;
      if (!_turnSeen && _speakQueue.isEmpty && _current == null) {
        _fail('No reply from Talon.');
      }
    });
  }

  void _onSttError(SttError e) {
    if (_disposed || phase != VoicePhase.listening) return;
    if (e.benign) {
      _afterEmptyCapture();
      return;
    }
    AppLog.warn('voice', 'stt error', e);
    _fail(e.message);
  }

  /// Nothing usable was heard. In hands-free mode quietly re-arm the mic
  /// (with a beat, so a silent room doesn't spin the recognizer); in
  /// tap-to-talk mode just rest.
  void _afterEmptyCapture() {
    partial = '';
    if (handsFree && !muted) {
      phase = VoicePhase.listening;
      notifyListeners();
      _relistenTimer?.cancel();
      _relistenTimer = Timer(const Duration(milliseconds: 350), () {
        if (!_disposed) listen();
      });
    } else {
      phase = VoicePhase.idle;
      notifyListeners();
    }
  }

  // ── Turn tracking ─────────────────────────────────────────────────────────

  void _onAppState() {
    if (_disposed) return;
    final id = chatId;
    if (id == null) return;
    final turn = state.turnFor(id);
    if (phase == VoicePhase.thinking || phase == VoicePhase.speaking) {
      if (turn.active) _turnSeen = true;
      // Queue any assistant messages that landed since we sent.
      for (final m in state.messagesFor(id)) {
        if (m.role != Role.assistant) continue;
        if (!_seenMessageIds.add(m.id)) continue;
        final speech = speechify(m.text);
        if (speech.isEmpty) continue;
        _speakQueue.add((display: m.text, speech: speech));
      }
      if (phase == VoicePhase.thinking) {
        if (_speakQueue.isNotEmpty) {
          _speakNext();
        } else if (_turnSeen && !turn.active && _current == null) {
          // Turn over with nothing speakable (e.g. the agent just reacted).
          _stallTimer?.cancel();
          _afterReplyFinished();
        } else {
          // Streaming draft / tool chips changed — repaint captions.
          notifyListeners();
        }
      }
    }
  }

  void _speakNext() {
    final next = _speakQueue.removeFirst();
    _current = next;
    _stallTimer?.cancel();
    phase = VoicePhase.speaking;
    notifyListeners();
    VoiceService.instance
        .speak(
      next.speech,
      id: 'utt${_utteranceSeq++}',
      rate: state.prefs.voiceRate,
    )
        .then((ok) {
      // A refused speak would otherwise stall the queue forever.
      if (!ok && !_disposed && _current == next) _onUtteranceFinished();
    });
  }

  void _onUtteranceFinished() {
    if (_disposed || _current == null) return;
    _current = null;
    if (_speakQueue.isNotEmpty) {
      _speakNext();
      return;
    }
    final id = chatId;
    final turnActive = id != null && state.turnFor(id).active;
    if (turnActive) {
      // The agent is still working — more replies may follow.
      phase = VoicePhase.thinking;
      notifyListeners();
    } else {
      _afterReplyFinished();
    }
  }

  void _afterReplyFinished() {
    if (handsFree && !muted) {
      listen();
    } else {
      phase = VoicePhase.idle;
      notifyListeners();
    }
  }

  void _fail(String message) {
    errorText = message;
    phase = VoicePhase.error;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _stallTimer?.cancel();
    _relistenTimer?.cancel();
    for (final s in _subs) {
      s.cancel();
    }
    state.removeListener(_onAppState);
    VoiceService.instance.cancelListening();
    VoiceService.instance.stopSpeaking();
    super.dispose();
  }
}
