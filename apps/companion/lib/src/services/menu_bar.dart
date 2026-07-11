import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';
import 'windows_tray.dart';

/// Desktop resident-status line ("Connected · mesh active").
///
/// On macOS the app stays resident after the window closes (the native side
/// hides the window instead of terminating — see macos/Runner) and the status
/// item's first menu row shows this line, pushed over the "talon/menu_bar"
/// platform channel. On Windows the same residency comes from the system
/// tray ([WindowsTray]); the line lands in its tooltip + menu. Safe no-op
/// everywhere else.
class MenuBarStatus {
  MenuBarStatus._();

  static const MethodChannel _channel = MethodChannel('talon/menu_bar');

  static bool get isSupported =>
      !kIsWeb && (Platform.isMacOS || Platform.isWindows);

  static String? _last;

  /// Update the status line. Deduplicates — callers can invoke this on every
  /// state change without channel spam.
  static Future<void> set(String text) async {
    if (!isSupported || text == _last) return;
    _last = text;
    if (Platform.isWindows) {
      await WindowsTray.instance.setStatus(text);
      return;
    }
    try {
      await _channel.invokeMethod<void>('setStatus', text);
    } catch (e) {
      AppLog.warn('menu_bar', 'status update failed', e);
    }
  }
}
