import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'log.dart';

/// Keeps the settings store readable by this OS user only (Linux).
///
/// `shared_preferences` on Linux writes `shared_preferences.json` under the
/// app's support directory (`~/.local/share/<app id>/`) with a plain file
/// write, i.e. mode `0666 & ~umask` — typically 0644 — in a directory that
/// is typically 0755. That file holds the bridge token and a snapshot of
/// recent chats, so on a machine with other local users (and a home directory
/// they can traverse) it was readable by them. This narrows the directory to
/// 0700 and the file to 0600, matching how talon-node stores its own config.
///
/// macOS (`~/Library/Preferences`) and Windows (`%APPDATA%`) already sit
/// under per-user permissions, so this is a no-op there. Android keeps app
/// data in its private sandbox.
class PrivateStore {
  PrivateStore({
    Future<String> Function()? supportDir,
    bool Function()? applies,
  })  : _supportDir = supportDir ?? _defaultSupportDir,
        _applies = applies ?? _isLinux;

  final Future<String> Function() _supportDir;
  final bool Function() _applies;

  /// File name `shared_preferences_linux` uses inside the support directory.
  static const prefsFileName = 'shared_preferences.json';

  static bool _isLinux() => !kIsWeb && Platform.isLinux;

  static Future<String> _defaultSupportDir() async =>
      (await getApplicationSupportDirectory()).path;

  /// Create the support directory if needed and restrict it (0700) and the
  /// settings file inside it (0600). Never throws: failing to tighten
  /// permissions is logged, not fatal — the app must still start.
  Future<void> harden() async {
    if (!_applies()) return;
    try {
      final dir = Directory(await _supportDir());
      // Created here (before shared_preferences' first write) so that it
      // never exists with a wider mode than the one set below.
      await dir.create(recursive: true);
      await _chmod('700', dir.path);
      final file = File('${dir.path}/$prefsFileName');
      if (await file.exists()) await _chmod('600', file.path);
    } catch (e) {
      AppLog.warn('prefs', 'could not restrict settings file permissions', e);
    }
  }

  static Future<void> _chmod(String mode, String path) async {
    final result = await Process.run('chmod', [mode, path]);
    if (result.exitCode != 0) {
      throw FileSystemException('chmod $mode failed: ${result.stderr}', path);
    }
  }
}
