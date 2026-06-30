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
}
