import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/local_discovery.dart';

void main() {
  group('local bridge discovery', () {
    test('parses native-bridge.json from a Talon data dir', () async {
      final dir = await Directory.systemTemp.createTemp('talon-discovery-');
      addTearDown(() => dir.delete(recursive: true));
      await File('${dir.path}${Platform.pathSeparator}native-bridge.json')
          .writeAsString('''
{
  "host": "127.0.0.1",
  "port": 19901,
  "token": "secret",
  "scheme": "https",
  "pid": 123,
  "protocol": 1
}
''');

      final bridge = await readLocalBridgeFromDirectory(dir);

      expect(bridge, isNotNull);
      expect(bridge!.host, '127.0.0.1');
      expect(bridge.port, 19901);
      expect(bridge.token, 'secret');
      expect(bridge.scheme, 'https');
      expect(bridge.fingerprint, isNull);
    });

    test('carries the daemon certificate fingerprint when present', () async {
      final dir = await Directory.systemTemp.createTemp('talon-discovery-');
      addTearDown(() => dir.delete(recursive: true));
      final fp = 'ef' * 32;
      await File('${dir.path}${Platform.pathSeparator}native-bridge.json')
          .writeAsString(
        '{"host":"127.0.0.1","port":19901,"scheme":"https",'
        '"fingerprint":"$fp"}',
      );

      final bridge = await readLocalBridgeFromDirectory(dir);

      expect(bridge, isNotNull);
      expect(bridge!.fingerprint, fp);
    });

    test('returns null for missing or malformed files', () async {
      final dir = await Directory.systemTemp.createTemp('talon-discovery-');
      addTearDown(() => dir.delete(recursive: true));
      expect(await readLocalBridgeFromDirectory(dir), isNull);

      await File('${dir.path}${Platform.pathSeparator}native-bridge.json')
          .writeAsString('{"host":"127.0.0.1","port":"bad"}');
      expect(await readLocalBridgeFromDirectory(dir), isNull);
    });
  });
}
