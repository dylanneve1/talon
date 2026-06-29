import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown/flutter_markdown.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'markdown.dart';

/// The in-progress turn, rendered in the assistant-row layout: the Talon
/// avatar, the model's reasoning, live tool calls, and the streaming reply.
class LiveTurn extends StatelessWidget {
  final TurnState turn;
  final String botName;
  const LiveTurn({super.key, required this.turn, required this.botName});

  @override
  Widget build(BuildContext context) {
    return Padding(
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
                      fontWeight: FontWeight.w700, fontSize: 13.5),
                ),
                const SizedBox(height: 6),
                if (turn.reasoning.isNotEmpty)
                  _ReasoningStrip(text: turn.reasoning.join('')),
                AnimatedSize(
                  duration: const Duration(milliseconds: 160),
                  curve: Curves.easeOut,
                  alignment: Alignment.topLeft,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      for (final t in turn.tools)
                        ToolChip(key: ValueKey(t.id), tool: t),
                    ],
                  ),
                ),
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 140),
                  switchInCurve: Curves.easeOut,
                  switchOutCurve: Curves.easeIn,
                  child: turn.draft.isNotEmpty
                      ? MarkdownBody(
                          key: const ValueKey('draft'),
                          data: turn.draft,
                          styleSheet: talonMarkdownStyle())
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

/// One row per tool call. Pulses while running, animates to a calm "done"
/// state when finished, shows live elapsed time.
class ToolChip extends StatefulWidget {
  final ToolActivity tool;
  const ToolChip({super.key, required this.tool});

  @override
  State<ToolChip> createState() => _ToolChipState();
}

class _ToolChipState extends State<ToolChip>
    with SingleTickerProviderStateMixin {
  late final AnimationController _pulse = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..repeat(reverse: true);
  Timer? _ticker;

  @override
  void initState() {
    super.initState();
    _ticker = Timer.periodic(const Duration(milliseconds: 100), (_) {
      if (!mounted) return;
      if (!widget.tool.done) setState(() {});
    });
  }

  @override
  void didUpdateWidget(covariant ToolChip old) {
    super.didUpdateWidget(old);
    if (widget.tool.done && _pulse.isAnimating) _pulse.stop();
  }

  @override
  void dispose() {
    _ticker?.cancel();
    _pulse.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tool = widget.tool;
    final failed = tool.error != null;
    final color = failed
        ? TalonColors.bad
        : (tool.done ? TalonColors.ok : TalonColors.accent2);
    final running = !tool.done && !failed;

    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: AnimatedBuilder(
        animation: _pulse,
        builder: (context, child) {
          final glow = running
              ? 0.18 + 0.18 * _pulse.value
              : 0.0;
          return Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
            decoration: BoxDecoration(
              color: TalonColors.glassFill,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(
                color: color.withValues(alpha: running ? 0.55 : 0.30),
              ),
              boxShadow: running
                  ? [
                      BoxShadow(
                        color: color.withValues(alpha: glow),
                        blurRadius: 14,
                        spreadRadius: 0.5,
                      ),
                    ]
                  : null,
            ),
            child: child,
          );
        },
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 14,
              height: 14,
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                transitionBuilder: (c, a) =>
                    ScaleTransition(scale: a, child: FadeTransition(opacity: a, child: c)),
                child: running
                    ? CircularProgressIndicator(
                        key: const ValueKey('run'),
                        strokeWidth: 2,
                        valueColor: AlwaysStoppedAnimation(color),
                      )
                    : Icon(
                        failed ? Icons.error_outline : Icons.check_circle,
                        key: ValueKey(failed ? 'err' : 'ok'),
                        size: 14,
                        color: color,
                      ),
              ),
            ),
            const SizedBox(width: 9),
            Text(
              tool.name,
              style: const TextStyle(
                color: TalonColors.text,
                fontSize: 13,
                fontWeight: FontWeight.w600,
                fontFamily: 'monospace',
              ),
            ),
            if (_arg(tool) != null) ...[
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  _arg(tool)!,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    color: TalonColors.textFaint,
                    fontSize: 12,
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            ],
            const SizedBox(width: 10),
            Text(
              _fmt(tool.elapsed),
              style: const TextStyle(
                color: TalonColors.textFaint,
                fontSize: 11.5,
                fontFeatures: [FontFeature.tabularFigures()],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String? _arg(ToolActivity t) {
    if (t.input.isEmpty) return null;
    for (final key in const ['query', 'url', 'path', 'text', 'name', 'command']) {
      final v = t.input[key];
      if (v is String && v.isNotEmpty) {
        return v.length > 64 ? '${v.substring(0, 63)}…' : v;
      }
    }
    return null;
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

class _ReasoningStrip extends StatelessWidget {
  final String text;
  const _ReasoningStrip({required this.text});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          border: const Border(
            left: BorderSide(color: TalonColors.accent, width: 2.5),
          ),
          color: TalonColors.glassFill,
        ),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Icon(Icons.bubble_chart_outlined,
                size: 15, color: TalonColors.textFaint),
            const SizedBox(width: 8),
            Expanded(
              child: AnimatedSize(
                duration: const Duration(milliseconds: 180),
                curve: Curves.easeOut,
                alignment: Alignment.topLeft,
                child: Text(
                  text.trim(),
                  maxLines: 5,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
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
  }
}

class _TypingDots extends StatefulWidget {
  const _TypingDots();

  @override
  State<_TypingDots> createState() => _TypingDotsState();
}

class _TypingDotsState extends State<_TypingDots>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))
        ..repeat();

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 20,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Row(
            mainAxisSize: MainAxisSize.min,
            children: List.generate(3, (i) {
              final phase = (_c.value + i * 0.2) % 1.0;
              final o = 0.3 + 0.7 * (0.5 - (phase - 0.5).abs()) * 2;
              return Padding(
                padding: const EdgeInsets.symmetric(horizontal: 3),
                child: Container(
                  width: 7,
                  height: 7,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: TalonColors.textDim.withValues(alpha: o.clamp(0, 1)),
                  ),
                ),
              );
            }),
          );
        },
      ),
    );
  }
}
