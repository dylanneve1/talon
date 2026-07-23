import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/voice.dart';

void main() {
  group('speechify', () {
    test('strips markdown emphasis and headings', () {
      expect(
        speechify('# Hello\n\nThis is **bold** and _italic_ text.'),
        'Hello. This is bold and italic text.',
      );
    });

    test('replaces fenced code blocks with a spoken placeholder', () {
      final out = speechify('Before\n```dart\nprint("hi");\n```\nAfter');
      expect(out, contains('Code block omitted'));
      expect(out, isNot(contains('print')));
    });

    test('keeps inline code content, drops backticks', () {
      expect(speechify('Run `flutter test` now'), 'Run flutter test now');
    });

    test('collapses links to their label and bare URLs to "link"', () {
      expect(
        speechify('See [the docs](https://example.com/a?b=c)'),
        'See the docs',
      );
      expect(
        speechify('Go to https://example.com/x now'),
        'Go to link now',
      );
    });

    test('drops images entirely', () {
      expect(speechify('Look ![alt](https://x/y.png) here'), 'Look here');
    });

    test('flattens lists and quotes', () {
      expect(
        speechify('> quoted\n\n- one\n- two'),
        'quoted. one\ntwo'.replaceAll('\n', ' '),
      );
    });

    test('caps very long utterances', () {
      final out = speechify('word ' * 2000);
      expect(out.length, lessThanOrEqualTo(3601));
      expect(out.endsWith('…'), isTrue);
    });
  });

  group('SttError', () {
    test('no-match and timeout are benign; others are not', () {
      expect(const SttError(6, 'timeout').benign, isTrue);
      expect(const SttError(7, 'no match').benign, isTrue);
      expect(const SttError(2, 'network').benign, isFalse);
      expect(const SttError(9, 'perm').benign, isFalse);
    });
  });
}
