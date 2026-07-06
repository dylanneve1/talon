import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../theme.dart';

/// Shared Markdown style for assistant content — dark, readable, with framed
/// code blocks and accent links. Used by finalized messages and the live draft.
MarkdownStyleSheet talonMarkdownStyle() {
  return MarkdownStyleSheet(
    p: TextStyle(color: TalonColors.text, fontSize: 14.5, height: 1.6),
    a: TextStyle(
        color: TalonColors.accent2, decoration: TextDecoration.underline),
    strong:
        TextStyle(color: TalonColors.text, fontWeight: FontWeight.w700),
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
      fontFamily: 'monospace',
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
