import 'dart:async';
import 'dart:io' show Platform;

import 'package:battery_plus/battery_plus.dart';
import 'package:device_info_plus/device_info_plus.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';
import 'package:geolocator/geolocator.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:uuid/uuid.dart';

import 'bridge_client.dart';
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
typedef MeshUrlOpener = Future<bool> Function(Uri url);
typedef MeshClipboardReader = Future<String?> Function();
typedef MeshClipboardWriter = Future<void> Function(String text);

@pragma('vm:entry-point')
void startMeshForegroundCallback() {
  FlutterForegroundTask.setTaskHandler(_MeshForegroundTaskHandler());
}

class _MeshForegroundTaskHandler extends TaskHandler {
  @override
  Future<void> onStart(DateTime timestamp, TaskStarter starter) async {}

  @override
  void onRepeatEvent(DateTime timestamp) {}

  @override
  Future<void> onDestroy(DateTime timestamp, bool isTimeout) async {}
}

class MeshService {
  /// Commands this build can execute, advertised at registration so the
  /// daemon can refuse unsupported commands with a clear message instead of
  /// timing out.
  static const List<String> capabilities = [
    'locate',
    'ring',
    'open_url',
    'clipboard_set',
    'clipboard_get',
    'status',
  ];

  final Prefs prefs;
  final BridgeClient client;
  final MeshLocationProvider _locationProvider;
  final MeshBatteryProvider _batteryProvider;
  final MeshNameProvider _nameProvider;
  final MeshVersionProvider _versionProvider;
  final ForegroundStarter _foregroundStarter;
  final MeshRingHandler _ringHandler;
  final MeshUrlOpener _urlOpener;
  final MeshClipboardReader _clipboardReader;
  final MeshClipboardWriter _clipboardWriter;

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
    MeshUrlOpener? urlOpener,
    MeshClipboardReader? clipboardReader,
    MeshClipboardWriter? clipboardWriter,
  })  : _locationProvider = locationProvider ?? _defaultLocation,
        _batteryProvider = batteryProvider ?? _defaultBattery,
        _nameProvider = nameProvider ?? _defaultName,
        _versionProvider = versionProvider ?? _defaultVersion,
        _foregroundStarter = foregroundStarter ?? _startForeground,
        _ringHandler = ringHandler ?? _defaultRing,
        _urlOpener = urlOpener ?? _defaultOpenUrl,
        _clipboardReader = clipboardReader ?? _defaultClipboardRead,
        _clipboardWriter = clipboardWriter ?? _defaultClipboardWrite;

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
    await register();
    _events = client.events.listen((event) {
      if (event['kind'] == 'locate') unawaited(_handleLocate(event));
      if (event['kind'] == 'device_command') unawaited(_handleCommand(event));
    });
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
      'capabilities': capabilities,
    });
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
        case 'open_url':
          final uri = Uri.tryParse('${params['url'] ?? ''}');
          if (uri == null || !(uri.scheme == 'http' || uri.scheme == 'https')) {
            message = 'open_url needs an http(s) URL.';
          } else {
            ok = await _urlOpener(uri);
            if (!ok) message = 'The device could not open the URL.';
          }
          break;
        case 'clipboard_set':
          final text = params['text'];
          if (text is! String || text.isEmpty) {
            message = 'clipboard_set needs non-empty text.';
          } else {
            await _clipboardWriter(text);
            ok = true;
          }
          break;
        case 'clipboard_get':
          data = {'text': await _clipboardReader() ?? ''};
          ok = true;
          break;
        case 'status':
          data = await _statusPayload();
          ok = true;
          break;
        default:
          message = 'This app version does not support "$name".';
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
    return {
      'name': await _nameProvider(),
      'platform': _platform,
      'appVersion': await _versionProvider(),
      if (battery.percent != null) 'battery': '${battery.percent}%',
      if (battery.charging != null)
        'charging': battery.charging! ? 'yes' : 'no',
      if (!kIsWeb)
        'os': '${Platform.operatingSystem} ${Platform.operatingSystemVersion}',
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

  static Future<bool> _defaultOpenUrl(Uri url) =>
      launchUrl(url, mode: LaunchMode.externalApplication);

  static Future<String?> _defaultClipboardRead() async =>
      (await Clipboard.getData(Clipboard.kTextPlain))?.text;

  static Future<void> _defaultClipboardWrite(String text) =>
      Clipboard.setData(ClipboardData(text: text));

  static Future<void> _startForeground() async {
    if (kIsWeb || !Platform.isAndroid) return;
    final notificationPermission =
        await FlutterForegroundTask.checkNotificationPermission();
    if (notificationPermission != NotificationPermission.granted) {
      await FlutterForegroundTask.requestNotificationPermission();
    }
    if (!await FlutterForegroundTask.isIgnoringBatteryOptimizations) {
      await FlutterForegroundTask.requestIgnoreBatteryOptimization();
    }
    FlutterForegroundTask.init(
      androidNotificationOptions: AndroidNotificationOptions(
        channelId: 'talon_mesh',
        channelName: 'Talon mesh',
        channelDescription: 'Keeps Talon mesh location available.',
        channelImportance: NotificationChannelImportance.LOW,
        priority: NotificationPriority.LOW,
      ),
      iosNotificationOptions: const IOSNotificationOptions(),
      foregroundTaskOptions: ForegroundTaskOptions(
        eventAction: ForegroundTaskEventAction.repeat(60000),
        autoRunOnBoot: true,
        autoRunOnMyPackageReplaced: true,
        allowWakeLock: true,
        allowWifiLock: true,
      ),
    );
    if (!await FlutterForegroundTask.isRunningService) {
      await FlutterForegroundTask.startService(
        serviceTypes: const [ForegroundServiceTypes.location],
        notificationTitle: 'Talon mesh active',
        notificationText: 'Location sharing is available on demand.',
        callback: startMeshForegroundCallback,
      );
    }
  }
}
