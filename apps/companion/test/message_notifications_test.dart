import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/message_notifications.dart';

void main() {
  group('MessageNotifications.condense', () {
    test('collapses whitespace so a multi-line reply reads as one line', () {
      expect(
        MessageNotifications.condense('hello\n\n  world\tagain '),
        'hello world again',
      );
    });

    test('leaves a short body untouched', () {
      expect(MessageNotifications.condense('done'), 'done');
    });

    test('truncates a long body with an ellipsis, never past the cap', () {
      final out = MessageNotifications.condense('x' * 500);
      expect(out.length, 240);
      expect(out.endsWith('…'), isTrue);
    });

    test('empty / whitespace-only bodies condense to empty (no notification)',
        () {
      expect(MessageNotifications.condense('   \n '), '');
    });
  });

  test('notifications are Android-only; other platforms are a no-op', () {
    // The host test runner is Linux, so this also proves showMessage/clearChat
    // return without touching a platform channel there.
    expect(MessageNotifications.supported, isFalse);
    expect(
      MessageNotifications.showMessage(chatId: 'c', title: 't', body: 'b'),
      completes,
    );
    expect(MessageNotifications.clearChat('c'), completes);
  });
}
