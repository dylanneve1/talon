import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/state/frame_coalescer.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/activity_card.dart';
import 'package:talon_companion/src/ui/markdown.dart';
import 'package:talon_companion/src/ui/sidebar.dart';

import 'mock_bridge.dart';

/// #1059 / #1063: a streamed token must not rebuild the app, re-parse the
/// whole reply, or re-serialise every chat.
void main() {
  group('FrameCoalescer', () {
    test('merges a burst into one delivery (no binding: microtask)',
        () async {
      var delivered = 0;
      final c = FrameCoalescer(() => delivered++);
      c.request();
      c.request();
      c.request();
      expect(delivered, 0);
      await Future<void>.delayed(Duration.zero);
      expect(delivered, 1);
      c.request();
      c.cancel();
      await Future<void>.delayed(Duration.zero);
      expect(delivered, 1, reason: 'a cancelled request never delivers');
    });

    testWidgets('delivers at most once per frame', (tester) async {
      var delivered = 0;
      final c = FrameCoalescer(() => delivered++);
      for (var i = 0; i < 50; i++) {
        c.request();
      }
      expect(delivered, 0);
      await tester.pump();
      expect(delivered, 1);
      c.request();
      await tester.pump();
      expect(delivered, 2);
    });
  });

  group('TurnState draft', () {
    test('appends are buffered and joined on read', () {
      final t = TurnState();
      expect(t.hasDraft, isFalse);
      t.appendDraft('Hel');
      t.appendDraft('lo');
      expect(t.hasDraft, isTrue);
      expect(t.draft, 'Hello');
      t.appendDraft(', world');
      expect(t.draft, 'Hello, world');
      t.appendDraft('!');
      t.draft = '';
      expect(t.draft, isEmpty);
      expect(t.hasDraft, isFalse);
    });
  });

  test('tokens notify the turn, not the whole app', () async {
    final bridge = await MockBridge.start();
    addTearDown(bridge.close);
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    await prefs.setConnection(ConnectionConfig(
      host: bridge.host,
      port: bridge.port,
      manageLocalDaemon: false,
      localAutoDiscover: false,
    ));
    final state = AppState(prefs, narrowLayout: false);
    addTearDown(state.dispose);
    await state.start();
    await _waitFor(() => state.conn == ConnState.connected);
    await _waitFor(() => bridge.streamCount == 1);

    await bridge.emit({'kind': 'turn_start', 'chatId': 'c1'});
    await _waitFor(() => state.turnFor('c1').active);

    var appNotifies = 0;
    var turnNotifies = 0;
    state.addListener(() => appNotifies++);
    state.turnFor('c1').addListener(() => turnNotifies++);

    // First text of the reply changes the chat's shape → an app notify.
    await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'a'});
    await _waitFor(() => state.turnFor('c1').draft == 'a');
    expect(appNotifies, greaterThanOrEqualTo(1));

    // The next 40 tokens: before, 40 app-wide notifies (40 whole-tree
    // rebuilds). Now the app hears nothing; the turn hears ≤1 per frame.
    // (Tolerant bound: unrelated background notifies — mesh presence —
    // may land in the window.)
    final before = appNotifies;
    for (var i = 0; i < 40; i++) {
      await bridge.emit({'kind': 'delta', 'chatId': 'c1', 'text': 'b'});
    }
    await _waitFor(() => state.turnFor('c1').draft.length == 41);
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(appNotifies - before, lessThan(4));
    expect(turnNotifies, inInclusiveRange(1, 40));

    await bridge.emit({'kind': 'turn_end', 'chatId': 'c1'});
    await _waitFor(() => !state.turnFor('c1').active);
  });

  group('markdownBlockBreaks', () {
    test('breaks at paragraph starts after a blank line', () {
      const text = 'One.\n\nTwo.\n\nThr';
      expect(markdownBlockBreaks(text), [6, 12]);
      expect(text.substring(12), 'Thr');
    });

    test('never breaks inside a fenced code block', () {
      const text = 'Intro\n\n```py\na = 1\n\nb = 2\n```\n\nAfter';
      final breaks = markdownBlockBreaks(text);
      expect(breaks.length, 2);
      expect(text.substring(breaks[0], breaks[1]),
          startsWith('```py\na = 1\n\nb = 2\n```'));
      expect(text.substring(breaks[1]), 'After');
    });

    test('an open fence holds everything after it in the tail', () {
      const text = 'Intro\n\n```py\na = 1\n\nb';
      expect(markdownBlockBreaks(text), [7]);
    });

    test('indented continuations stay with their list item', () {
      const text = '- item\n\n    more of the item\n\nNext';
      final breaks = markdownBlockBreaks(text);
      expect(breaks, [text.indexOf('Next')]);
    });

    test('resuming from an earlier break finds only the new ones', () {
      const text = 'A\n\nB\n\nC\n\nD';
      final all = markdownBlockBreaks(text);
      expect(markdownBlockBreaks(text, from: all[1]), all.sublist(2));
    });
  });

  testWidgets('finished blocks of a streaming reply are built once',
      (tester) async {
    final turn = TurnState()
      ..active = true
      ..draft = 'First paragraph.\n\nSecond, still typ';
    await tester.pumpWidget(MaterialApp(
      theme: buildTalonTheme(),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: true),
        child: child!,
      ),
      home: Scaffold(
        body: SingleChildScrollView(
          child: LiveTurn(turn: turn, botName: 'Talon'),
        ),
      ),
    ));
    final bodies = find.byType(MarkdownBody);
    expect(bodies, findsNWidgets(2));
    final first = tester.widget<MarkdownBody>(bodies.first);
    expect(first.data, startsWith('First paragraph.'));

    turn.appendDraft('ing.\n\nThird');
    turn.changed();
    await tester.pump();

    expect(bodies, findsNWidgets(3));
    // The finished first block is the very same widget instance: Flutter
    // skips it outright — no re-parse, no re-layout.
    expect(identical(tester.widget<MarkdownBody>(bodies.first), first), isTrue);
    expect(tester.widget<MarkdownBody>(bodies.last).data, 'Third');
  });

  testWidgets('the chat list builds only the tiles on screen', (tester) async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: true);
    addTearDown(state.dispose);
    final now = DateTime.now().millisecondsSinceEpoch;
    state.debugSeed(
      chats: [
        for (var i = 0; i < 300; i++)
          ClientChat(
            id: 'c$i',
            title: 'Chat $i',
            createdAt: 1,
            lastActive: now - i * 1000,
            preview: '**bold** preview $i',
          ),
      ],
      messages: const {},
      connState: ConnState.connected,
    );
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(body: Sidebar(state: state, onSelect: (_) {})),
      ),
    ));
    await tester.pump();

    expect(find.byKey(const ValueKey('tile-c0')), findsOneWidget);
    expect(find.byKey(const ValueKey('tile-c299')), findsNothing);
    expect(find.text('Chat 1'), findsOneWidget);
  });

  group('snapshot file', () {
    late Directory dir;
    setUp(() => dir = Directory.systemTemp.createTempSync('talon-snap-'));
    tearDown(() => dir.deleteSync(recursive: true));

    test('lives in its own file, written off the UI isolate', () async {
      SharedPreferences.setMockInitialValues({
        // A legacy in-prefs snapshot from an older build.
        'snapshot.v1': '{"chats":[],"messages":{}}',
      });
      final sp = await SharedPreferences.getInstance();
      final file = File('${dir.path}/chat_snapshot.v1.json');
      final prefs = Prefs(sp, snapshotFile: file);

      // Legacy data is still readable until the first file write.
      expect(prefs.snapshot, isNotNull);

      await prefs.saveSnapshot({
        'chats': [
          {'id': 'c1'},
        ],
        'messages': <String, dynamic>{},
      });
      expect(file.existsSync(), isTrue);
      expect(File('${file.path}.tmp').existsSync(), isFalse);
      expect((prefs.snapshot!['chats'] as List).single, {'id': 'c1'});
      // …and the copy inside the (rewrite-everything) prefs store is gone.
      expect(sp.containsKey('snapshot.v1'), isFalse);
    });

    test('writeSnapshotFile replaces atomically', () {
      final path = '${dir.path}/s.json';
      writeSnapshotFile(path, {'v': 1});
      writeSnapshotFile(path, {'v': 2});
      expect(File(path).readAsStringSync(), '{"v":2}');
    });
  });
}

Future<void> _waitFor(
  bool Function() test, {
  Duration timeout = const Duration(seconds: 2),
}) async {
  final end = DateTime.now().add(timeout);
  while (!test()) {
    if (DateTime.now().isAfter(end)) fail('Timed out waiting for condition');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}
