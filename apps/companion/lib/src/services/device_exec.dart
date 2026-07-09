import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'log.dart';

/// On-device shell + filesystem executor — the device half of Talon's
/// "teleport". The daemon pushes `exec`/`read_file`/`write_file`/`list_dir`/
/// `stat`/`delete`/`mkdir`/`move` commands over the mesh; this runs them here
/// and returns a structured payload.
///
/// Two privilege tiers:
///   - app-UID (default): commands run as the app's own user via `sh -c`,
///     and file IO uses dart:io. This can reach shared storage (Downloads,
///     DCIM, …) when the app holds All-files access (MANAGE_EXTERNAL_STORAGE),
///     but not other apps' private data.
///   - Shizuku (optional, Android): when Shizuku is installed, running, and
///     has granted permission, commands run at shell (ADB) privilege via the
///     `talon/shizuku` platform channel — enough to reach far more of the
///     system without root. Falls back to app-UID whenever Shizuku is absent
///     or denied.
class DeviceExec {
  DeviceExec({MethodChannel? shizukuChannel})
      : _shizuku = shizukuChannel ?? const MethodChannel('talon/shizuku');

  final MethodChannel _shizuku;

  /// Commands this executor can answer — merged into the device's advertised
  /// mesh capabilities so the daemon gates cleanly.
  static const List<String> capabilities = [
    'exec',
    'read_file',
    'write_file',
    'list_dir',
    'stat',
    'delete',
    'mkdir',
    'move',
  ];

  static const int _maxChunkBytes = 256 * 1024;

  /// True when Shizuku is available AND has granted permission right now.
  Future<bool> shizukuReady() async {
    if (kIsWeb || !Platform.isAndroid) return false;
    try {
      final ok = await _shizuku.invokeMethod<bool>('isReady');
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Ask Shizuku for permission (no-op / false when unavailable).
  Future<bool> requestShizuku() async {
    if (kIsWeb || !Platform.isAndroid) return false;
    try {
      final ok = await _shizuku.invokeMethod<bool>('requestPermission');
      return ok ?? false;
    } catch (_) {
      return false;
    }
  }

  /// Dispatch a mesh command by name; returns `null` for names this executor
  /// does not own (so the caller can try other handlers).
  Future<CommandOutcome?> handle(
    String name,
    Map<String, dynamic> params,
  ) async {
    switch (name) {
      case 'exec':
        return exec(
          _str(params['cmd']) ?? '',
          cwd: _str(params['cwd']),
          timeoutMs: _int(params['timeoutMs']),
        );
      case 'read_file':
        return readFile(
          _str(params['path']) ?? '',
          offset: _int(params['offset']) ?? 0,
          len: _int(params['len']) ?? _maxChunkBytes,
        );
      case 'write_file':
        return writeFile(
          _str(params['path']) ?? '',
          _str(params['base64']) ?? '',
          offset: _int(params['offset']) ?? 0,
          truncate: params['truncate'] == true,
        );
      case 'list_dir':
        return listDir(_str(params['path']) ?? '');
      case 'stat':
        return statPath(_str(params['path']) ?? '');
      case 'delete':
        return deletePath(_str(params['path']) ?? '');
      case 'mkdir':
        return mkdir(_str(params['path']) ?? '');
      case 'move':
        return move(_str(params['from']) ?? '', _str(params['to']) ?? '');
      default:
        return null;
    }
  }

  // ── exec ──────────────────────────────────────────────────────────────────

  Future<CommandOutcome> exec(
    String cmd, {
    String? cwd,
    int? timeoutMs,
  }) async {
    if (cmd.trim().isEmpty) {
      return CommandOutcome.fail('No command given.');
    }
    final budget = Duration(milliseconds: (timeoutMs ?? 60000).clamp(1000, 300000));
    // Prefer Shizuku (shell UID) when it's ready, else run as the app user.
    if (await shizukuReady()) {
      try {
        final res = await _shizuku.invokeMapMethod<String, dynamic>('exec', {
          'cmd': cmd,
          if (cwd != null) 'cwd': cwd,
          'timeoutMs': budget.inMilliseconds,
        });
        if (res != null) {
          return CommandOutcome(
            ok: (res['exitCode'] as num?)?.toInt() == 0,
            data: {
              'stdout': res['stdout'] ?? '',
              'stderr': res['stderr'] ?? '',
              'exitCode': (res['exitCode'] as num?)?.toInt() ?? -1,
              'via': 'shizuku',
            },
          );
        }
      } catch (e) {
        AppLog.warn('exec', 'shizuku exec failed, falling back', e);
      }
    }
    return _execAppUid(cmd, cwd: cwd, budget: budget);
  }

  Future<CommandOutcome> _execAppUid(
    String cmd, {
    String? cwd,
    required Duration budget,
  }) async {
    final shell = Platform.isWindows ? 'cmd' : 'sh';
    final args = Platform.isWindows ? ['/c', cmd] : ['-c', cmd];
    try {
      final proc = await Process.start(
        shell,
        args,
        workingDirectory: (cwd != null && cwd.isNotEmpty) ? cwd : null,
      );
      final outF = proc.stdout.transform(utf8.decoder).join();
      final errF = proc.stderr.transform(utf8.decoder).join();
      var timedOut = false;
      final timer = Timer(budget, () {
        timedOut = true;
        proc.kill(ProcessSignal.sigkill);
      });
      final code = await proc.exitCode;
      timer.cancel();
      final stdout = await outF;
      final stderr = await errF;
      return CommandOutcome(
        ok: !timedOut && code == 0,
        data: {
          'stdout': stdout,
          'stderr': timedOut ? '$stderr\n[killed: timeout]' : stderr,
          'exitCode': code,
          'via': 'app',
        },
        message: timedOut ? 'Command timed out.' : null,
      );
    } catch (e) {
      return CommandOutcome.fail('Failed to run command: $e');
    }
  }

  // ── filesystem ────────────────────────────────────────────────────────────

  Future<CommandOutcome> readFile(
    String path,
    {required int offset, required int len}) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final file = File(path);
      if (!await file.exists()) {
        return CommandOutcome.fail('No such file: $path');
      }
      final size = await file.length();
      final raf = await file.open();
      try {
        await raf.setPosition(offset);
        final want = len.clamp(0, _maxChunkBytes);
        final bytes = await raf.read(want);
        final eof = offset + bytes.length >= size;
        return CommandOutcome.okData({
          'base64': base64Encode(bytes),
          'size': size,
          'eof': eof,
        });
      } finally {
        await raf.close();
      }
    } catch (e) {
      return CommandOutcome.fail('read_file failed: $e');
    }
  }

  Future<CommandOutcome> writeFile(
    String path,
    String b64, {
    required int offset,
    required bool truncate,
  }) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final file = File(path);
      await file.parent.create(recursive: true);
      final bytes = base64Decode(b64);
      // No size cap — writes proceed until a real limit fails them (disk
      // full, permissions), and that exception is surfaced verbatim below.
      // Write at the offset the daemon asked for — never blind-append. The
      // transfer protocol is truncate-first + sequential offsets, so a chunk
      // whose offset doesn't match the current size is out of order (or a
      // duplicate retry) and appending it would silently corrupt the file.
      final raf = await file.open(
        mode: truncate ? FileMode.write : FileMode.append,
      );
      try {
        if (!truncate) {
          final current = await raf.length();
          if (offset != current) {
            return CommandOutcome.fail(
              'write_file chunk offset $offset does not match current size '
              '$current for $path (out-of-order or duplicate chunk).',
            );
          }
        }
        await raf.setPosition(truncate ? 0 : offset);
        await raf.writeFrom(bytes);
        if (truncate) await raf.truncate(bytes.length);
        await raf.flush();
      } finally {
        await raf.close();
      }
      return CommandOutcome.okData({'bytesWritten': bytes.length});
    } catch (e) {
      return CommandOutcome.fail('write_file failed: $e');
    }
  }

  Future<CommandOutcome> listDir(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final dir = Directory(path);
      if (!await dir.exists()) {
        return CommandOutcome.fail('No such directory: $path');
      }
      final entries = <Map<String, dynamic>>[];
      await for (final e in dir.list(followLinks: false)) {
        final stat = await e.stat();
        entries.add({
          'name': e.uri.pathSegments.where((s) => s.isNotEmpty).last,
          'type': stat.type == FileSystemEntityType.directory ? 'dir' : 'file',
          'size': stat.size,
          'mtime': stat.modified.millisecondsSinceEpoch,
        });
      }
      entries.sort((a, b) => (a['name'] as String).compareTo(b['name'] as String));
      return CommandOutcome.okData({'entries': entries});
    } catch (e) {
      return CommandOutcome.fail('list_dir failed: $e');
    }
  }

  Future<CommandOutcome> statPath(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final stat = await FileStat.stat(path);
      if (stat.type == FileSystemEntityType.notFound) {
        return CommandOutcome.fail('No such path: $path');
      }
      return CommandOutcome.okData({
        'type': stat.type.toString().split('.').last,
        'size': stat.size,
        'mtime': stat.modified.millisecondsSinceEpoch,
        'mode': stat.modeString(),
      });
    } catch (e) {
      return CommandOutcome.fail('stat failed: $e');
    }
  }

  Future<CommandOutcome> deletePath(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      final type = await FileSystemEntity.type(path);
      if (type == FileSystemEntityType.directory) {
        await Directory(path).delete(recursive: true);
      } else if (type == FileSystemEntityType.notFound) {
        return CommandOutcome.fail('No such path: $path');
      } else {
        await File(path).delete();
      }
      return CommandOutcome(ok: true, message: 'Deleted $path');
    } catch (e) {
      return CommandOutcome.fail('delete failed: $e');
    }
  }

  Future<CommandOutcome> mkdir(String path) async {
    if (path.isEmpty) return CommandOutcome.fail('No path.');
    try {
      await Directory(path).create(recursive: true);
      return CommandOutcome(ok: true, message: 'Created $path');
    } catch (e) {
      return CommandOutcome.fail('mkdir failed: $e');
    }
  }

  Future<CommandOutcome> move(String from, String to) async {
    if (from.isEmpty || to.isEmpty) return CommandOutcome.fail('from/to required.');
    try {
      final type = await FileSystemEntity.type(from);
      if (type == FileSystemEntityType.directory) {
        await Directory(from).rename(to);
      } else {
        await File(from).rename(to);
      }
      return CommandOutcome(ok: true, message: 'Moved $from → $to');
    } catch (e) {
      // rename fails across filesystems — fall back to copy+delete for files.
      try {
        await File(from).copy(to);
        await File(from).delete();
        return CommandOutcome(ok: true, message: 'Moved $from → $to (copied)');
      } catch (e2) {
        return CommandOutcome.fail('move failed: $e2');
      }
    }
  }

  static String? _str(dynamic v) => v is String && v.isNotEmpty ? v : null;
  static int? _int(dynamic v) => v is num ? v.toInt() : (v is String ? int.tryParse(v) : null);
}

/// Structured result of an on-device command.
class CommandOutcome {
  const CommandOutcome({required this.ok, this.message, this.data});

  final bool ok;
  final String? message;
  final Map<String, dynamic>? data;

  factory CommandOutcome.fail(String message) =>
      CommandOutcome(ok: false, message: message);
  factory CommandOutcome.okData(Map<String, dynamic> data) =>
      CommandOutcome(ok: true, data: data);
}
