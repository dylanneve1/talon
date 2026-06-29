import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../theme.dart';

/// Shared Markdown style for assistant content — dark, readable, with framed
/// code blocks and accent links. Used by finalized messages and the live draft.
MarkdownStyleSheet talonMarkdownStyle() {
  return MarkdownStyleSheet(
    p: const TextStyle(color: TalonColors.text, fontSize: 14.5, height: 1.6),
    a: const TextStyle(
        color: TalonColors.accent2, decoration: TextDecoration.underline),
    strong:
        const TextStyle(color: TalonColors.text, fontWeight: FontWeight.w700),
    em: const TextStyle(color: TalonColors.text, fontStyle: FontStyle.italic),
    listBullet: const TextStyle(color: TalonColors.textDim, fontSize: 14.5),
    h1: const TextStyle(
        color: TalonColors.text, fontSize: 21, fontWeight: FontWeight.w700),
    h2: const TextStyle(
        color: TalonColors.text, fontSize: 18, fontWeight: FontWeight.w700),
    h3: const TextStyle(
        color: TalonColors.text, fontSize: 16, fontWeight: FontWeight.w700),
    code: const TextStyle(
      color: TalonColors.accent2,
      backgroundColor: Color(0x22000000),
      fontFamily: 'monospace',
      fontSize: 13.2,
    ),
    codeblockDecoration: BoxDecoration(
      color: TalonColors.void0.withValues(alpha: 0.72),
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: TalonColors.glassStroke),
    ),
    codeblockPadding: const EdgeInsets.all(14),
    blockquoteDecoration: BoxDecoration(
      color: TalonColors.glassFill,
      borderRadius: BorderRadius.circular(8),
      border: const Border(
        left: BorderSide(color: TalonColors.accent, width: 3),
      ),
    ),
    blockquotePadding: const EdgeInsets.fromLTRB(12, 6, 12, 6),
    tableBorder: TableBorder.all(color: TalonColors.glassStroke),
    tableHead: const TextStyle(fontWeight: FontWeight.w700),
    horizontalRuleDecoration: const BoxDecoration(
      border: Border(top: BorderSide(color: TalonColors.glassStroke)),
    ),
  );
}
