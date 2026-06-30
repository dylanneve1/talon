import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/services/prefs.dart';

import 'mock_bridge.dart';

void main() {
  ConnectionConfig configFor(MockBridge bridge, {String? token}) =>
      ConnectionConfig(
        host: bridge.host,
        port: bridge.port,
        token: token,
        manageLocalDaemon: false,
      );

  Future<AppState> stateFor(ConnectionConfig config) async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(config);
    return AppState(prefs);
  }

  group('AppState bridge integration', () {
    test('start reaches connected and hello populates chats/status', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);

      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);
      await _waitFor(() => state.models.isNotEmpty);

      expect(state.connError, isNull);
      expect(state.status.botName, 'Talon');
      expect(state.chats.single.id, 'c1');
      expect(state.selectedChatId, 'c1');
      expect(state.messagesFor('c1').single.text, 'Hello');
      expect(state.models.single.id, 'm1');
    });

    test('events mutate messages and live turn state', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);

      await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});
      await _waitFor(() => state.turnFor('c1').active);
      await bridge
          .emit({'kind': 'reasoning', 'chatId': 'c1', 'text': 'thinking'});
      await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'partial'});
      await bridge.emit({
        'kind': 'tool',
        'chatId': 'c1',
        'id': 'tool1',
        'name': 'search',
        'phase': 'call',
        'input': {'q': 'talon'},
      });
      await _waitFor(() => state.turnFor('c1').tools.isNotEmpty);
      expect(state.turnFor('c1').reasoning, ['thinking']);
      expect(state.turnFor('c1').draft, 'partial');

      await bridge.emit({
        'kind': 'tool',
        'chatId': 'c1',
        'id': 'tool1',
        'name': 'search',
        'phase': 'result',
      });
      await _waitFor(() => state.turnFor('c1').tools.single.done);

      await bridge.emit({
        'kind': 'message',
        'chatId': 'c1',
        'message': {
          'id': 'm2',
          'chatId': 'c1',
          'role': 'assistant',
          'text': 'done',
          'ts': 30,
        },
      });
      await _waitFor(() => state.messagesFor('c1').length == 2);
      expect(state.messagesFor('c1').last.text, 'done');
      expect(state.messagesFor('c1').last.tools.single.name, 'search');
      expect(state.turnFor('c1').active, isFalse);

      await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});
      await bridge.emit({'kind': 'typing', 'chatId': 'c1', 'on': true});
      await _waitFor(() => state.turnFor('c1').typing);
      await bridge.emit({'kind': 'turn_end', 'chatId': 'c1', 'delivered': 1});
      await _waitFor(() => !state.turnFor('c1').typing);
    });

    test('chat and message maintenance events update stores', () async {
      final bridge = await MockBridge.start();
      addTearDown(bridge.close);
      final state = await stateFor(configFor(bridge));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => bridge.streamCount == 1);

      await bridge.emit({
        'kind': 'chat_updated',
        'chat': {
          'id': 'c1',
          'title': 'Renamed',
          'createdAt': 1,
          'lastActive': 5,
          'preview': 'new',
        },
      });
      await _waitFor(() => state.chats.single.title == 'Renamed');

      await bridge.emit({
        'kind': 'message_edited',
        'chatId': 'c1',
        'messageId': 'm1',
        'text': 'edited',
      });
      await _waitFor(() => state.messagesFor('c1').single.text == 'edited');
      await bridge.emit({
        'kind': 'reaction',
        'chatId': 'c1',
        'messageId': 'm1',
        'emoji': '+1',
      });
      await _waitFor(() => state.messagesFor('c1').single.reactions.isNotEmpty);
      await bridge.emit({
        'kind': 'message_deleted',
        'chatId': 'c1',
        'messageId': 'm1',
      });
      await _waitFor(() => state.messagesFor('c1').isEmpty);
      await bridge.emit({'kind': 'chat_deleted', 'chatId': 'c1'});
      await _waitFor(() => state.chats.isEmpty);
    });

    test(
      'malformed frames are ignored without killing the subscription',
      () async {
        final bridge = await MockBridge.start();
        addTearDown(bridge.close);
        final state = await stateFor(configFor(bridge));
        addTearDown(state.dispose);
        await state.start();
        await _waitFor(() => state.conn == ConnState.connected);
        await _waitFor(() => bridge.streamCount == 1);

        await bridge.writeRaw('data: {not json}\n\n');
        await bridge.emit({'kind': 'message'});
        await bridge.emit({'kind': 'turn_start'});
        await Future<void>.delayed(const Duration(milliseconds: 50));
        expect(state.conn, ConnState.connected);

        await bridge
            .emit({'kind': 'delta', 'chatId': 'c1', 'text': 'still alive'});
        await _waitFor(() => state.turnFor('c1').draft == 'still alive');
      },
    );

    test(
      'wrong token enters unauthorized state and does not reconnect',
      () async {
        final bridge = await MockBridge.start(token: 'secret');
        addTearDown(bridge.close);
        final state = await stateFor(configFor(bridge, token: 'wrong'));
        addTearDown(state.dispose);

        await state.start();
        await _waitFor(() => state.conn == ConnState.error);
        expect(state.connError, contains('Unauthorized'));
        expect(bridge.streamCount, 0);

        await Future<void>.delayed(const Duration(milliseconds: 950));
        expect(state.conn, ConnState.error);
        expect(state.connError, contains('Unauthorized'));
        expect(bridge.streamCount, 0);
      },
    );

    test('applyConfig resets stores before loading the new bridge', () async {
      final first = await MockBridge.start();
      final second = await MockBridge.start();
      addTearDown(first.close);
      addTearDown(second.close);
      second.chats
        ..clear()
        ..add({
          'id': 'c2',
          'title': 'Second',
          'createdAt': 10,
          'lastActive': 10,
          'preview': '',
        });
      second.messages
        ..clear()
        ..['c2'] = [];

      final state = await stateFor(configFor(first));
      addTearDown(state.dispose);
      await state.start();
      await _waitFor(() => state.messagesFor('c1').isNotEmpty);
      await _waitFor(() => first.streamCount == 1);

      await state.applyConfig(configFor(second));
      await _waitFor(() => state.conn == ConnState.connected);
      await _waitFor(() => second.streamCount == 1);

      expect(state.chats.single.id, 'c2');
      expect(state.selectedChatId, 'c2');
      expect(state.messagesFor('c1'), isEmpty);
      expect(state.turnFor('c1').draft, '');
    });
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) {
      fail('Timed out waiting for condition');
    }
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
