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

  final SharedPreferences _sp;
  late final Map<String, int> _lastRead = _decodeLastRead();
  Prefs(this._sp);

  static Future<Prefs> load() async => Prefs(await SharedPreferences.getInstance());

  ConnectionConfig get connection {
    final raw = _sp.getString(_kConnection);
    if (raw == null) return ConnectionConfig.defaults();
    try {
      return ConnectionConfig.fromJson(
          (jsonDecode(raw) as Map).cast<String, dynamic>());
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

  /// Persisted theme selection: 'system' (default), 'light', or 'dark'.
  String get themeMode => _sp.getString(_kThemeMode) ?? 'system';
  Future<void> setThemeMode(String v) => _sp.setString(_kThemeMode, v);

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

  // ── Read markers ──────────────────────────────────────────────────────────

  Map<String, int> _decodeLastRead() {
    try {
      final raw = _sp.getString(_kLastRead);
      if (raw == null) return {};
      return (jsonDecode(raw) as Map)
          .map((k, v) => MapEntry(k.toString(), v is num ? v.toInt() : 0));
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
