import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:launch_at_startup/launch_at_startup.dart';

import 'log.dart';

/// Desktop launch-at-login.
///
/// Completes the residency story: macOS (menu bar) and Windows (system tray)
/// keep the mesh alive after the window closes; this keeps it alive from
/// boot. Backed by launch_at_startup — SMAppService on macOS, the HKCU Run
/// registry key on Windows, an autostart .desktop entry on Linux.
class Autostart {
  Autostart._();

  static bool get isSupported =>
      !kIsWeb && (Platform.isMacOS || Platform.isWindows || Platform.isLinux);

  static bool _setup = false;

  static void _ensureSetup() {
    if (_setup) return;
    _setup = true;
    launchAtStartup.setup(
      appName: 'Talon',
      appPath: Platform.resolvedExecutable,
    );
  }

  /// Whether the app is currently registered to start at login. Returns
  /// false (never throws) when unsupported or the OS query fails.
  static Future<bool> isEnabled() async {
    if (!isSupported) return false;
    _ensureSetup();
    try {
      return await launchAtStartup.isEnabled();
    } catch (e) {
      AppLog.warn('autostart', 'isEnabled failed', e);
      return false;
    }
  }

  /// Register/unregister start-at-login. Returns the resulting state so the
  /// UI can reconcile (OS may refuse — e.g. login items disabled by policy).
  static Future<bool> setEnabled(bool enabled) async {
    if (!isSupported) return false;
    _ensureSetup();
    try {
      if (enabled) {
        await launchAtStartup.enable();
      } else {
        await launchAtStartup.disable();
      }
    } catch (e) {
      AppLog.warn('autostart', 'setEnabled($enabled) failed', e);
    }
    return isEnabled();
  }
}
