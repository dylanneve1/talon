import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';

/// Contract test against the shared protocol fixture. The daemon asserts the
/// same file from TypeScript (src/__tests__/native-protocol-fixture.test.ts),
/// so a wire-shape drift on either side fails one of the two suites instead
/// of shipping a silent misrender.
void main() {
  final fixture = jsonDecode(
    File('test/fixtures/protocol_v1.json').readAsStringSync(),
  ) as Map<String, dynamic>;

  test('fixture protocol version matches the client', () {
    expect(fixture['protocol'], kBridgeProtocolVersion);
  });

  test('canonical message parses with turn meta intact', () {
    final m = ClientMessage.fromJson(
        (fixture['message'] as Map).cast<String, dynamic>());
    expect(m.id, '1024');
    expect(m.chatId, 'd_abc123');
    expect(m.role, Role.assistant);
    expect(m.text, contains('markdown'));
    expect(m.ts, 1767225600000);
    expect(m.buttons.single.single.text, 'Open');
    expect(m.buttons.single.single.url, 'https://example.com');
    expect(m.reactions, ['👍']);
    expect(m.imagePath, '/media?id=m42');
    expect(m.durationMs, 4200);
    expect(m.tokensIn, 1200);
    expect(m.tokensOut, 340);
    expect(m.hasStats, isTrue);
    expect(m.tools, hasLength(2));
    expect(m.tools.first.name, 'mcp__search__web');
    expect(m.tools.first.input['query'], 'talon agent');
    expect(m.tools.first.done, isTrue);
    expect(m.tools.first.elapsed.inMilliseconds, 800);
    expect(m.tools.last.error, 'exit 1');
  });

  test('canonical chat parses', () {
    final c =
        ClientChat.fromJson((fixture['chat'] as Map).cast<String, dynamic>());
    expect(c.id, 'd_abc123');
    expect(c.title, 'Protocol design');
    expect(c.createdAt, 1767225500000);
    expect(c.lastActive, 1767225600000);
    expect(c.model, 'claude-sonnet-5');
    expect(c.backend, 'claude');
    expect(c.effort, 'high');
    expect(c.pulse, isTrue);
  });

  test('canonical status parses', () {
    final s = BridgeStatus.fromJson(
        (fixture['status'] as Map).cast<String, dynamic>());
    expect(s.protocol, 1);
    expect(s.botName, 'Talon');
    expect(s.backend, 'claude');
    expect(s.model, 'Claude Sonnet 5');
    expect(s.activeChats, 3);
    expect(s.startedAt, '2026-01-01T00:00:00.000Z');
  });

  test('canonical search result parses', () {
    final r = SearchHit.fromJson(
        (fixture['searchResult'] as Map).cast<String, dynamic>());
    expect(r.chatId, 'd_abc123');
    expect(r.chatTitle, 'Protocol design');
    expect(r.message.role, Role.user);
    expect(r.message.text, 'find the fox');
  });
}
