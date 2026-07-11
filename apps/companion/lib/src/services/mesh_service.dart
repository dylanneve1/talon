import 'dart:async';
import 'dart:io' show Directory, File, Platform;

import 'package:battery_plus/battery_plus.dart';
import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:uuid/uuid.dart';

import 'bridge_client.dart';
import 'device_exec.dart';
import 'log.dart';
import 'prefs.dart';

class MeshBattery {
  final int? percent;
  final bool? charging;
  const MeshBattery({this.percent, this.charging});
}

class MeshFix {
  final double lat;
  final double lon;
  final double? accuracyM;
  final double? altitudeM;
  final double? speedMps;
  final double? headingDeg;
  final int ts;
  final String provider;

  const MeshFix({
    required this.lat,
    required this.lon,
    required this.ts,
    this.accuracyM,
    this.altitudeM,
    this.speedMps,
    this.headingDeg,
    this.provider = 'geolocator',
  });
}

typedef MeshLocationProvider = Future<MeshFix?> Function();
typedef MeshBatteryProvider = Future<MeshBattery> Function();
typedef MeshNameProvider = Future<String> Function();
typedef MeshVersionProvider = Future<String> Function();
typedef ForegroundStarter = Future<void> Function();
typedef MeshRingHandler = Future<void> Function(String? message);
typedef MeshRegisteredCallback = Future<void> Function();

/// Extra device intelligence merged into the `status` command's payload
/// (hardware model, OS, locale, timezone, network, …).
typedef MeshSystemInfoProvider = Future<Map<String, String>> Function();

class MeshService {
  /// Base commands every build can execute, advertised at registration so the
  /// daemon can refuse unsupported commands with a clear message instead of
  /// timing out. Exec/filesystem commands are appended when device control is
  /// enabled (see [capabilitiesFor]).
  static const List<String> capabilities = ['locate', 'ring', 'status'];

  /// Streamed file-transfer commands: ONE command round trip arranges the
  /// transfer, then the file body moves as a single raw HTTP request via
  /// BridgeClient.uploadFile/downloadFile — replacing the chunked command
  /// channel (a full mesh round trip per chunk) for file bodies.
  static const List<String> transferCapabilities = [
    'upload_file',
    'download_file',
  ];

  /// Advertised capabilities for the current prefs — adds the exec/fs surface
  /// (DeviceExec) and streamed transfers when device control is enabled.
  static List<String> capabilitiesFor(Prefs prefs) => [
    ...capabilities,
    if (prefs.meshDeviceControl) ...DeviceExec.capabilities,
    if (prefs.meshDeviceControl) ...transferCapabilities,
  ];

  final Prefs prefs;
  final BridgeClient client;
  final DeviceExec _exec;
  final MeshLocationProvider _locationProvider;
  final MeshBatteryProvider _batteryProvider;
  final MeshNameProvider _nameProvider;
  final MeshVersionProvider _versionProvider;
  final ForegroundStarter _foregroundStarter;
  final MeshRingHandler _ringHandler;
  final MeshSystemInfoProvider _systemInfoProvider;
  final MeshRegisteredCallback? _onRegistered;

  StreamSubscription<Map<String, dynamic>>? _events;
  Timer? _heartbeat;
  Timer? _periodic;
  bool _running = false;

  MeshService(
    this.prefs,
    this.client, {
    MeshLocationProvider? locationProvider,
    MeshBatteryProvider? batteryProvider,
    MeshNameProvider? nameProvider,
    MeshVersionProvider? versionProvider,
    ForegroundStarter? foregroundStarter,
    MeshRingHandler? ringHandler,
    MeshSystemInfoProvider? systemInfoProvider,
    DeviceExec? deviceExec,
    MeshRegisteredCallback? onRegistered,
  }) : _locationProvider = locationProvider ?? _defaultLocation,
       _batteryProvider = batteryProvider ?? _defaultBattery,
       _nameProvider = nameProvider ?? _defaultName,
       _versionProvider = versionProvider ?? _defaultVersion,
       _foregroundStarter = foregroundStarter ?? _noopForeground,
       _ringHandler = ringHandler ?? _defaultRing,
       _systemInfoProvider = systemInfoProvider ?? _defaultSystemInfo,
       _onRegistered = onRegistered,
       _exec = deviceExec ?? DeviceExec();

  bool get running => _running;

  Future<String> deviceId() async {
    final existing = prefs.meshDeviceId;
    if (existing != null && existing.isNotEmpty) return existing;
    final id = const Uuid().v4();
    await prefs.setMeshDeviceId(id);
    return id;
  }

  Future<void> start() async {
    await stop();
    _running = true;
    if (!prefs.meshSharing) return;
    await _foregroundStarter();
    try {
      await register();
    } catch (e) {
      AppLog.warn('mesh', 'initial mesh registration failed', e);
    }
    _events = client.events.listen(
      (event) {
        if (event['kind'] == 'locate') unawaited(_handleLocate(event));
        if (event['kind'] == 'device_command') unawaited(_handleCommand(event));
      },
      // SSE drops surface as stream errors. Reconnection belongs to the
      // connection's owner (AppState / MeshBackgroundRunner); without this
      // handler every drop became an unhandled zone error in this
      // subscription.
      onError: (Object e) => AppLog.debug('mesh', 'event stream error', e),
    );
    _heartbeat = Timer.periodic(const Duration(seconds: 60), (_) {
      if (prefs.meshSharing) unawaited(register());
    });
    _configurePeriodic();
  }

  Future<void> stop() async {
    _running = false;
    await _events?.cancel();
    _events = null;
    _heartbeat?.cancel();
    _heartbeat = null;
    _periodic?.cancel();
    _periodic = null;
  }

  void reconfigure() {
    if (!_running) return;
    _configurePeriodic();
    if (prefs.meshSharing) unawaited(register());
  }

  Future<void> register() async {
    if (!prefs.meshSharing) return;
    final id = await deviceId();
    final battery = await _batteryProvider();
    await client.registerDevice({
      'id': id,
      'name': await _nameProvider(),
      'platform': _platform,
      'appVersion': await _versionProvider(),
      if (battery.percent != null) 'battery': battery.percent,
      if (battery.charging != null) 'charging': battery.charging,
      'capabilities': capabilitiesFor(prefs),
    });
    await _onRegistered?.call();
  }

  Future<void> sendOneFix() async {
    if (!prefs.meshSharing) return;
    final fix = await _locationProvider();
    if (fix == null) return;
    final battery = await _batteryProvider();
    await client.postLocation({
      'deviceId': await deviceId(),
      'lat': fix.lat,
      'lon': fix.lon,
      if (fix.accuracyM != null) 'accuracyM': fix.accuracyM,
      if (fix.altitudeM != null) 'altitudeM': fix.altitudeM,
      if (fix.speedMps != null) 'speedMps': fix.speedMps,
      if (fix.headingDeg != null) 'headingDeg': fix.headingDeg,
      'ts': fix.ts,
      'provider': fix.provider,
      if (battery.percent != null) 'batteryPct': battery.percent,
    });
  }

  Future<void> _handleLocate(Map<String, dynamic> event) async {
    final target = event['deviceId'];
    if (target is String && target.isNotEmpty && target != await deviceId()) {
      return;
    }
    try {
      await sendOneFix();
    } catch (e) {
      AppLog.warn('mesh', 'locate handling failed', e);
    }
  }

  /// Execute a `device_command` addressed to this device and answer over
  /// POST /devices/command-result with the command's correlation id. Every
  /// path answers — success, failure, or unsupported — so the daemon's
  /// pending tool call resolves instead of timing out.
  Future<void> _handleCommand(Map<String, dynamic> event) async {
    final id = event['id'];
    final target = event['deviceId'];
    if (id is! String || id.isEmpty) return;
    final myId = await deviceId();
    if (target is! String || target.isEmpty || target != myId) return;
    final name = event['name'] is String ? event['name'] as String : '';
    final params = event['params'] is Map
        ? (event['params'] as Map).cast<String, dynamic>()
        : <String, dynamic>{};

    var ok = false;
    String? message;
    Map<String, dynamic>? data;
    try {
      switch (name) {
        case 'locate':
          await sendOneFix();
          ok = true;
          message = 'Fresh fix reported.';
          break;
        case 'ring':
          final note = params['message'];
          await _ringHandler(note is String && note.isNotEmpty ? note : null);
          ok = true;
          break;
        case 'status':
          data = await _statusPayload();
          ok = true;
          break;
        case 'upload_file': // streamed pull: device → daemon, one HTTP POST
          if (!prefs.meshDeviceControl) {
            message = 'Device control is disabled on this device.';
            break;
          }
          final upToken = params['token'];
          final upPath = params['path'];
          if (upToken is! String || upToken.isEmpty || upPath is! String) {
            message = 'upload_file needs token and path.';
            break;
          }
          final src = File(upPath);
          if (!await src.exists()) {
            message = 'No such file: $upPath';
            break;
          }
          final sent = await client.uploadFile(
            upToken,
            src.openRead(),
            await src.length(),
          );
          ok = true;
          data = {'bytes': sent};
          break;
        case 'download_file': // streamed push: daemon → device, one HTTP GET
          if (!prefs.meshDeviceControl) {
            message = 'Device control is disabled on this device.';
            break;
          }
          final downToken = params['token'];
          final downPath = params['path'];
          if (downToken is! String ||
              downToken.isEmpty ||
              downPath is! String) {
            message = 'download_file needs token and path.';
            break;
          }
          final dest = File(downPath);
          await Directory(dest.parent.path).create(recursive: true);
          // Stream to a temp file and rename, so a dropped connection can't
          // leave a half-written destination.
          final part = File('$downPath.part');
          final sink = part.openWrite();
          int written;
          try {
            written = await client.downloadFile(downToken, (chunk) async {
              sink.add(chunk);
            });
            await sink.flush();
            await sink.close();
            await part.rename(downPath);
          } catch (e) {
            await sink.close().catchError((_) {});
            await part.delete().catchError((_) => part);
            rethrow;
          }
          ok = true;
          data = {'bytesWritten': written};
          break;
        default:
          // Exec/filesystem commands (the teleport substrate) — only when the
          // user has device control enabled.
          if (prefs.meshDeviceControl) {
            final outcome = await _exec.handle(name, params);
            if (outcome != null) {
              ok = outcome.ok;
              message = outcome.message;
              data = outcome.data;
              break;
            }
          }
          message = prefs.meshDeviceControl
              ? 'This app version does not support "$name".'
              : 'Device control is disabled on this device.';
      }
    } catch (e) {
      ok = false;
      message = 'Command failed on device: $e';
      AppLog.warn('mesh', 'device_command "$name" failed', e);
    }

    try {
      await client.postCommandResult({
        'commandId': id,
        'deviceId': myId,
        'ok': ok,
        if (message != null) 'message': message,
        if (data != null) 'data': data,
      });
    } catch (e) {
      AppLog.warn('mesh', 'command result post failed', e);
    }
  }

  Future<Map<String, dynamic>> _statusPayload() async {
    final battery = await _batteryProvider();
    Map<String, String> extras;
    try {
      extras = await _systemInfoProvider();
    } catch (_) {
      extras = const {};
    }
    Map<String, String> privilege;
    try {
      privilege = await _exec.privilegeStatus();
    } catch (_) {
      privilege = const {};
    }
    return {
      'name': await _nameProvider(),
      'platform': _platform,
      'appVersion': await _versionProvider(),
      if (battery.percent != null) 'battery': '${battery.percent}%',
      if (battery.charging != null)
        'charging': battery.charging! ? 'yes' : 'no',
      ...extras,
      ...privilege,
      'meshSharing': prefs.meshSharing ? 'on' : 'off',
      'periodicReporting': prefs.meshPeriodic
          ? 'every ${prefs.meshIntervalSeconds}s'
          : 'off',
    };
  }

  void _configurePeriodic() {
    _periodic?.cancel();
    _periodic = null;
    if (!prefs.meshSharing || !prefs.meshPeriodic) return;
    _periodic = Timer.periodic(
      Duration(seconds: prefs.meshIntervalSeconds),
      (_) => unawaited(sendOneFix()),
    );
  }

  static String get _platform {
    if (kIsWeb) return 'linux';
    if (Platform.isAndroid) return 'android';
    if (Platform.isIOS) return 'ios';
    if (Platform.isMacOS) return 'macos';
    if (Platform.isWindows) return 'windows';
    return 'linux';
  }

  static Future<MeshFix?> _defaultLocation() async {
    if (kIsWeb) return null;
    var serviceEnabled = await Geolocator.isLocationServiceEnabled();
    if (!serviceEnabled) return null;
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      return null;
    }
    if (Platform.isAndroid || Platform.isIOS) {
      final bg = await Geolocator.checkPermission();
      if (bg == LocationPermission.whileInUse) {
        await Geolocator.requestPermission();
      }
    }
    final pos = await Geolocator.getCurrentPosition(
      locationSettings: const LocationSettings(
        accuracy: LocationAccuracy.high,
        timeLimit: Duration(seconds: 15),
      ),
    );
    return MeshFix(
      lat: pos.latitude,
      lon: pos.longitude,
      accuracyM: pos.accuracy,
      altitudeM: pos.altitude,
      speedMps: pos.speed,
      headingDeg: pos.heading,
      ts: pos.timestamp.millisecondsSinceEpoch,
    );
  }

  static Future<MeshBattery> _defaultBattery() async {
    try {
      final battery = Battery();
      final level = await battery.batteryLevel;
      final state = await battery.batteryState;
      return MeshBattery(
        percent: level >= 0 ? level : null,
        charging: state == BatteryState.charging || state == BatteryState.full,
      );
    } catch (_) {
      return const MeshBattery();
    }
  }

  static Future<String> _defaultName() async {
    try {
      final info = DeviceInfoPlugin();
      if (!kIsWeb && Platform.isAndroid) {
        final d = await info.androidInfo;
        return '${d.manufacturer} ${d.model}'.trim();
      }
      if (!kIsWeb && Platform.isIOS) {
        final d = await info.iosInfo;
        return d.name;
      }
      if (!kIsWeb && Platform.isMacOS) {
        final d = await info.macOsInfo;
        return d.computerName;
      }
      if (!kIsWeb && Platform.isWindows) {
        final d = await info.windowsInfo;
        return d.computerName;
      }
      if (!kIsWeb && Platform.isLinux) {
        final d = await info.linuxInfo;
        return d.prettyName;
      }
    } catch (_) {
      /* fall through */
    }
    return 'Talon companion';
  }

  static Future<String> _defaultVersion() async {
    try {
      final info = await PackageInfo.fromPlatform();
      return '${info.version}+${info.buildNumber}';
    } catch (_) {
      return 'unknown';
    }
  }

  /// Best-effort find-my-device with no extra plugins: a burst of system
  /// alert sounds + vibration. Injectable so platforms can swap in a real
  /// ringtone implementation later.
  static Future<void> _defaultRing(String? message) async {
    for (var i = 0; i < 8; i++) {
      try {
        await SystemSound.play(SystemSoundType.alert);
        await HapticFeedback.vibrate();
      } catch (_) {
        /* headless/desktop platforms may lack one of the channels */
      }
      await Future<void>.delayed(const Duration(milliseconds: 450));
    }
  }

  /// Device intelligence for the `status` command: hardware identity, OS
  /// version, locale, timezone, and network connectivity. Every field is
  /// best-effort — one unavailable platform channel must not empty the rest.
  static Future<Map<String, String>> _defaultSystemInfo() async {
    final info = <String, String>{};
    if (!kIsWeb) {
      info['os'] =
          '${Platform.operatingSystem} ${Platform.operatingSystemVersion}';
      info['locale'] = Platform.localeName;
    }
    final now = DateTime.now();
    final offset = now.timeZoneOffset;
    final sign = offset.isNegative ? '-' : '+';
    final hh = offset.inHours.abs().toString().padLeft(2, '0');
    final mm = (offset.inMinutes.abs() % 60).toString().padLeft(2, '0');
    info['timezone'] = '${now.timeZoneName} (UTC$sign$hh:$mm)';
    try {
      final device = DeviceInfoPlugin();
      if (!kIsWeb && Platform.isAndroid) {
        final d = await device.androidInfo;
        info['hardware'] = '${d.manufacturer} ${d.model}';
        info['osDetail'] =
            'Android ${d.version.release} (SDK ${d.version.sdkInt})';
      } else if (!kIsWeb && Platform.isIOS) {
        final d = await device.iosInfo;
        info['hardware'] = d.utsname.machine;
        info['osDetail'] = '${d.systemName} ${d.systemVersion}';
      } else if (!kIsWeb && Platform.isMacOS) {
        final d = await device.macOsInfo;
        info['hardware'] = d.model;
        info['osDetail'] = 'macOS ${d.osRelease}';
      } else if (!kIsWeb && Platform.isWindows) {
        final d = await device.windowsInfo;
        info['osDetail'] = d.displayVersion;
      } else if (!kIsWeb && Platform.isLinux) {
        final d = await device.linuxInfo;
        info['osDetail'] = d.prettyName;
      }
    } catch (_) {
      /* device_info channel unavailable — keep what we have */
    }
    try {
      final links = await Connectivity().checkConnectivity();
      final named = links
          .where((c) => c != ConnectivityResult.none)
          .map((c) => c.name)
          .toList();
      info['network'] = named.isEmpty ? 'offline' : named.join('+');
    } catch (_) {
      /* connectivity channel unavailable */
    }
    return info;
  }

  /// Default foreground starter: nothing. On Android the foreground service
  /// is owned by MeshForegroundController (mesh_background.dart) — the mesh
  /// loop runs INSIDE that service's isolate, so starting it from here would
  /// be circular. Desktop platforms need no service at all. The injection
  /// point stays for tests and future platforms.
  static Future<void> _noopForeground() async {}
}
