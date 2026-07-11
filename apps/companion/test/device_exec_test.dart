import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/device_exec.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory tmp;
  final exec = DeviceExec();

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('talon-exec-');
  });
  tearDown(() async {
    if (await tmp.exists()) await tmp.delete(recursive: true);
  });

  test('runs a shell command and captures stdout + exit code', () async {
    final r = await exec.exec('echo hello-device');
    expect(r.ok, isTrue);
    expect(r.data!['stdout'], contains('hello-device'));
    expect(r.data!['exitCode'], 0);
  });

  test('reports a non-zero exit', () async {
    final r = await exec.exec('exit 7');
    expect(r.ok, isFalse);
    expect(r.data!['exitCode'], 7);
  });

  test('a backgrounded child does not pin the exec open (pipe-drain grace)',
      () async {
    // The shell exits immediately; the orphaned `sleep` inherits stdout and
    // holds the pipe open for 30s. Before the drain grace, this call hung
    // until the mesh transport gave up — persistent streams (adb logcat &)
    // were impossible to launch.
    final sw = Stopwatch()..start();
    final r = await exec.exec('sleep 30 > /dev/null 2>&1 & echo bg-started');
    sw.stop();
    expect(r.ok, isTrue);
    expect(r.data!['stdout'], contains('bg-started'));
    expect(r.data!['exitCode'], 0);
    // Well under the old hang (bounded by exit + the 2s drain grace).
    expect(sw.elapsed, lessThan(const Duration(seconds: 10)));
  });

  test('shell invocation matches the platform terminal', () {
    expect(
      DeviceExec.shellInvocation('echo x', os: 'windows'),
      ['cmd', '/c', 'echo x'],
    );
    // macOS is a *login* zsh so the user's real PATH (Homebrew etc.) applies.
    expect(
      DeviceExec.shellInvocation('echo x', os: 'macos'),
      ['/bin/zsh', '-l', '-c', 'echo x'],
    );
    expect(
      DeviceExec.shellInvocation('echo x', os: 'linux'),
      ['sh', '-c', 'echo x'],
    );
    expect(
      DeviceExec.shellInvocation('echo x', os: 'android'),
      ['sh', '-c', 'echo x'],
    );
  });

  test('uses Shizuku only after the permission callback verifies readiness',
      () async {
    const channel = MethodChannel('talon/shizuku-test-ready');
    var ready = false;
    var permissionRequests = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'getStatus':
          return {
            'ready': ready,
            'state': ready ? 'ready' : 'permission-needed'
          };
        case 'requestPermission':
          permissionRequests++;
          ready = true;
          return true;
        case 'exec':
          return {'stdout': 'shell', 'stderr': '', 'exitCode': 0};
      }
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    final elevated = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
    final result = await elevated.exec('id');

    expect(permissionRequests, 1);
    expect(result.ok, isTrue);
    expect(result.data!['via'], 'shizuku');
    expect(result.data!['stdout'], 'shell');
  });

  test('marks app-UID results as limited when Shizuku is unavailable',
      () async {
    const channel = MethodChannel('talon/shizuku-test-unavailable');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'getStatus') {
        return {'ready': false, 'state': 'not-running'};
      }
      if (call.method == 'requestPermission') return false;
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    final limited = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
    final result = await limited.exec('printf app');

    expect(result.ok, isTrue);
    expect(result.data!['via'], 'app');
    // The fallback warning surfaces the actual Shizuku state (why it wasn't
    // used) so a remote caller can diagnose without adb.
    expect(result.data!['privilegeWarning'], contains('state=not-running'));
    expect(result.data!['privilegeWarning'], contains('app UID'));
  });

  test('caps runaway exec output but keeps the tail (cwd marker survives)',
      () async {
    // 400KB of noise then a trailing marker — like the teleport wrapper's
    // cwd marker, which is always the LAST bytes of stdout. The cap must
    // elide the middle, never the tail.
    final r = await exec.exec(
      "dd if=/dev/zero bs=1024 count=400 2>/dev/null | tr '\\0' x; "
      'printf TALON_TAIL_MARKER',
    );
    expect(r.ok, isTrue);
    final stdout = r.data!['stdout'] as String;
    expect(stdout.length, lessThan(300 * 1024));
    expect(stdout, contains('chars truncated'));
    expect(stdout, endsWith('TALON_TAIL_MARKER'));
  });

  test('desktop exec never consults Shizuku and stays unannotated', () async {
    const channel = MethodChannel('talon/shizuku-test-desktop');
    var channelCalls = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      channelCalls++;
      return null;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding
        .instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null));

    final desktop = DeviceExec(shizukuChannel: channel, isAndroid: () => false);
    final result = await desktop.exec('echo desktop');

    expect(channelCalls, 0);
    expect(result.ok, isTrue);
    expect(result.data!.containsKey('via'), isFalse);
    expect(result.data!.containsKey('privilegeWarning'), isFalse);
    expect(await desktop.privilegeStatus(), {'execPrivilege': 'user'});
  });

  test('writes then reads a file in chunks (base64 roundtrip)', () async {
    final f = '${tmp.path}/note.txt';
    final content = 'A' * (300 * 1024); // > one 256KB chunk
    // First chunk truncates, second appends.
    final first = utf8.encode(content.substring(0, 256 * 1024));
    final second = utf8.encode(content.substring(256 * 1024));
    final w1 =
        await exec.writeFile(f, base64Encode(first), offset: 0, truncate: true);
    expect(w1.ok, isTrue);
    final w2 = await exec.writeFile(f, base64Encode(second),
        offset: first.length, truncate: false);
    expect(w2.ok, isTrue);

    // Read back the first chunk and confirm eof=false, then final chunk.
    final r1 = await exec.readFile(f, offset: 0, len: 256 * 1024);
    expect(r1.ok, isTrue);
    expect(r1.data!['eof'], isFalse);
    final r2 = await exec.readFile(f, offset: 256 * 1024, len: 256 * 1024);
    expect(r2.data!['eof'], isTrue);
    expect(await File(f).length(), content.length);
  });

  test('rejects an out-of-order or duplicate chunk instead of appending',
      () async {
    final f = '${tmp.path}/ordered.txt';
    final w1 = await exec.writeFile(f, base64Encode(utf8.encode('hello ')),
        offset: 0, truncate: true);
    expect(w1.ok, isTrue);

    // Duplicate retry of the first chunk (offset 0 again) must not append.
    final dup = await exec.writeFile(f, base64Encode(utf8.encode('hello ')),
        offset: 0, truncate: false);
    expect(dup.ok, isFalse);
    expect(dup.message, contains('out-of-order'));

    // A gap (offset beyond current size) must be rejected too.
    final gap = await exec.writeFile(f, base64Encode(utf8.encode('!')),
        offset: 100, truncate: false);
    expect(gap.ok, isFalse);

    // The correctly-ordered chunk still lands.
    final w2 = await exec.writeFile(f, base64Encode(utf8.encode('world')),
        offset: 6, truncate: false);
    expect(w2.ok, isTrue);
    expect(await File(f).readAsString(), 'hello world');
  });

  test('lists a directory and stats a file', () async {
    await File('${tmp.path}/a.txt').writeAsString('hi');
    await Directory('${tmp.path}/sub').create();
    final ls = await exec.listDir(tmp.path);
    expect(ls.ok, isTrue);
    final names = (ls.data!['entries'] as List).map((e) => e['name']).toList();
    expect(names, containsAll(['a.txt', 'sub']));

    final st = await exec.statPath('${tmp.path}/a.txt');
    expect(st.ok, isTrue);
    expect(st.data!['type'], 'file');
    expect(st.data!['size'], 2);
  });

  test('handle() dispatches by command name and ignores unknown', () async {
    final ok = await exec.handle('exec', {'cmd': 'echo x'});
    expect(ok, isNotNull);
    expect(ok!.ok, isTrue);
    final unknown = await exec.handle('teleport_home', {});
    expect(unknown, isNull);
  });

  group('install_apk', () {
    test('is refused on non-Android platforms', () async {
      final desktop = DeviceExec(isAndroid: () => false);
      final r = await desktop.installApk('${tmp.path}/app.apk');
      expect(r.ok, isFalse);
      expect(r.message, contains('only supported on Android'));
    });

    test('fails clearly when Shizuku is unavailable', () async {
      const channel = MethodChannel('talon/shizuku-install-noshizuku');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'getStatus') {
          return {'ready': false, 'state': 'not-running'};
        }
        if (call.method == 'requestPermission') return false;
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));

      final apk = File('${tmp.path}/app.apk')..writeAsStringSync('fake-apk');
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk(apk.path);
      expect(r.ok, isFalse);
      expect(r.message, contains('Shizuku'));
    });

    test('aborts on a sha256 mismatch before touching pm', () async {
      const channel = MethodChannel('talon/shizuku-install-badhash');
      final execCmds = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'getStatus') {
          return {'ready': true, 'state': 'ready'};
        }
        if (call.method == 'exec') {
          final cmd = (call.arguments as Map)['cmd'] as String;
          execCmds.add(cmd);
          if (cmd.startsWith('test -f')) {
            return {'stdout': 'ok', 'stderr': '', 'exitCode': 0};
          }
          // cp succeeds; sha256sum returns a digest that won't match.
          return {
            'stdout': 'deadbeef  /data/local/tmp/talon-companion-update.apk',
            'stderr': '',
            'exitCode': 0,
          };
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));

      final apk = File('${tmp.path}/app.apk')..writeAsStringSync('fake-apk');
      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk(apk.path, sha256: 'cafebabe');
      expect(r.ok, isFalse);
      expect(r.message, contains('integrity check failed'));
      // Only the hash check ran — pm install must NOT have been staged.
      expect(execCmds.any((c) => c.contains('pm install')), isFalse);
    });

    test('stages a detached pm install when hash matches', () async {
      const channel = MethodChannel('talon/shizuku-install-ok');
      final execCmds = <String>[];
      final apk = File('${tmp.path}/app.apk')..writeAsStringSync('fake-apk');
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'getStatus') {
          return {'ready': true, 'state': 'ready'};
        }
        if (call.method == 'exec') {
          final cmd = (call.arguments as Map)['cmd'] as String;
          execCmds.add(cmd);
          if (cmd.startsWith('test -f')) {
            return {'stdout': 'ok', 'stderr': '', 'exitCode': 0};
          }
          if (cmd.startsWith('sha256sum')) {
            return {
              'stdout': 'abc123  /data/local/tmp/talon-companion-update.apk',
              'stderr': '',
              'exitCode': 0,
            };
          }
          return {'stdout': '', 'stderr': '', 'exitCode': 0};
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));

      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk(apk.path, sha256: 'ABC123', delayMs: 1000);
      expect(r.ok, isTrue);
      expect(r.data!['staged'], isTrue);
      expect(r.data!['via'], 'shizuku');
      expect(
          r.data!['stagedPath'], '/data/local/tmp/talon-companion-update.apk');
      // pm cannot read app-FUSE paths (/sdcard), so the APK must be re-staged
      // into /data/local/tmp and hashed THERE (the file pm actually reads).
      expect(
        execCmds.any((c) =>
            c.startsWith('cp -f') &&
            c.contains('/data/local/tmp/talon-companion-update.apk')),
        isTrue,
      );
      expect(
        execCmds.any((c) =>
            c.startsWith('sha256sum') && c.contains('/data/local/tmp/')),
        isTrue,
      );
      // The install is detached (setsid + background) so the ack flushes and
      // the install survives the app being replaced.
      final install =
          execCmds.firstWhere((c) => c.contains('pm install'), orElse: () => '');
      expect(install, contains('setsid'));
      expect(install, contains('pm install -r -d'));
      expect(install, contains('/data/local/tmp/talon-companion-update.apk'));
      // The staged copy is cleaned up after the install…
      expect(install, contains('rm -f'));
    });

    test('skips the copy when the APK is already in /data/local/tmp',
        () async {
      const channel = MethodChannel('talon/shizuku-install-tmp');
      final execCmds = <String>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
        if (call.method == 'getStatus') {
          return {'ready': true, 'state': 'ready'};
        }
        if (call.method == 'exec') {
          final cmd = (call.arguments as Map)['cmd'] as String;
          execCmds.add(cmd);
          if (cmd.startsWith('test -f')) {
            return {'stdout': 'ok', 'stderr': '', 'exitCode': 0};
          }
          return {'stdout': '', 'stderr': '', 'exitCode': 0};
        }
        return null;
      });
      addTearDown(() => TestDefaultBinaryMessengerBinding
          .instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null));

      final dev = DeviceExec(shizukuChannel: channel, isAndroid: () => true);
      final r = await dev.installApk('/data/local/tmp/talon.apk');
      expect(r.ok, isTrue);
      expect(r.data!['stagedPath'], '/data/local/tmp/talon.apk');
      expect(execCmds.any((c) => c.startsWith('cp -f')), isFalse);
      final install =
          execCmds.firstWhere((c) => c.contains('pm install'), orElse: () => '');
      expect(install, contains('/data/local/tmp/talon.apk'));
      // …but a pre-existing original is never deleted (retry without re-push).
      expect(install.contains('rm -f'), isFalse);
    });

    test('routes through handle() by name', () async {
      final desktop = DeviceExec(isAndroid: () => false);
      final r = await desktop.handle('install_apk', {'path': '/x/app.apk'});
      expect(r, isNotNull);
      expect(r!.ok, isFalse); // non-Android → refused, but dispatched
    });
  });
}
