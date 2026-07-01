import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'markdown.dart';
import 'tool_timeline.dart';

/// The in-progress turn, rendered in the assistant-row layout: the Talon
/// avatar, the model's reasoning, the live tool timeline, and the streaming
/// reply (with a blinking caret while text is still arriving).
class LiveTurn extends StatelessWidget {
  final TurnState turn;
  final String botName;
  const LiveTurn({super.key, required this.turn, required this.botName});

  @override
  Widget build(BuildContext context) {
    return Padding(
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
                Text(botName, style: TalonType.subtitle),
                const SizedBox(height: 6),
                if (turn.reasoning.isNotEmpty)
                  _ReasoningStrip(
                    text: turn.reasoning.join(''),
                    // Once the reply starts streaming, the thinking is done —
                    // fold the strip into a quiet pill (tap re-expands).
                    condensed: turn.draft.isNotEmpty,
                  ),
                if (turn.tools.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(bottom: TalonSpace.sm),
                    child: ToolTimeline(tools: turn.tools),
                  ),
                AnimatedSwitcher(
                  duration: TalonMotion.fast,
                  switchInCurve: TalonMotion.emphasized,
                  switchOutCurve: Curves.easeIn,
                  child: turn.draft.isNotEmpty
                      ? _StreamingText(text: turn.draft)
                      : turn.typing
                          ? const Padding(
                              key: ValueKey('typing'),
                              padding: EdgeInsets.only(top: 2),
                              child: _TypingDots(),
                            )
                          : const SizedBox.shrink(key: ValueKey('idle')),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// The streaming draft with a blinking caret pinned to its end — the expected
/// "still generating" signal. The caret sits inline after the markdown so it
/// tracks the last line of text.
class _StreamingText extends StatelessWidget {
  final String text;
  const _StreamingText({required this.text});

  @override
  Widget build(BuildContext context) {
    final caret = Container(
      width: 8,
      height: 15,
      margin: const EdgeInsets.only(left: 3, bottom: 1),
      decoration: BoxDecoration(
        color: TalonColors.accent2,
        borderRadius: BorderRadius.circular(2),
      ),
    );
    return Row(
      key: const ValueKey('draft'),
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Flexible(
          child: MarkdownBody(
            data: text,
            styleSheet: talonMarkdownStyle(),
          ),
        ),
        if (MediaQuery.of(context).disableAnimations)
          caret
        else
          caret
              .animate(onPlay: (c) => c.repeat(reverse: true))
              .fadeOut(duration: 650.ms, curve: Curves.easeInOut),
      ],
    );
  }
}

/// The model's live reasoning, in a quiet accent-edged strip. Fades/blurs in
/// so it doesn't pop when the model starts thinking, and folds into a
/// one-line pill once the reply starts streaming (tap to re-expand) — the
/// pattern users know from the Claude/ChatGPT apps.
class _ReasoningStrip extends StatefulWidget {
  final String text;
  final bool condensed;
  const _ReasoningStrip({required this.text, this.condensed = false});

  @override
  State<_ReasoningStrip> createState() => _ReasoningStripState();
}

class _ReasoningStripState extends State<_ReasoningStrip> {
  /// The user's explicit choice, overriding the automatic fold. Null = auto.
  bool? _userExpanded;

  bool get _expanded => _userExpanded ?? !widget.condensed;

  @override
  Widget build(BuildContext context) {
    if (!_expanded) {
      return Padding(
        padding: const EdgeInsets.only(bottom: TalonSpace.sm),
        child: InkWell(
          onTap: () => setState(() => _userExpanded = true),
          borderRadius: TalonRadius.rPill,
          child: Container(
            padding: const EdgeInsets.symmetric(
                horizontal: TalonSpace.md, vertical: 5),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: TalonRadius.rPill,
              border: Border.all(color: TalonColors.glassStroke),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.bubble_chart_outlined,
                    size: 13, color: TalonColors.textFaint),
                const SizedBox(width: 6),
                Text(
                  'Thought — tap to expand',
                  style:
                      TextStyle(fontSize: 11.5, color: TalonColors.textFaint),
                ),
              ],
            ),
          ),
        ),
      );
    }
    return _strip(context);
  }

  Widget _strip(BuildContext context) {
    final text = widget.text;
    final strip = Padding(
      padding: const EdgeInsets.only(bottom: TalonSpace.sm),
      child: Container(
        padding:
            const EdgeInsets.symmetric(horizontal: TalonSpace.md, vertical: 9),
        decoration: BoxDecoration(
          borderRadius: TalonRadius.rMd,
          border: Border(
            left: BorderSide(color: TalonColors.accent, width: 2.5),
          ),
          color: TalonColors.glassFill,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(Icons.bubble_chart_outlined,
                size: 15, color: TalonColors.textFaint),
            const SizedBox(width: TalonSpace.sm),
            Expanded(
              child: AnimatedSize(
                duration: TalonMotion.base,
                curve: TalonMotion.emphasized,
                alignment: Alignment.topLeft,
                child: Text(
                  text.trim(),
                  maxLines: 5,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: TalonColors.textDim,
                    fontSize: 12.5,
                    height: 1.45,
                    fontStyle: FontStyle.italic,
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
    // While the reply streams, the expanded strip stays tappable to fold
    // back down (the pill re-expands it).
    final Widget body = widget.condensed
        ? GestureDetector(
            onTap: () => setState(() => _userExpanded = false),
            child: strip,
          )
        : strip;
    if (MediaQuery.of(context).disableAnimations) return body;
    return body.animate().fadeIn(duration: TalonMotion.base).blurX(
          begin: 3,
          end: 0,
          duration: TalonMotion.base,
          curve: TalonMotion.emphasized,
        );
  }
}

/// Three dots that ripple while the model is thinking but hasn't produced text
/// yet. A staggered fade/scale loop via flutter_animate — no manual controller.
class _TypingDots extends StatelessWidget {
  const _TypingDots();

  @override
  Widget build(BuildContext context) {
    Widget dot(int i) {
      final base = Container(
        width: 7,
        height: 7,
        margin: const EdgeInsets.symmetric(horizontal: 3),
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: TalonColors.textDim,
        ),
      );
      if (MediaQuery.of(context).disableAnimations) return base;
      return base
          .animate(onPlay: (c) => c.repeat(reverse: true))
          .fadeIn(delay: (i * 160).ms, duration: 500.ms, begin: 0.3)
          .scaleXY(begin: 0.7, end: 1, curve: Curves.easeOut);
    }

    return SizedBox(
      height: 20,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [dot(0), dot(1), dot(2)],
      ),
    );
  }
}
