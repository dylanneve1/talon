import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme.dart';

/// Shared Markdown style for assistant content — dark, readable, with framed
/// code blocks and accent links. Used by finalized messages and the live draft.
MarkdownStyleSheet talonMarkdownStyle() {
  return MarkdownStyleSheet(
    p: TextStyle(color: TalonColors.text, fontSize: 14.5, height: 1.6),
    a: TextStyle(
        color: TalonColors.accent2, decoration: TextDecoration.underline),
    strong: TextStyle(color: TalonColors.text, fontWeight: FontWeight.w700),
    em: TextStyle(color: TalonColors.text, fontStyle: FontStyle.italic),
    listBullet: TextStyle(color: TalonColors.textDim, fontSize: 14.5),
    h1: TextStyle(
        color: TalonColors.text, fontSize: 21, fontWeight: FontWeight.w700),
    h2: TextStyle(
        color: TalonColors.text, fontSize: 18, fontWeight: FontWeight.w700),
    h3: TextStyle(
        color: TalonColors.text, fontSize: 16, fontWeight: FontWeight.w700),
    // Inline `code`: on the dark theme a faint ink wash sets it apart; on the
    // light (paper) theme that same wash reads as a muddy grey box, so drop it
    // — the accent color + monospace font already distinguish inline code.
    code: TextStyle(
      color: TalonColors.accent2,
      backgroundColor:
          TalonTheme.isDark ? const Color(0x22000000) : Colors.transparent,
      fontFamily: 'JetBrains Mono',
      fontSize: 13.2,
    ),
    // Fenced blocks are rendered by CodeElementBuilder (its own framed panel);
    // this decoration only backs the rare block that falls through. Keep it
    // frameless on light so it doesn't paint a grey slab behind the code.
    codeblockDecoration: BoxDecoration(
      color: TalonTheme.isDark
          ? TalonColors.void0.withValues(alpha: 0.72)
          : Colors.transparent,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: TalonColors.glassStroke),
    ),
    codeblockPadding: const EdgeInsets.all(14),
    blockquoteDecoration: BoxDecoration(
      color: TalonColors.glassFill,
      borderRadius: BorderRadius.circular(8),
      border: Border(
        left: BorderSide(color: TalonColors.accent, width: 3),
      ),
    ),
    blockquotePadding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
    tableBorder: TableBorder.all(color: TalonColors.glassStroke),
    tableHead: const TextStyle(fontWeight: FontWeight.w700),
    horizontalRuleDecoration: BoxDecoration(
      border: Border(top: BorderSide(color: TalonColors.glassStroke)),
    ),
  );
}

/// Compact Markdown for list previews. Unlike [MarkdownBody], this stays a
/// single [RichText], so callers keep proper max-lines + ellipsis behaviour
/// while common inline syntax is rendered instead of leaking `**` / `_` /
/// backticks into the chat list.
class InlineMarkdownText extends StatelessWidget {
  final String data;
  final TextStyle style;
  final int maxLines;

  const InlineMarkdownText({
    super.key,
    required this.data,
    required this.style,
    this.maxLines = 1,
  });

  @override
  Widget build(BuildContext context) {
    final source = data.replaceAll(RegExp(r'\s+'), ' ').trim();
    final nodes =
        md.Document(extensionSet: md.ExtensionSet.gitHubWeb).parse(source);
    return Text.rich(
      TextSpan(style: style, children: _spans(nodes, style, separate: true)),
      maxLines: maxLines,
      overflow: TextOverflow.ellipsis,
      softWrap: maxLines > 1,
    );
  }

  static List<InlineSpan> _spans(
    List<md.Node> nodes,
    TextStyle inherited, {
    bool separate = false,
  }) {
    final spans = <InlineSpan>[];
    for (var i = 0; i < nodes.length; i++) {
      if (separate && i > 0) spans.add(const TextSpan(text: ' '));
      final node = nodes[i];
      if (node is md.Text) {
        spans.add(TextSpan(text: node.text, style: inherited));
        continue;
      }
      if (node is! md.Element) continue;

      if (node.tag == 'br') {
        spans.add(const TextSpan(text: ' '));
        continue;
      }
      if (node.tag == 'img') {
        spans.add(TextSpan(
          text: node.attributes['alt'] ?? 'Image',
          style: inherited,
        ));
        continue;
      }

      final next = switch (node.tag) {
        'strong' ||
        'b' =>
          inherited.merge(const TextStyle(fontWeight: FontWeight.w700)),
        'em' ||
        'i' =>
          inherited.merge(const TextStyle(fontStyle: FontStyle.italic)),
        'del' => inherited
            .merge(const TextStyle(decoration: TextDecoration.lineThrough)),
        'code' => inherited.merge(TextStyle(
            color: TalonColors.accent2,
            fontFamily: 'JetBrains Mono',
            fontSize: (inherited.fontSize ?? 12) * 0.95,
          )),
        'a' => inherited.merge(TextStyle(
            color: TalonColors.accent,
            decoration: TextDecoration.underline,
          )),
        'h1' ||
        'h2' ||
        'h3' ||
        'h4' ||
        'h5' ||
        'h6' =>
          inherited.merge(const TextStyle(fontWeight: FontWeight.w700)),
        _ => inherited,
      };
      final children = node.children ?? const <md.Node>[];
      final separatesChildren = node.tag == 'ul' || node.tag == 'ol';
      spans.add(TextSpan(
        style: next,
        children: _spans(children, next, separate: separatesChildren),
      ));
    }
    return spans;
  }
}
