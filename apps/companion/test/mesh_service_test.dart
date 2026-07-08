import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/bridge_client.dart';
import 'package:talon_companion/src/services/mesh_service.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

void main() {
  ConnectionConfig configFor(MockBridge bridge) => ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        manageLocalDaemon: false,
        localAutoDiscover: false,
      );

  test('registers a stable device and responds to locate SSE with one fix',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    final client = BridgeClient(configFor(bridge));
    addTearDown(client.dispose);

    await client.connect();
    final service = MeshService(
      prefs,
      client,
      locationProvider: () async => const MeshFix(
        lat: 53.35,
        lon: -6.26,
        accuracyM: 9,
        ts: 1234,
      ),
      batteryProvider: () async =>
          const MeshBattery(percent: 82, charging: true),
      nameProvider: () async => 'Test phone',
      versionProvider: () async => '1.0.0+1',
      foregroundStarter: () async {},
    );
    addTearDown(service.stop);

    await service.start();
    await _waitFor(() => bridge.devices.length == 1);
    final id = bridge.devices.single['id'] as String;
    expect(id, isNotEmpty);
    expect(bridge.devices.single['name'], 'Test phone');
    expect(bridge.devices.single['battery'], 82);

    await bridge.emit({'kind': 'locate', 'deviceId': id});
    await _waitFor(() => bridge.locations.length == 1);
    expect(bridge.locations.single, containsPair('deviceId', id));
    expect(bridge.locations.single, containsPair('lat', 53.35));
    expect(bridge.locations.single, containsPair('batteryPct', 82));
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final deadline = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(deadline)) {
    if (test()) return;
    await Future<void>.delayed(const Duration(milliseconds: 20));
  }
  fail('condition not met before timeout');
}
