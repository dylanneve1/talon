import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';

/// Marks the Android window FLAG_SECURE while a screen that shows
/// credentials (the bridge token, pairing details) is on screen, so they
/// stay out of the recents thumbnail, screenshots and screen recordings.
///
/// Reference-counted: screens call [acquire] in initState and [release] in
/// dispose, and the flag is set while at least one of them is alive — a
/// settings screen pushing the connect screen doesn't clear it early.
class SecureWindow {
  SecureWindow._();

  static MethodChannel _channel = const MethodChannel('talon/secure');
  static bool Function() _supported = () => !kIsWeb && Platform.isAndroid;
  static int _holders = 0;

  /// Number of screens currently holding the flag (for tests).
  @visibleForTesting
  static int get holders => _holders;

  @visibleForTesting
  static void debugOverride({MethodChannel? channel, bool? supported}) {
    if (channel != null) _channel = channel;
    if (supported != null) _supported = () => supported;
    _holders = 0;
  }

  static void acquire() {
    _holders++;
    if (_holders == 1) _set(true);
  }

  static void release() {
    if (_holders == 0) return;
    _holders--;
    if (_holders == 0) _set(false);
  }

  static void _set(bool secure) {
    if (!_supported()) return;
    _channel.invokeMethod<void>('setSecure', secure).catchError((Object e) {
      // Older builds have no channel; the screen still works, just without
      // the flag.
      AppLog.debug('secure', 'setSecure unavailable', e);
    });
  }
}
