import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';

void main() {
  group('ConnectionConfig', () {
    test('builds base + events URLs, with token on the SSE query', () {
      const c = ConnectionConfig(host: '10.0.0.5', port: 1234, token: 'sk e/t');
      expect(c.baseUrl, 'http://10.0.0.5:1234');
      expect(c.eventsUrl(), startsWith('http://10.0.0.5:1234/events?token='));
      // token is URL-encoded
      expect(c.eventsUrl(), contains('sk%20e%2Ft'));
      expect(c.authHeaders()['Authorization'], 'Bearer sk e/t');
    });

    test('loopback detection + no token => no auth header', () {
      const c = ConnectionConfig();
      expect(c.isLoopback, isTrue);
      expect(c.eventsUrl(), 'http://127.0.0.1:19880/events');
      expect(c.authHeaders().containsKey('Authorization'), isFalse);
    });

    test('round-trips through json', () {
      const c = ConnectionConfig(
        host: 'host',
        port: 42,
        token: 't',
        manageLocalDaemon: false,
        launchCommand: 'talon',
        launchArgs: ['start'],
      );
      final back = ConnectionConfig.fromJson(c.toJson());
      expect(back.host, 'host');
      expect(back.port, 42);
      expect(back.token, 't');
      expect(back.manageLocalDaemon, isFalse);
    });
  });

  group('wire model parsing', () {
    test('ClientMessage roles + buttons', () {
      final m = ClientMessage.fromJson({
        'id': 7,
        'chatId': 'd_1',
        'role': 'assistant',
        'text': 'hi',
        'ts': 1000,
        'buttons': [
          [
            {'text': 'Docs', 'url': 'https://x'},
          ],
        ],
        'reactions': ['👍'],
      });
      expect(m.id, '7');
      expect(m.role, Role.assistant);
      expect(m.buttons.first.first.text, 'Docs');
      expect(m.reactions, ['👍']);
    });

    test('defaults are tolerant of missing fields', () {
      final m = ClientMessage.fromJson({'id': 'x', 'role': 'user'});
      expect(m.role, Role.user);
      expect(m.text, '');
      expect(m.buttons, isEmpty);
    });

    test('ClientChat + ConfigSnapshot', () {
      final chat = ClientChat.fromJson({
        'id': 'd_1',
        'title': 'General',
        'createdAt': 1,
        'lastActive': 2,
        'preview': 'hey',
        'pulse': true,
      });
      expect(chat.title, 'General');
      expect(chat.pulse, isTrue);

      final cfg = ConfigSnapshot.fromJson({
        'backend': 'claude',
        'model': 'default',
        'modelDisplay': 'Opus',
        'botDisplayName': 'Talon',
        'pulse': true,
        'pulseIntervalMs': 300000,
        'heartbeat': false,
        'heartbeatIntervalMinutes': 60,
        'dream': true,
        'editable': ['model'],
        'health': {'healthy': true, 'sessions': 3, 'memoryMb': 120},
      });
      expect(cfg.modelDisplay, 'Opus');
      expect(cfg.sessions, 3);
      expect(cfg.healthy, isTrue);
      expect(cfg.editable, contains('model'));
    });
  });
}
