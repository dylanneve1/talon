import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'bridge_client.dart';
import 'log.dart';
import 'mesh_service.dart';
import 'prefs.dart';

/// Android background mesh: the foreground service owns the ENTIRE mesh loop.
///
/// Historically the foreground service only existed to keep the process alive
/// (its task handler was empty) while the real mesh — the SSE subscription,
/// registration heartbeat, and command handling — ran in the UI isolate. That
/// meant the mesh only worked as long as the activity's Flutter engine lived:
/// swipe the app away (or let the OS reclaim the activity under memory
/// pressure / Doze) and the notification stayed up while teleport, exec,
/// locate, and file transfer silently died.
///
/// Now the roles are inverted. The foreground service's own isolate runs a
/// full [MeshService] with its own [BridgeClient] (SSE + reconnect/backoff),
/// so device commands keep answering with the UI long gone — after a task
/// swipe, a UI engine death, a crash-restart (the plugin's START_STICKY +
/// restart alarm), or a reboot (autoRunOnBoot). The UI isolate no longer runs
/// a mesh loop on Android at all (see AppState) — one isolate, one mesh, no
/// duplicated command execution.
///
/// The UI isolate talks to this isolate with [MeshForegroundController]:
/// start/stop the service to mirror the mesh-sharing pref, and poke
/// [MeshForegroundController.msgReconfigure] through `sendDataToTask` whenever
/// prefs or the connection profile change, so the runner re-reads
/// SharedPreferences (each isolate has its own cache) and reconnects.

/// Entry point executed inside the foreground service's Flutter engine.
@pragma('vm:entry-point')
void startMeshForegroundCallback() {
  FlutterForegroundTask.setTaskHandler(MeshTaskHandler());
}

/// Task handler: delegates to a [MeshBackgroundRunner] for the whole service
/// lifetime. The 60s repeat event doubles as a connection watchdog.
class MeshTaskHandler extends TaskHandler {
  MeshBackgroundRunner? _runner;

  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {
    AppLog.info('mesh_bg', 'foreground mesh starting (${starter.name})');
    final runner = MeshBackgroundRunner();
    _runner = runner;
    await runner.start();
  }

  @override
  void onRepeatEvent(DateTime timestamp) {
    _runner?.watchdog();
  }

  @override
  void onReceiveData(Object data) {
    if (data == MeshForegroundController.msgReconfigure) {
      unawaited(_runner?.reconfigure());
    }
  }

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {
    AppLog.info('mesh_bg', 'foreground mesh stopping (timeout=$isTimeout)');
    await _runner?.dispose();
    _runner = null;
  }
}

/// Owns the background isolate's bridge connection and mesh loop:
/// prefs → BridgeClient → MeshService, plus SSE reconnection with backoff
/// (the same duty AppState performs for the UI's own connection).
class MeshBackgroundRunner {
  Prefs? _prefs;
  BridgeClient? _client;
  MeshService? _mesh;
  StreamSubscription<Map<String, dynamic>>? _drops;
  Timer? _retry;
  bool _connecting = false;
  bool _connected = false;
  bool _disposed = false;
  int _backoffMs = _initialBackoffMs;
  int? _lastRegisteredAtMs;

  static const int _initialBackoffMs = 2000;
  static const int _maxBackoffMs = 60000;

  Future<void> start() async {
    final prefs = await Prefs.load();
    _prefs = prefs;
    final client = BridgeClient(prefs.connection);
    _client = client;
    _mesh = MeshService(prefs, client, onRegistered: _stampAlive);
    // BridgeClient surfaces stream drops as errors on [events]; the mesh's
    // own subscription only consumes data events, so watch errors here.
    _drops = client.events.listen(
      (_) {},
      onError: (Object e) {
        if (_disposed) return;
        _connected = false;
        _scheduleReconnect();
      },
    );
    await _startMesh();
    await _connect();
  }

  /// (Re)start the mesh loop: registers with the daemon and (re)subscribes to
  /// command events. Registration is plain HTTP — tolerate an unreachable
  /// bridge; MeshService's 60s heartbeat and our reconnect loop both retry.
  Future<void> _startMesh() async {
    try {
      await _mesh?.start();
    } catch (e) {
      AppLog.warn('mesh_bg', 'mesh start failed (will retry)', e);
    }
  }

  /// Open the SSE stream (commands arrive over it) and refresh registration
  /// so the daemon flips this device online immediately.
  Future<void> _connect() async {
    if (_disposed || _connecting) return;
    final prefs = _prefs;
    final client = _client;
    if (prefs == null || client == null || !prefs.meshSharing) return;
    _connecting = true;
    try {
      await client.connect();
      _connected = true;
      _backoffMs = _initialBackoffMs;
      await _registerHealthy();
      AppLog.info('mesh_bg', 'bridge connected, mesh registered');
    } catch (e) {
      AppLog.warn('mesh_bg', 'bridge connect failed', e);
      _connected = false;
      _scheduleReconnect();
    } finally {
      _connecting = false;
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _retry?.cancel();
    final delay = _backoffMs;
    _backoffMs =
        (_backoffMs * 1.7).clamp(_initialBackoffMs, _maxBackoffMs).toInt();
    AppLog.info('mesh_bg', 'reconnect in ${delay}ms');
    _retry = Timer(Duration(milliseconds: delay), () => unawaited(_connect()));
  }

  Future<void> _registerHealthy() async {
    await _mesh?.register();
    _lastRegisteredAtMs = DateTime.now().millisecondsSinceEpoch;
    await _stampAlive();
  }

  Future<void> _stampAlive() async {
    final prefs = _prefs;
    if (prefs == null || !prefs.meshSharing) return;
    await prefs.setMeshBgAliveAt(DateTime.now().millisecondsSinceEpoch);
  }

  /// 60s watchdog (the foreground task's repeat event): keep registration
  /// fresh and reconnect with backoff when either SSE or registration stalls.
  void watchdog() {
    if (_disposed || _connecting) return;
    if (_connected) {
      unawaited(_watchdogRegister());
      return;
    }
    _retry?.cancel();
    unawaited(_connect());
  }

  Future<void> _watchdogRegister() async {
    try {
      await _registerHealthy();
    } catch (e) {
      AppLog.warn('mesh_bg', 'watchdog registration failed', e);
      _connected = false;
      _scheduleReconnect();
      return;
    }
    final last = _lastRegisteredAtMs;
    if (last == null) return;
    final ageMs = DateTime.now().millisecondsSinceEpoch - last;
    if (ageMs > MeshForegroundController.staleAliveAfter.inMilliseconds) {
      AppLog.warn('mesh_bg', 'registration watchdog stale (${ageMs}ms)');
      _connected = false;
      _scheduleReconnect();
    }
  }

  /// The UI isolate changed mesh prefs or the connection profile. Re-read
  /// SharedPreferences from disk (this isolate has its own stale cache),
  /// apply the (possibly new) endpoint, and restart the loop.
  Future<void> reconfigure() async {
    if (_disposed) return;
    final prefs = _prefs;
    if (prefs == null) return;
    await prefs.reload();
    _client?.config = prefs.connection;
    _retry?.cancel();
    _connected = false;
    _backoffMs = _initialBackoffMs;
    await _startMesh(); // re-advertises capabilities; idles if sharing is off
    await _connect();
  }

  Future<void> dispose() async {
    _disposed = true;
    _retry?.cancel();
    _retry = null;
    await _mesh?.stop();
    await _drops?.cancel();
    _client?.dispose();
  }
}

enum MeshForegroundHealthKind { off, unsupported, starting, healthy, stale }

class MeshForegroundHealth {
  final MeshForegroundHealthKind kind;
  final int? aliveAgeMs;
  final int? startedAgeMs;

  const MeshForegroundHealth({
    required this.kind,
    this.aliveAgeMs,
    this.startedAgeMs,
  });

  bool get shouldBounce => kind == MeshForegroundHealthKind.stale;

  String get label {
    switch (kind) {
      case MeshForegroundHealthKind.off:
        return 'background mesh off';
      case MeshForegroundHealthKind.unsupported:
        return 'background service unavailable';
      case MeshForegroundHealthKind.starting:
        return 'background mesh starting';
      case MeshForegroundHealthKind.healthy:
        final age = aliveAgeMs;
        return age == null
            ? 'background mesh healthy'
            : 'background mesh healthy, last alive ${_formatAge(age)} ago';
      case MeshForegroundHealthKind.stale:
        final age = aliveAgeMs;
        return age == null
            ? 'background mesh stale - restarting'
            : 'background mesh stale - last alive ${_formatAge(age)} ago';
    }
  }

  static String _formatAge(int ageMs) {
    final seconds = (ageMs / 1000).round();
    if (seconds < 60) return '${seconds}s';
    final minutes = (seconds / 60).round();
    if (minutes < 60) return '${minutes}m';
    return '${(minutes / 60).round()}h';
  }
}

MeshForegroundHealth evaluateMeshForegroundHealth({
  required bool supported,
  required bool sharingEnabled,
  required bool serviceRunning,
  required int nowMs,
  required int? aliveAtMs,
  required int? startedAtMs,
  Duration staleAfter = MeshForegroundController.staleAliveAfter,
  Duration startGrace = MeshForegroundController.startGrace,
}) {
  if (!supported) {
    return const MeshForegroundHealth(
      kind: MeshForegroundHealthKind.unsupported,
    );
  }
  if (!sharingEnabled || !serviceRunning) {
    return const MeshForegroundHealth(kind: MeshForegroundHealthKind.off);
  }
  final startedAge = startedAtMs == null ? null : nowMs - startedAtMs;
  if (startedAge != null &&
      startedAge >= 0 &&
      startedAge < startGrace.inMilliseconds) {
    return MeshForegroundHealth(
      kind: MeshForegroundHealthKind.starting,
      aliveAgeMs: aliveAtMs == null ? null : nowMs - aliveAtMs,
      startedAgeMs: startedAge,
    );
  }
  if (aliveAtMs == null) {
    return MeshForegroundHealth(
      kind: MeshForegroundHealthKind.stale,
      startedAgeMs: startedAge,
    );
  }
  final aliveAge = nowMs - aliveAtMs;
  if (aliveAge < 0 || aliveAge <= staleAfter.inMilliseconds) {
    return MeshForegroundHealth(
      kind: MeshForegroundHealthKind.healthy,
      aliveAgeMs: aliveAge.clamp(0, staleAfter.inMilliseconds),
      startedAgeMs: startedAge,
    );
  }
  return MeshForegroundHealth(
    kind: MeshForegroundHealthKind.stale,
    aliveAgeMs: aliveAge,
    startedAgeMs: startedAge,
  );
}

/// UI-isolate façade for the Android foreground mesh service. All methods are
/// safe no-ops off Android.
class MeshForegroundController {
  MeshForegroundController._();

  /// Data message poking the task isolate to reload prefs and reconnect.
  static const String msgReconfigure = 'mesh.reconfigure.v1';
  static const Duration staleAliveAfter = Duration(seconds: 90);
  static const Duration startGrace = Duration(seconds: 20);

  static bool get isSupported => !kIsWeb && Platform.isAndroid;

  /// Mirror the mesh-sharing pref: service running iff sharing is on. When
  /// already running, forwards a reconfigure poke instead so the runner picks
  /// up pref/connection changes without a service bounce.
  static Future<bool> syncFromPrefs(Prefs prefs) async {
    if (!isSupported) return false;
    await prefs.reload();
    if (!prefs.meshSharing) {
      await stop();
      return false;
    }
    if (await FlutterForegroundTask.isRunningService) {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: prefs.meshSharing,
        serviceRunning: true,
        nowMs: DateTime.now().millisecondsSinceEpoch,
        aliveAtMs: prefs.meshBgAliveAt,
        startedAtMs: prefs.meshBgStartedAt,
      );
      if (health.shouldBounce) {
        AppLog.warn('mesh_bg', '${health.label}; bouncing service');
        final stopped = await _stopRunning();
        if (!stopped) return false;
        return _start();
      }
      notifyReconfigure();
      return true;
    }
    return _start();
  }

  static Future<bool> _start() async {
    final notificationPermission =
        await FlutterForegroundTask.checkNotificationPermission();
    if (notificationPermission != NotificationPermission.granted) {
      await FlutterForegroundTask.requestNotificationPermission();
    }
    // Doze/App-Standby aggressively defer network for "optimized" apps —
    // exactly the state where a mesh command would time out. Ask once for
    // the exemption; the system remembers the answer.
    if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
      await FlutterForegroundTask.requestIgnoreBatteryOptimization();
    }
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'talon_mesh',
        channelName: 'Talon mesh',
        channelDescription:
            'Keeps the Talon mesh connected for locate, teleport, and '
            'file transfer.',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
        onlyAlertOnce: true,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        // Drives MeshTaskHandler.onRepeatEvent — the connection watchdog.
        eventAction: ForegroundTaskEventAction.repeat(60000),
        autoRunOnBoot: true,
        autoRunOnMyPackageReplaced: true,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
    final prefs = await Prefs.load();
    await prefs.setMeshBgStartedAt(DateTime.now().millisecondsSinceEpoch);
    final result = await FlutterForegroundTask.startService(
      // dataSync: the long-lived SSE stream + exec/file-transfer traffic.
      // location: on-demand locate fixes while backgrounded.
      serviceTypes: const [
        ForegroundServiceTypes.dataSync,
        ForegroundServiceTypes.location,
      ],
      notificationTitle: 'Talon mesh active',
      notificationText: 'Connected for locate, teleport, and file transfer.',
      callback: startMeshForegroundCallback,
    );
    switch (result) {
      case ServiceRequestSuccess():
        return true;
      case ServiceRequestFailure(:final error):
        AppLog.warn('mesh_bg', 'foreground service start failed', error);
        return false;
    }
  }

  static Future<bool> stop() async {
    if (!isSupported) return false;
    if (await FlutterForegroundTask.isRunningService) {
      return _stopRunning();
    }
    return true;
  }

  static Future<bool> _stopRunning() async {
    final result = await FlutterForegroundTask.stopService();
    switch (result) {
      case ServiceRequestSuccess():
        return true;
      case ServiceRequestFailure(:final error):
        AppLog.warn('mesh_bg', 'foreground service stop failed', error);
        return false;
    }
  }

  static Future<MeshForegroundHealth> healthFromPrefs(Prefs prefs) async {
    if (!isSupported) {
      return evaluateMeshForegroundHealth(
        supported: false,
        sharingEnabled: prefs.meshSharing,
        serviceRunning: false,
        nowMs: DateTime.now().millisecondsSinceEpoch,
        aliveAtMs: null,
        startedAtMs: null,
      );
    }
    await prefs.reload();
    final running = await FlutterForegroundTask.isRunningService;
    return evaluateMeshForegroundHealth(
      supported: true,
      sharingEnabled: prefs.meshSharing,
      serviceRunning: running,
      nowMs: DateTime.now().millisecondsSinceEpoch,
      aliveAtMs: prefs.meshBgAliveAt,
      startedAtMs: prefs.meshBgStartedAt,
    );
  }

  /// Fire-and-forget poke; the runner re-reads prefs and reconnects. Silently
  /// harmless when the service isn't up (nothing is listening).
  static void notifyReconfigure() {
    if (!isSupported) return;
    try {
      FlutterForegroundTask.sendDataToTask(msgReconfigure);
    } catch (e) {
      AppLog.warn('mesh_bg', 'reconfigure poke failed', e);
    }
  }
}
