import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart' show launchUrl, LaunchMode;

import '../models/bridge_models.dart';
import '../theme.dart';
import 'activity_card.dart';
import 'brand.dart';
import 'markdown.dart';

/// A single conversation row, ChatGPT-style:
///   - user: a compact rounded bubble aligned right
///   - assistant: a full-width row with the Talon avatar + markdown + actions
///   - system: a quiet centered note
class MessageBubble extends StatelessWidget {
  final ClientMessage message;
  final String botName;
  const MessageBubble({super.key, required this.message, required this.botName});

  @override
  Widget build(BuildContext context) {
    switch (message.role) {
      case Role.system:
        return _system();
      case Role.user:
        return _userRow();
      case Role.assistant:
        return _assistantRow();
    }
  }

  Widget _system() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 12),
        child: Center(
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: TalonColors.glassStroke),
            ),
            child: Text(
              message.text,
              textAlign: TextAlign.center,
              style: const TextStyle(
                color: TalonColors.textFaint,
                fontSize: 12,
              ),
            ),
          ),
        ),
      );

  Widget _userRow() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Spacer(flex: 2),
            Flexible(
              flex: 9,
              child: Align(
                alignment: Alignment.centerRight,
                child: Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
                  decoration: BoxDecoration(
                    color: TalonColors.surfaceHi,
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(18),
                      topRight: Radius.circular(18),
                      bottomLeft: Radius.circular(18),
                      bottomRight: Radius.circular(6),
                    ),
                    border: Border.all(color: TalonColors.glassStroke),
                  ),
                  child: SelectableText(
                    message.text,
                    style: const TextStyle(
                      color: TalonColors.text,
                      fontSize: 14.5,
                      height: 1.5,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );

  Widget _assistantRow() => Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Padding(
              padding: EdgeInsets.only(top: 2),
              child: BrandMark(size: 28),
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    botName,
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 13.5,
                    ),
                  ),
                  const SizedBox(height: 4),
                  if (message.tools.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: _ToolHistory(tools: message.tools),
                    ),
                  MarkdownBody(
                    data: message.text.isEmpty ? '…' : message.text,
                    selectable: true,
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
                  _actions(),
                ],
              ),
            ),
          ],
        ),
      );

  Widget _actions() => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: _CopyButton(text: message.text),
      );

  Widget _buttons() => Padding(
        padding: const EdgeInsets.only(top: 10),
        child: Wrap(
          spacing: 8,
          runSpacing: 8,
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
                    shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10)),
                  ),
                  child: Text(b.text),
                ),
          ],
        ),
      );

  Widget _reactions() => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Wrap(
          spacing: 4,
          children: [
            for (final r in message.reactions)
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                decoration: BoxDecoration(
                  color: TalonColors.glassFill,
                  borderRadius: BorderRadius.circular(999),
                  border: Border.all(color: TalonColors.glassStroke),
                ),
                child: Text(r, style: const TextStyle(fontSize: 13)),
              ),
          ],
        ),
      );
}

/// Collapsed summary of the tools the model ran for an assistant message.
/// Tap to expand and see the chip for each call.
class _ToolHistory extends StatefulWidget {
  final List<ToolActivity> tools;
  const _ToolHistory({required this.tools});

  @override
  State<_ToolHistory> createState() => _ToolHistoryState();
}

class _ToolHistoryState extends State<_ToolHistory> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final tools = widget.tools;
    final failed = tools.where((t) => t.error != null).length;
    final total = Duration(
      milliseconds:
          tools.fold<int>(0, (a, t) => a + t.elapsed.inMilliseconds),
    );

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          borderRadius: BorderRadius.circular(10),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                AnimatedRotation(
                  duration: const Duration(milliseconds: 160),
                  turns: _open ? 0.25 : 0,
                  child: const Icon(
                    Icons.chevron_right,
                    size: 16,
                    color: TalonColors.textFaint,
                  ),
                ),
                const SizedBox(width: 4),
                Icon(
                  failed > 0 ? Icons.error_outline : Icons.handyman_outlined,
                  size: 13,
                  color: failed > 0 ? TalonColors.bad : TalonColors.textFaint,
                ),
                const SizedBox(width: 6),
                Text(
                  _summary(tools.length, failed, total),
                  style: const TextStyle(
                    color: TalonColors.textFaint,
                    fontSize: 12,
                  ),
                ),
              ],
            ),
          ),
        ),
        AnimatedSize(
          duration: const Duration(milliseconds: 180),
          curve: Curves.easeOut,
          alignment: Alignment.topLeft,
          child: _open
              ? Padding(
                  padding: const EdgeInsets.only(top: 6),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final t in tools) ToolChip(key: ValueKey(t.id), tool: t),
                    ],
                  ),
                )
              : const SizedBox(width: double.infinity),
        ),
      ],
    );
  }

  String _summary(int n, int failed, Duration total) {
    final base = '$n ${n == 1 ? 'tool' : 'tools'} · ${_fmt(total)}';
    if (failed == 0) return base;
    return '$base · $failed failed';
  }

  String _fmt(Duration d) {
    final ms = d.inMilliseconds;
    if (ms < 1000) return '${ms}ms';
    final s = ms / 1000;
    if (s < 10) return '${s.toStringAsFixed(1)}s';
    if (s < 60) return '${s.toStringAsFixed(0)}s';
    final m = (s / 60).floor();
    return '${m}m${(s - m * 60).toStringAsFixed(0)}s';
  }
}

class _CopyButton extends StatefulWidget {
  final String text;
  const _CopyButton({required this.text});

  @override
  State<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<_CopyButton> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: () async {
        await Clipboard.setData(ClipboardData(text: widget.text));
        if (!mounted) return;
        setState(() => _copied = true);
        Future.delayed(const Duration(milliseconds: 1400), () {
          if (mounted) setState(() => _copied = false);
        });
      },
      borderRadius: BorderRadius.circular(8),
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
              style: const TextStyle(
                  fontSize: 11.5, color: TalonColors.textFaint),
            ),
          ],
        ),
      ),
    );
  }
}
