import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:url_launcher/url_launcher.dart' show launchUrl, LaunchMode;

import '../models/bridge_models.dart';
import '../theme.dart';
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
