import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/message_bubble.dart';
import 'package:talon_companion/src/ui/motion.dart';
import 'package:talon_companion/src/ui/tool_timeline.dart';

/// Runtime smoke tests: pump the redesigned widgets and assert they build and
/// surface their key content, catching layout/assertion errors the analyzer
/// can't. Animations are disabled so the pumps settle deterministically.
Widget _host(Widget child) => MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: MaterialApp(
        theme: buildTalonTheme(),
        home: Scaffold(
          body: SingleChildScrollView(child: child),
        ),
      ),
    );

ToolActivity _tool({
  required String id,
  required String name,
  bool done = true,
  String? error,
  Map<String, dynamic>? input,
}) =>
    ToolActivity(
      id: id,
      name: name,
      done: done,
      error: error,
      input: input,
      startedAt: DateTime(2020),
      finishedAt: DateTime(2020, 1, 1, 0, 0, 2),
    );

void main() {
  testWidgets('ToolTimeline renders a step per tool with de-noised names',
      (tester) async {
    await tester.pumpWidget(_host(ToolTimeline(tools: [
      _tool(id: 't1', name: 'Bash', input: {'command': 'ls -la'}),
      _tool(
        id: 't2',
        name: 'mcp__email-tools__search_emails',
        input: {'query': 'invoices'},
      ),
    ])));
    await tester.pumpAndSettle();

    expect(find.text('Bash'), findsOneWidget);
    // MCP name is de-noised: server · tool.
    expect(find.text('email · search_emails'), findsOneWidget);
  });

  testWidgets('a failed tool step auto-expands to show its error',
      (tester) async {
    await tester.pumpWidget(_host(ToolTimeline(tools: [
      _tool(
        id: 't1',
        name: 'run_tests',
        done: true,
        error: 'exit code 1: 2 failing',
        input: {'path': 'test/'},
      ),
    ])));
    await tester.pumpAndSettle();

    expect(find.text('Failed'), findsOneWidget);
    // Error detail is visible without any tap because failures open on arrival.
    expect(find.textContaining('exit code 1'), findsOneWidget);
  });

  testWidgets('ToolTrace summarizes a finished turn', (tester) async {
    await tester.pumpWidget(_host(ToolTrace(tools: [
      _tool(id: 't1', name: 'Read'),
      _tool(id: 't2', name: 'Write'),
    ])));
    await tester.pumpAndSettle();

    expect(find.textContaining('2 steps'), findsOneWidget);
  });

  testWidgets('assistant bubble shows the reply and a token/duration footer',
      (tester) async {
    final msg = ClientMessage(
      id: 'm1',
      chatId: 'c1',
      role: Role.assistant,
      text: 'Here is your answer.',
      ts: 0,
      durationMs: 4200,
      tokensIn: 1500,
      tokensOut: 320,
    );
    await tester.pumpWidget(_host(
      MessageBubble(message: msg, botName: 'Talon'),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Talon'), findsOneWidget);
    expect(find.text('Copy'), findsOneWidget);
    // Compact stats: 1.5k in · 320 out · 4.2s
    expect(find.textContaining('1.5k in'), findsOneWidget);
    expect(find.textContaining('4.2s'), findsOneWidget);
  });

  testWidgets('EntranceFx plays through even when enabled flips to false',
      (tester) async {
    // Reproduces the streaming-rebuild bug: a parent rebuild flips the "fresh"
    // gate to false a few frames in. EntranceFx must keep rendering its child
    // (never throw / drop it) rather than tearing the animation down.
    var enabled = true;
    late StateSetter setOuter;
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: StatefulBuilder(builder: (context, setState) {
          setOuter = setState;
          return EntranceFx(
            enabled: enabled,
            child: const Text('hello', key: Key('fx-child')),
          );
        }),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 80));
    expect(find.byKey(const Key('fx-child')), findsOneWidget);

    // Simulate the streaming rebuild that flips the gate mid-entrance.
    setOuter(() => enabled = false);
    await tester.pump();
    expect(find.byKey(const Key('fx-child')), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('fx-child')), findsOneWidget);
  });

  testWidgets('reduceMotion reflects MediaQuery.disableAnimations',
      (tester) async {
    late bool observed;
    await tester.pumpWidget(MediaQuery(
      data: const MediaQueryData(disableAnimations: true),
      child: Builder(builder: (context) {
        observed = reduceMotion(context);
        return const SizedBox();
      }),
    ));
    expect(observed, isTrue);
  });
}
