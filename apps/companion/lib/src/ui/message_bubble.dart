import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart' show launchUrl, LaunchMode;

import '../models/bridge_models.dart';
import '../services/haptics.dart';
import '../theme.dart';
import 'brand.dart';
import 'code_block.dart';
import 'markdown.dart';
import 'motion.dart';
import 'tool_timeline.dart';

/// Compact clock stamp for message rows ("14:32").
String _clock(DateTime t) {
  final local = t.toLocal();
  String two(int n) => n < 10 ? '0$n' : '$n';
  return '${two(local.hour)}:${two(local.minute)}';
}

/// A single conversation row, ChatGPT-style:
///   - user: a compact rounded bubble aligned right
///   - assistant: a full-width row with the Talon avatar + markdown + actions
///   - system: a quiet centered note
class MessageBubble extends StatelessWidget {
  final ClientMessage message;
  final String botName;

  /// Play a one-shot entrance when the row first appears. Only set for freshly
  /// arrived messages — never history or rows recycled back into view on scroll
  /// — so the list stays calm and nothing re-animates while scrolling.
  final bool animateIn;

  /// Fully-resolved URL for an attached image (base URL + token), or null.
  final String? imageUrl;

  const MessageBubble({
    super.key,
    required this.message,
    required this.botName,
    this.animateIn = false,
    this.imageUrl,
  });

  @override
  Widget build(BuildContext context) {
    final Widget row;
    switch (message.role) {
      case Role.system:
        row = _system();
      case Role.user:
        row = _userRow();
      case Role.assistant:
        row = _assistantRow();
    }
    // A user message rises from its side; the assistant fades in place with a
    // whisper of upward drift so it settles rather than snaps. EntranceFx
    // latches the play decision at mount so the frequent streaming rebuilds
    // (which flip `animateIn` back to false) can't tear the entrance down
    // mid-flight. Reduce-motion is honoured inside EntranceFx via `enabled`.
    final fromRight = message.role == Role.user;
    return EntranceFx(
      enabled: animateIn && !reduceMotion(context),
      from: Offset(fromRight ? 0.04 : -0.01, 0.12),
      child: row,
    );
  }

  Widget _system() => Padding(
        padding: const EdgeInsets.symmetric(
            vertical: TalonSpace.sm, horizontal: TalonSpace.md),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(
                horizontal: TalonSpace.md, vertical: 6),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: TalonRadius.rPill,
              border: Border.all(color: TalonColors.glassStroke),
            ),
            child: Text(
              message.text,
              textAlign: TextAlign.center,
              style: TalonType.caption,
            ),
          ),
        ),
      );

  Widget _userRow() => Padding(
        padding: const EdgeInsets.symmetric(vertical: TalonSpace.sm),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Spacer(flex: 2),
            Flexible(
              flex: 9,
              child: Align(
                alignment: Alignment.centerRight,
                child: Tooltip(
                  message: message.time.toLocal().toString().split('.').first,
                  waitDuration: const Duration(milliseconds: 600),
                  child: Builder(
                    builder: (context) => GestureDetector(
                      // Touch path to copy your own message: assistant rows
                      // have a Copy button, user bubbles previously had
                      // nothing reachable without a mouse (SelectableText
                      // still handles precise selection on the text itself).
                      onLongPress: message.text.isEmpty
                          ? null
                          : () async {
                              Haptics.medium();
                              final messenger =
                                  ScaffoldMessenger.maybeOf(context);
                              await Clipboard.setData(
                                  ClipboardData(text: message.text));
                              messenger?.hideCurrentSnackBar();
                              messenger?.showSnackBar(const SnackBar(
                                  content: Text('Message copied')));
                            },
                      child: Container(
                    padding: EdgeInsets.symmetric(
                        horizontal: imageUrl != null && message.text.isEmpty
                            ? TalonSpace.sm
                            : TalonSpace.lg,
                        vertical: imageUrl != null && message.text.isEmpty
                            ? TalonSpace.sm
                            : 11),
                    decoration: BoxDecoration(
                      // The user's voice wears the accent: a soft diagonal
                      // accent→deep gradient with an accent-tinted shadow, so
                      // your messages read as the vivid half of the dialogue
                      // (iMessage/Telegram pattern) against the calm canvas.
                      gradient: LinearGradient(
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                        colors: [TalonColors.accent, TalonColors.accentDeep],
                      ),
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(20),
                        topRight: Radius.circular(20),
                        bottomLeft: Radius.circular(20),
                        bottomRight: Radius.circular(6),
                      ),
                      boxShadow: [
                        BoxShadow(
                          color:
                              TalonColors.accentDeep.withValues(alpha: 0.30),
                          blurRadius: 12,
                          offset: const Offset(0, 4),
                        ),
                      ],
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        // Attached image — user rows previously dropped it
                        // entirely, so an uploaded photo vanished from the
                        // conversation and its history.
                        if (imageUrl != null)
                          Padding(
                            padding: EdgeInsets.only(
                                bottom:
                                    message.text.isEmpty ? 0 : TalonSpace.sm),
                            child: _InlineImage(url: imageUrl!),
                          ),
                            if (message.text.isNotEmpty)
                              SelectableText(
                                message.text,
                                style: TalonType.body.copyWith(
                                  color: Colors.white,
                                  // A touch more presence on the gradient.
                                  fontWeight: FontWeight.w500,
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );

  Widget _assistantRow() => Padding(
        padding: const EdgeInsets.symmetric(vertical: TalonSpace.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: BrandMark(size: 28),
            ),
            const SizedBox(width: TalonSpace.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      Text(botName, style: TalonType.subtitle),
                      const SizedBox(width: TalonSpace.sm),
                      Text(
                        _clock(message.time),
                        style: TalonType.caption.copyWith(fontSize: 10.5),
                      ),
                    ],
                  ),
                  const SizedBox(height: TalonSpace.xs),
                  if (message.tools.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: TalonSpace.sm),
                      child: ToolTrace(tools: message.tools),
                    ),
                  if (imageUrl != null)
                    Padding(
                      padding: EdgeInsets.only(
                          bottom: message.text.isEmpty ? 0 : TalonSpace.sm),
                      child: _InlineImage(url: imageUrl!),
                    ),
                  // Suppress the "…" placeholder for an image-only message.
                  if (!(imageUrl != null && message.text.isEmpty))
                    MarkdownBody(
                      data: message.text.isEmpty ? '…' : message.text,
                      selectable: true,
                      builders: {'code': CodeElementBuilder()},
                      onTapLink: (_, href, __) {
                        if (href != null) {
                          launchUrl(Uri.parse(href),
                              mode: LaunchMode.externalApplication);
                        }
                      },
                      styleSheet: talonMarkdownStyle(),
                    ),
                  if (message.buttons.isNotEmpty) _buttons(),
                  if (message.reactions.isNotEmpty) _reactions(),
                  _MessageActions(message: message),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _buttons() => Padding(
        padding: const EdgeInsets.only(top: TalonSpace.sm),
        child: Wrap(
          spacing: TalonSpace.sm,
          runSpacing: TalonSpace.sm,
          children: [
            for (final row in message.buttons)
              for (final b in row)
                OutlinedButton(
                  onPressed: b.url == null
                      ? null
                      : () => launchUrl(Uri.parse(b.url!),
                          mode: LaunchMode.externalApplication),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: TalonColors.accent,
                    side: BorderSide(
                        color: TalonColors.accent.withValues(alpha: 0.5)),
                    shape: const RoundedRectangleBorder(
                        borderRadius: TalonRadius.rSm),
                  ),
                  child: Text(b.text),
                ),
          ],
        ),
      );

  Widget _reactions() => Padding(
        padding: const EdgeInsets.only(top: TalonSpace.sm),
        child: Wrap(
          spacing: TalonSpace.xs,
          children: [
            for (final r in message.reactions)
              Container(
                padding: const EdgeInsets.symmetric(
                    horizontal: TalonSpace.sm, vertical: 3),
                decoration: BoxDecoration(
                  color: TalonColors.glassFill,
                  borderRadius: TalonRadius.rPill,
                  border: Border.all(color: TalonColors.glassStroke),
                ),
                child: Text(r, style: const TextStyle(fontSize: 13)),
              ),
          ],
        ),
      );
}

/// An inline attached image: rounded, width-capped, tap to open full-screen,
/// with quiet loading and error states so a slow or broken fetch never breaks
/// the row layout.
class _InlineImage extends StatelessWidget {
  final String url;
  const _InlineImage({required this.url});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => _openFull(context),
      child: ClipRRect(
        borderRadius: TalonRadius.rMd,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 340, maxHeight: 420),
          child: Image.network(
            url,
            // contain, not cover: cover cropped anything non-square into an
            // arbitrary window, which is what made history images look wrong.
            // contain keeps the full frame at its natural aspect ratio.
            fit: BoxFit.contain,
            loadingBuilder: (context, child, progress) {
              if (progress == null) return child;
              return Container(
                width: 220,
                height: 160,
                alignment: Alignment.center,
                color: TalonColors.surface,
                child: const SizedBox(
                  width: 20,
                  height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
              );
            },
            errorBuilder: (context, _, __) => Container(
              width: 200,
              height: 110,
              alignment: Alignment.center,
              color: TalonColors.surface,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.broken_image_outlined,
                      size: 18, color: TalonColors.textFaint),
                  const SizedBox(width: TalonSpace.sm),
                  Text('Image unavailable',
                      style: TextStyle(
                          color: TalonColors.textFaint, fontSize: 12.5)),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void _openFull(BuildContext context) {
    Navigator.of(context).push(
      PageRouteBuilder<void>(
        opaque: false,
        barrierColor: Colors.black.withValues(alpha: 0.9),
        pageBuilder: (_, __, ___) => GestureDetector(
          onTap: () => Navigator.of(context).pop(),
          child: Stack(
            children: [
              Center(
                child: InteractiveViewer(
                  maxScale: 5,
                  child: Image.network(url, fit: BoxFit.contain),
                ),
              ),
              Positioned(
                top: 40,
                right: TalonSpace.lg,
                child: IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close, color: Colors.white),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// The assistant row's footer: a Copy button plus a quiet stats readout
/// (duration + token usage) once the turn has ended.
class _MessageActions extends StatefulWidget {
  final ClientMessage message;
  const _MessageActions({required this.message});

  @override
  State<_MessageActions> createState() => _MessageActionsState();
}

class _MessageActionsState extends State<_MessageActions> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.message.text));
    if (!mounted) return;
    setState(() => _copied = true);
    Future.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final m = widget.message;
    if (m.text.isEmpty && !m.hasStats) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: Row(
        children: [
          if (m.text.isNotEmpty)
            InkWell(
              onTap: _copy,
              borderRadius: TalonRadius.rSm,
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 4),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Icon(_copied ? Icons.check : Icons.copy_rounded,
                        size: 14, color: TalonColors.textFaint),
                    const SizedBox(width: 5),
                    Text(
                      _copied ? 'Copied' : 'Copy',
                      style: TextStyle(
                          fontSize: 11.5, color: TalonColors.textFaint),
                    ),
                  ],
                ),
              ),
            ),
          if (m.hasStats) ...[
            const SizedBox(width: TalonSpace.sm),
            // Flexible + ellipsis: on a narrow phone column the full
            // "2.1k in · 460 out · 9.4s" readout can outgrow the row.
            Flexible(
              child: Text(
                _stats(m),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TalonType.caption.copyWith(fontSize: 11),
              ),
            ),
          ],
        ],
      ),
    );
  }

  String _stats(ClientMessage m) {
    final parts = <String>[];
    if (m.tokensIn != null && m.tokensIn! > 0) {
      parts.add('${_compact(m.tokensIn!)} in');
    }
    if (m.tokensOut != null && m.tokensOut! > 0) {
      parts.add('${_compact(m.tokensOut!)} out');
    }
    if (m.durationMs != null && m.durationMs! > 0) {
      // Reuse the same formatter the tool trace uses, so the duration here and
      // in the ToolTrace summary on the same row read identically.
      parts.add(fmtToolDuration(Duration(milliseconds: m.durationMs!)));
    }
    return parts.join(' · ');
  }

  static String _compact(int n) {
    if (n < 1000) return '$n';
    final k = n / 1000;
    // Round first so 9950 → "10k", not "10.0k".
    return k < 9.95 ? '${k.toStringAsFixed(1)}k' : '${k.round()}k';
  }
}
