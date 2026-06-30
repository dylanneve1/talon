import 'dart:collection';
import 'dart:developer' as developer;

import 'package:flutter/foundation.dart';

enum LogLevel {
  debug,
  info,
  warn,
  error;

  String get label => name.toUpperCase();
}

/// Tiny structured logger for connection diagnostics.
///
/// It writes through Flutter/devtools-friendly sinks and keeps a bounded
/// in-memory tail for future diagnostics UI. Debug logs are skipped in release.
class AppLog {
  static const int _maxLines = 200;
  static final ListQueue<String> _lines = ListQueue<String>(_maxLines);

  static List<String> get recent => List.unmodifiable(_lines);

  static void debug(String tag, String message, [Object? error]) =>
      write(LogLevel.debug, tag, message, error);

  static void info(String tag, String message, [Object? error]) =>
      write(LogLevel.info, tag, message, error);

  static void warn(String tag, String message, [Object? error]) =>
      write(LogLevel.warn, tag, message, error);

  static void error(String tag, String message, [Object? error]) =>
      write(LogLevel.error, tag, message, error);

  static void write(
    LogLevel level,
    String tag,
    String message, [
    Object? error,
  ]) {
    if (kReleaseMode && level == LogLevel.debug) return;
    final line =
        '${DateTime.now().toIso8601String()} ${level.label} [$tag] $message';
    if (_lines.length == _maxLines) _lines.removeFirst();
    _lines.addLast(line);

    developer.log(
      message,
      name: 'talon.$tag',
      level: _levelValue(level),
      error: error,
    );
    if (!kReleaseMode) debugPrint(line);
  }

  static int _levelValue(LogLevel level) {
    switch (level) {
      case LogLevel.debug:
        return 500;
      case LogLevel.info:
        return 800;
      case LogLevel.warn:
        return 900;
      case LogLevel.error:
        return 1000;
    }
  }

  /// Pattern-matches well-known transport failures and returns an
  /// actionable hint, or null if nothing recognized. Surfaced under raw
  /// error text in the UI so a connection failure doesn't require pulling
  /// a screenshot + reading source to diagnose.
  static String? diagnose(String rawError) {
    final e = rawError.toLowerCase();
    if (e.contains('operation not permitted') && e.contains('errno = 1')) {
      return 'This usually means the desktop build is sandboxed without '
          'outbound network access (macOS: missing '
          'com.apple.security.network.client entitlement — run '
          'scripts/fix-macos-entitlements.sh and rebuild). Not a bad '
          'host/port/token.';
    }
    if (e.contains('cleartextnotpermitted') ||
        (e.contains('cleartext') && e.contains('not permitted'))) {
      return 'Android blocks plain HTTP by default and this bridge has no '
          'TLS support, so the HTTPS toggle won\'t help here — run '
          'scripts/fix-android-cleartext.sh and rebuild instead.';
    }
    if (e.contains('connection refused')) {
      return 'Nothing is listening on that host/port — check the daemon is '
          'running and the native frontend is configured with that port.';
    }
    if (e.contains('timed out') || e.contains('timeout')) {
      return 'No response within the timeout — likely a firewall or '
          'network path issue rather than the daemon itself.';
    }
    if (e.contains('401') || e.contains('unauthorized')) {
      return 'Auth rejected — the bearer token doesn\'t match the '
          'daemon\'s configured token.';
    }
    return null;
  }

  /// Dump of recent log lines for a "copy diagnostics" action.
  static String dump() => recent.join('\n');
}
