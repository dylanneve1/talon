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
  DeviceExec({
    MethodChannel? shizukuChannel,
    bool Function()? isAndroid,
  })  : _shizuku = shizukuChannel ?? const MethodChannel('talon/shizuku'),
        _isAndroid = isAndroid ?? (() => !kIsWeb && Platform.isAndroid);

  final MethodChannel _shizuku;
  final bool Function() _isAndroid;
  Future<bool>? _pendingShizukuPermission;

  /// Last Shizuku state string reported by the native bridge ("ready",
  /// "permission-needed", "not-running", "unavailable", …). Captured on every
  /// readiness probe so an app-UID fallback can say *why* Shizuku wasn't used,
  /// in the command result that travels back over the mesh — no adb needed.
  String? _lastShizukuState;

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
    // Silent self-update: install a pushed APK via Shizuku. Advertised
    // everywhere device control is on; answers with a clear "only on
    // Android / needs Shizuku" when it can't actually run.
    'install_apk',
  ];

  static const int _maxChunkBytes = 256 * 1024;
  static const Duration _shizukuPermissionWait = Duration(seconds: 12);
  /// Per-stream cap on exec output shipped back over the mesh. Head + tail
  /// (not head-only): the daemon's teleport wrapper prints its cwd marker at
  /// the very END of stdout, and losing it would break cwd tracking.
  static const int _execOutputHeadBytes = 192 * 1024;
  static const int _execOutputTailBytes = 64 * 1024;

  /// True when Shizuku is available AND has granted permission right now.
  Future<bool> shizukuReady() async {
    if (!_isAndroid()) return false;
    try {
      final status =
          await _shizuku.invokeMapMethod<String, dynamic>('getStatus');
      final state = status?['state'];
      if (state is String) _lastShizukuState = state;
      final ready = status?['ready'] == true;
      AppLog.info('shizuku', 'getStatus ready=$ready state=$_lastShizukuState');
      return ready;
    } catch (e) {
      _lastShizukuState = 'error: $e';
      AppLog.warn('shizuku', 'getStatus failed', e);
      return false;
    }
  }

  /// Ask Shizuku for permission once. Concurrent commands share a single
  /// system prompt instead of replacing one another's result callback.
  Future<bool> requestShizuku() async {
    if (!_isAndroid()) return false;
    return _pendingShizukuPermission ??= _requestShizuku().whenComplete(() {
      _pendingShizukuPermission = null;
    });
  }

  Future<bool> _requestShizuku() async {
    try {
      final granted = await _shizuku
          .invokeMethod<bool>('requestPermission')
          .timeout(_shizukuPermissionWait);
      // The permission callback is advisory; re-check the binder before
      // claiming elevated execution is actually available.
      return granted == true && await shizukuReady();
    } on TimeoutException {
      // Dart has stopped waiting, so release the Android-side MethodChannel
      // result too. A late approval still applies to the next command.
      unawaited(_cancelShizukuPermissionRequest());
      return false;
    } catch (_) {
      return false;
    }
  }

  Future<void> _cancelShizukuPermissionRequest() async {
    try {
      await _shizuku.invokeMethod<void>('cancelPermissionRequest');
    } catch (_) {
      // The bridge may have gone away with the activity; the next status check
      // will report it as unavailable.
    }
  }

  /// Prefer elevated Android execution, but never hang the command forever
  /// waiting for a permission dialog that may be ignored.
  Future<bool> ensureShizukuReady() async {
    if (await shizukuReady()) return true;
    if (!_isAndroid()) return false;
    return requestShizuku();
  }

  Future<Map<String, String>> privilegeStatus() async {
    // Desktop platforms run commands as the logged-in OS user; the
    // shizuku/app distinction is Android-only.
    if (!_isAndroid()) return const {'execPrivilege': 'user'};
    try {
      final status =
          await _shizuku.invokeMapMethod<String, dynamic>('getStatus');
      final ready = status?['ready'] == true;
      final state = status?['state'];
      return {
        'execPrivilege': ready ? 'shizuku' : 'app',
        'shizuku': state is String ? state : 'unavailable',
      };
    } catch (_) {
      return const {'execPrivilege': 'app', 'shizuku': 'unavailable'};
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
      case 'install_apk':
        return installApk(
          _str(params['path']) ?? '',
          sha256: _str(params['sha256']),
          delayMs: _int(params['delayMs']),
        );
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
    final budget =
        Duration(milliseconds: (timeoutMs ?? 60000).clamp(1000, 300000));
    // Prefer Shizuku (shell UID). If it is installed but permission has not
    // been granted yet, ask once; otherwise a remote filesystem command can
    // silently run as the app UID and return a misleading scoped-storage view.
    if (await ensureShizukuReady()) {
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
              'stdout': _CappedOutput.clamp('${res['stdout'] ?? ''}'),
              'stderr': _CappedOutput.clamp('${res['stderr'] ?? ''}'),
              'exitCode': (res['exitCode'] as num?)?.toInt() ?? -1,
              'via': 'shizuku',
            },
          );
        }
      } catch (e) {
        AppLog.warn('exec', 'shizuku exec failed, falling back', e);
        return _execAppUid(
          cmd,
          cwd: cwd,
          budget: budget,
          privilegeWarning: 'Shizuku exec failed ($e); ran as app UID.',
        );
      }
    }
    return _execAppUid(
      cmd,
      cwd: cwd,
      budget: budget,
      privilegeWarning: _isAndroid()
          ? 'Shizuku not used (state=${_lastShizukuState ?? 'unknown'}); '
              'ran as app UID.'
          : null,
    );
  }

  Future<CommandOutcome> _execAppUid(
    String cmd, {
    String? cwd,
    required Duration budget,
    String? privilegeWarning,
  }) async {
    final shell = Platform.isWindows ? 'cmd' : 'sh';
    final args = Platform.isWindows ? ['/c', cmd] : ['-c', cmd];
    try {
      final proc = await Process.start(
        shell,
        args,
        workingDirectory: (cwd != null && cwd.isNotEmpty) ? cwd : null,
      );
      // Bounded collection: a chatty command must not balloon app memory or
      // the mesh result payload — the stream keeps draining, extra bytes are
      // counted and elided.
      final out = _CappedOutput();
      final err = _CappedOutput();
      final outF = proc.stdout.transform(utf8.decoder).forEach(out.add);
      final errF = proc.stderr.transform(utf8.decoder).forEach(err.add);
      var timedOut = false;
      final timer = Timer(budget, () {
        timedOut = true;
        proc.kill(ProcessSignal.sigkill);
      });
      final code = await proc.exitCode;
      timer.cancel();
      await outF;
      await errF;
      final stdout = out.value();
      final stderr = err.value();
      return CommandOutcome(
        ok: !timedOut && code == 0,
        data: {
          'stdout': stdout,
          'stderr': [
            if (privilegeWarning != null) privilegeWarning,
            if (stderr.isNotEmpty) stderr,
            if (timedOut) '[killed: timeout]',
          ].join('\n'),
          'exitCode': code,
          // Only Android has a degraded app-UID mode worth flagging; desktop
          // shells already run as the OS user.
          if (_isAndroid()) 'via': 'app',
          if (privilegeWarning != null) 'privilegeWarning': privilegeWarning,
        },
        message: timedOut ? 'Command timed out.' : null,
      );
    } catch (e) {
      return CommandOutcome.fail('Failed to run command: $e');
    }
  }

  // ── self-update ─────────────────────────────────────────────────────────--

  /// Install a (already-pushed) APK to silently update the companion itself —
  /// the device half of Talon's remote self-update.
  ///
  /// The connection-survival trick: this is paired with the mesh foreground
  /// service's `autoRunOnMyPackageReplaced` flag. `pm install -r` kills the
  /// app to replace it, then Android broadcasts MY_PACKAGE_REPLACED and the
  /// service (hence the whole mesh loop) auto-restarts and reconnects — so a
  /// remote update drops the link only for the couple of seconds the process
  /// is being swapped, with no manual reopen.
  ///
  /// Two things make it robust:
  ///   1. It requires Shizuku (shell/ADB UID). The app UID cannot install a
  ///      package without a user tapping through PackageInstaller, which a
  ///      headless mesh command can't do.
  ///   2. The actual `pm install` runs DETACHED (setsid) after a short delay,
  ///      so this command can post its "staged" ack over the mesh BEFORE pm
  ///      tears the app down, and the install still completes even though the
  ///      app process dies mid-way (its parent is the Shizuku server, not us).
  ///
  /// `pm install -r` also refuses a differently-signed APK, so a wrong or
  /// tampered file can't hijack the app — it just fails the reinstall.
  Future<CommandOutcome> installApk(
    String path, {
    String? sha256,
    int? delayMs,
  }) async {
    if (!_isAndroid()) {
      return CommandOutcome.fail('install_apk is only supported on Android.');
    }
    if (path.isEmpty) return CommandOutcome.fail('No APK path given.');
    final file = File(path);
    if (!await file.exists()) {
      return CommandOutcome.fail('No such APK on device: $path');
    }
    if (!await ensureShizukuReady()) {
      return CommandOutcome.fail(
        'Silent install needs Shizuku (state=${_lastShizukuState ?? 'unavailable'}). '
        'Install Shizuku, grant Talon permission, and retry.',
      );
    }
    // Integrity gate: verify the pushed bytes match what the daemon sent
    // BEFORE handing the file to pm — a truncated transfer must never be
    // installed. Uses the elevated shell's sha256sum rather than pulling in a
    // Dart crypto dependency.
    if (sha256 != null && sha256.isNotEmpty) {
      try {
        final check = await _shizukuExec('sha256sum ${_shQuote(path)}', 30000);
        final line = '${check?['stdout'] ?? ''}'.trim();
        final digest = line.isEmpty ? '' : line.split(RegExp(r'\s+')).first;
        if (digest.isEmpty) {
          return CommandOutcome.fail('Could not hash the APK for verification.');
        }
        if (digest.toLowerCase() != sha256.toLowerCase()) {
          return CommandOutcome.fail(
            'APK integrity check failed: expected $sha256, got $digest. '
            'Aborting install.',
          );
        }
      } catch (e) {
        return CommandOutcome.fail('APK verification failed: $e');
      }
    }
    final delay = (delayMs ?? 3000).clamp(0, 30000);
    final sleepSecs = (delay / 1000).ceil();
    final logPath = '${file.parent.path}/talon-install.log';
    // Detached worker: sleep (let the ack flush), then reinstall keeping data
    // (-r) allowing same-or-newer versions (-d), logging the outcome.
    final worker = 'sleep $sleepSecs; '
        'pm install -r -d ${_shQuote(path)} > ${_shQuote(logPath)} 2>&1; '
        'echo "exit=\$?" >> ${_shQuote(logPath)}';
    try {
      await _shizukuExec(
        'setsid sh -c ${_shQuote(worker)} >/dev/null 2>&1 &',
        5000,
      );
    } catch (e) {
      return CommandOutcome.fail('Failed to stage the install: $e');
    }
    return CommandOutcome(
      ok: true,
      message: 'Update staged — installing in ${sleepSecs}s, then the app '
          'restarts and the mesh reconnects automatically.',
      data: {
        'staged': true,
        'delayMs': delay,
        'log': logPath,
        'via': 'shizuku',
      },
    );
  }

  Future<Map<String, dynamic>?> _shizukuExec(String cmd, int timeoutMs) =>
      _shizuku.invokeMapMethod<String, dynamic>('exec', {
        'cmd': cmd,
        'timeoutMs': timeoutMs,
      });

  /// POSIX single-quote a string for safe interpolation into a shell command.
  static String _shQuote(String s) => "'${s.replaceAll("'", "'\\''")}'";

  // ── filesystem ────────────────────────────────────────────────────────────

  Future<CommandOutcome> readFile(String path,
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
      entries
          .sort((a, b) => (a['name'] as String).compareTo(b['name'] as String));
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
    if (from.isEmpty || to.isEmpty) {
      return CommandOutcome.fail('from/to required.');
    }
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
  static int? _int(dynamic v) =>
      v is num ? v.toInt() : (v is String ? int.tryParse(v) : null);
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

/// Bounded exec-output collector: keeps the head and a rolling tail, counts
/// what it elides. The tail is load-bearing — the daemon's teleport wrapper
/// emits its cwd marker as the LAST bytes of stdout.
class _CappedOutput {
  final StringBuffer _head = StringBuffer();
  String _tail = '';
  int _dropped = 0;

  void add(String chunk) {
    var rest = chunk;
    final room = DeviceExec._execOutputHeadBytes - _head.length;
    if (room > 0) {
      if (rest.length <= room) {
        _head.write(rest);
        return;
      }
      _head.write(rest.substring(0, room));
      rest = rest.substring(room);
    }
    _tail = _tail + rest;
    if (_tail.length > DeviceExec._execOutputTailBytes) {
      _dropped += _tail.length - DeviceExec._execOutputTailBytes;
      _tail = _tail.substring(_tail.length - DeviceExec._execOutputTailBytes);
    }
  }

  String value() {
    if (_tail.isEmpty) return _head.toString();
    final note = _dropped > 0 ? '\n…[$_dropped chars truncated]…\n' : '';
    return '$_head$note$_tail';
  }

  /// One-shot clamp for output that already arrived as a single string
  /// (the Shizuku channel hands the whole result over at once).
  static String clamp(String s) {
    final out = _CappedOutput()..add(s);
    return out.value();
  }
}
