import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/connection.dart';

/// Thin wrapper over [SharedPreferences] for the one thing we persist:
/// the connection profile (local-managed vs remote, host/port/token).
class Prefs {
  static const _kConnection = 'connection.v1';
  static const _kOnboarded = 'onboarded.v1';

  final SharedPreferences _sp;
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
}
