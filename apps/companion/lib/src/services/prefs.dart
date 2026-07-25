import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/connection.dart';

/// Thin wrapper over [SharedPreferences] for everything we persist locally:
/// the connection profile, per-chat read markers (unread badges), and a
/// bounded chat/message snapshot for instant offline cold-start.
class Prefs {
  static const _kConnection = 'connection.v1';
  static const _kOnboarded = 'onboarded.v1';
  static const _kLastRead = 'lastRead.v1';
  static const _kSnapshot = 'snapshot.v1';
  static const _kMeshDeviceId = 'mesh.deviceId.v1';
  static const _kMeshSharing = 'mesh.sharing.v1';
  static const _kMeshPeriodic = 'mesh.periodic.v1';
  static const _kMeshInterval = 'mesh.intervalSeconds.v1';
  static const _kMeshDeviceControl = 'mesh.deviceControl.v1';
  static const _kMeshBgAliveAt = 'mesh.bg.alive_at.v1';
  static const _kMeshBgStartedAt = 'mesh.bg.started_at.v1';

  final SharedPreferences _sp;
  late final Map<String, int> _lastRead = _decodeLastRead();
  Prefs(this._sp);

  static Future<Prefs> load() async =>
      Prefs(await SharedPreferences.getInstance());

  /// Re-read the backing store from disk. SharedPreferences caches per
  /// isolate, so the background mesh isolate must reload after the UI isolate
  /// writes (mesh toggles, a new connection profile) to observe the change.
  Future<void> reload() => _sp.reload();

  ConnectionConfig get connection {
    final raw = _sp.getString(_kConnection);
    if (raw == null) return ConnectionConfig.defaults();
    try {
      return ConnectionConfig.fromJson(
        (jsonDecode(raw) as Map).cast<String, dynamic>(),
      );
    } catch (_) {
      return ConnectionConfig.defaults();
    }
  }

  Future<void> setConnection(ConnectionConfig c) =>
      _sp.setString(_kConnection, jsonEncode(c.toJson()));

  bool get onboarded => _sp.getBool(_kOnboarded) ?? false;
  Future<void> setOnboarded(bool v) => _sp.setBool(_kOnboarded, v);

  // ── Appearance ────────────────────────────────────────────────────────────

  static const _kThemeMode = 'themeMode.v1';
  static const _kAccentSeed = 'accentSeed.v1';
  static const _kAccentDynamic = 'accentDynamic.v1';
  static const _kTextScale = 'textScale.v1';
  static const _kHaptics = 'haptics.v1';

  /// Persisted theme selection: 'system' (default), 'light', or 'dark'.
  String get themeMode => _sp.getString(_kThemeMode) ?? 'system';
  Future<void> setThemeMode(String v) => _sp.setString(_kThemeMode, v);

  /// Custom accent seed as ARGB, or null for the default Talon indigo.
  int? get accentSeed => _sp.getInt(_kAccentSeed);
  Future<void> setAccentSeed(int? argb) => argb == null
      ? _sp.remove(_kAccentSeed).then((_) {})
      : _sp.setInt(_kAccentSeed, argb);

  /// Follow the platform's own colour (Android 12+ wallpaper palette, or the
  /// desktop accent colour) instead of a fixed seed. The resolved colour is
  /// still written to [accentSeed] so a cold start paints the right accent
  /// before the async system read lands. Default off.
  bool get accentDynamic => _sp.getBool(_kAccentDynamic) ?? false;
  Future<void> setAccentDynamic(bool v) => _sp.setBool(_kAccentDynamic, v);

  /// Global UI text scale (0.85–1.3, default 1.0).
  double get textScale => (_sp.getDouble(_kTextScale) ?? 1.0).clamp(0.85, 1.3);
  Future<void> setTextScale(double v) =>
      _sp.setDouble(_kTextScale, v.clamp(0.85, 1.3));

  /// UI haptic feedback (mobile). Default on.
  bool get haptics => _sp.getBool(_kHaptics) ?? true;
  Future<void> setHaptics(bool v) => _sp.setBool(_kHaptics, v);

  // ── Voice mode ────────────────────────────────────────────────────────────

  static const _kVoiceCaptions = 'voice.captions.v1';
  static const _kVoiceHandsFree = 'voice.handsFree.v1';
  static const _kVoiceRate = 'voice.rate.v1';
  static const _kVoiceName = 'voice.name.v1';
  static const _kVoicePitch = 'voice.pitch.v1';

  /// Show live captions in voice mode. Default on.
  bool get voiceCaptions => _sp.getBool(_kVoiceCaptions) ?? true;
  Future<void> setVoiceCaptions(bool v) => _sp.setBool(_kVoiceCaptions, v);

  /// Hands-free conversation loop: re-arm the mic after each spoken reply.
  bool get voiceHandsFree => _sp.getBool(_kVoiceHandsFree) ?? true;
  Future<void> setVoiceHandsFree(bool v) => _sp.setBool(_kVoiceHandsFree, v);

  /// Text-to-speech rate (0.6–1.6, default 1.0).
  double get voiceRate => (_sp.getDouble(_kVoiceRate) ?? 1.0).clamp(0.6, 1.6);
  Future<void> setVoiceRate(double v) =>
      _sp.setDouble(_kVoiceRate, v.clamp(0.6, 1.6));

  /// Text-to-speech pitch (0.8–1.2, default 1.0). Small range on purpose:
  /// past roughly ±20% the engine's formants smear and it sounds synthetic.
  double get voicePitch => (_sp.getDouble(_kVoicePitch) ?? 1.0).clamp(0.8, 1.2);
  Future<void> setVoicePitch(double v) =>
      _sp.setDouble(_kVoicePitch, v.clamp(0.8, 1.2));

  /// Stable Android TTS voice name, or null to let the engine's best-quality
  /// voice for the device locale be picked automatically.
  String? get voiceName => _sp.getString(_kVoiceName);
  Future<void> setVoiceName(String? name) => name == null
      ? _sp.remove(_kVoiceName).then((_) {})
      : _sp.setString(_kVoiceName, name);

  // ── Device mesh ──────────────────────────────────────────────────────────

  String? get meshDeviceId => _sp.getString(_kMeshDeviceId);
  Future<void> setMeshDeviceId(String id) => _sp.setString(_kMeshDeviceId, id);

  bool get meshSharing => _sp.getBool(_kMeshSharing) ?? true;
  Future<void> setMeshSharing(bool v) => _sp.setBool(_kMeshSharing, v);

  bool get meshPeriodic => _sp.getBool(_kMeshPeriodic) ?? false;
  Future<void> setMeshPeriodic(bool v) => _sp.setBool(_kMeshPeriodic, v);

  int get meshIntervalSeconds => _sp.getInt(_kMeshInterval) ?? 300;
  Future<void> setMeshIntervalSeconds(int v) =>
      _sp.setInt(_kMeshInterval, v.clamp(60, 3600));

  /// Whether this device answers remote shell/filesystem commands (the
  /// "teleport" substrate). Default on — Dylan's own devices — but visible and
  /// revocable in settings.
  bool get meshDeviceControl => _sp.getBool(_kMeshDeviceControl) ?? true;
  Future<void> setMeshDeviceControl(bool v) =>
      _sp.setBool(_kMeshDeviceControl, v);

  int? get meshBgAliveAt => _sp.getInt(_kMeshBgAliveAt);
  Future<void> setMeshBgAliveAt(int epochMs) =>
      _sp.setInt(_kMeshBgAliveAt, epochMs);

  int? get meshBgStartedAt => _sp.getInt(_kMeshBgStartedAt);
  Future<void> setMeshBgStartedAt(int epochMs) =>
      _sp.setInt(_kMeshBgStartedAt, epochMs);

  // ── Notifications ─────────────────────────────────────────────────────────

  static const _kMessageNotifications = 'notify.messages.v1';
  static const _kUiForeground = 'ui.foreground.v1';

  /// Post a system notification when an assistant reply lands while the app is
  /// backgrounded. Default **off**: it needs the runtime POST_NOTIFICATIONS
  /// grant and it is the kind of thing a user should opt into, not discover.
  bool get messageNotifications => _sp.getBool(_kMessageNotifications) ?? false;
  Future<void> setMessageNotifications(bool v) =>
      _sp.setBool(_kMessageNotifications, v);

  /// Whether the UI isolate currently has the app in front of the user.
  ///
  /// Written by the UI on every [AppLifecycleState] change and read by the
  /// background mesh isolate, which has no other way to know: the two isolates
  /// share no memory, so SharedPreferences is the cheap cross-isolate flag.
  /// Without it you get a notification for a reply you are actively watching
  /// stream in.
  bool get uiForeground => _sp.getBool(_kUiForeground) ?? false;
  Future<void> setUiForeground(bool v) => _sp.setBool(_kUiForeground, v);

  // ── Read markers ──────────────────────────────────────────────────────────

  Map<String, int> _decodeLastRead() {
    try {
      final raw = _sp.getString(_kLastRead);
      if (raw == null) return {};
      return (jsonDecode(raw) as Map).map(
        (k, v) => MapEntry(k.toString(), v is num ? v.toInt() : 0),
      );
    } catch (_) {
      return {};
    }
  }

  /// Epoch-ms of the newest activity the user has seen in a chat (0 = never).
  int lastReadOf(String chatId) => _lastRead[chatId] ?? 0;

  Future<void> setLastRead(String chatId, int ts) {
    if ((_lastRead[chatId] ?? 0) >= ts) return Future.value();
    _lastRead[chatId] = ts;
    return _sp.setString(_kLastRead, jsonEncode(_lastRead));
  }

  Future<void> clearLastRead(String chatId) {
    _lastRead.remove(chatId);
    return _sp.setString(_kLastRead, jsonEncode(_lastRead));
  }

  // ── Offline snapshot ──────────────────────────────────────────────────────

  /// Last-known chats + recent messages, decoded; null when absent/corrupt.
  Map<String, dynamic>? get snapshot {
    try {
      final raw = _sp.getString(_kSnapshot);
      if (raw == null) return null;
      final decoded = jsonDecode(raw);
      return decoded is Map ? decoded.cast<String, dynamic>() : null;
    } catch (_) {
      return null;
    }
  }

  Future<void> saveSnapshot(Map<String, dynamic> snapshot) =>
      _sp.setString(_kSnapshot, jsonEncode(snapshot));
}
