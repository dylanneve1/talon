import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';

/// macOS menu bar (status item) bridge.
///
/// On macOS the app stays resident after the window closes (the native side
/// hides the window instead of terminating — see macos/Runner). The status
/// item's first menu row shows a short live status line; this pushes it over
/// the "talon/menu_bar" platform channel. Safe no-op everywhere else.
class MenuBarStatus {
  MenuBarStatus._();

  static const MethodChannel _channel = MethodChannel('talon/menu_bar');

  static bool get isSupported => !kIsWeb && Platform.isMacOS;

  static String? _last;

  /// Update the status line ("Connected · mesh active"). Deduplicates —
  /// callers can invoke this on every state change without channel spam.
  static Future<void> set(String text) async {
    if (!isSupported || text == _last) return;
    _last = text;
    try {
      await _channel.invokeMethod<void>('setStatus', text);
    } catch (e) {
      AppLog.warn('menu_bar', 'status update failed', e);
    }
  }
}
