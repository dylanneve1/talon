import 'package:flutter/material.dart';

import '../theme.dart';

/// A single, shared "there's nothing here" panel.
///
/// Empty lists used to be rendered ad hoc — one screen showed a centred line of
/// grey text, another a bare [Glass] box, a third a hand-rolled icon/title/body
/// column. Same moment in the app, three different answers. [TalonEmptyState]
/// is the one answer: an optional icon, a title, an optional explanatory line,
/// and an optional action, laid out on the shared spacing and type tokens.
///
/// It is deliberately quiet — an empty list is a normal state, not an error, so
/// nothing here shouts. Screens that failed to load should keep using their own
/// error panel with a Retry button instead.
class TalonEmptyState extends StatelessWidget {
  /// Leading glyph. Omit for the tightest variants (inline lists, filters).
  final IconData? icon;

  /// One short line naming the state, e.g. "No matching log lines".
  final String title;

  /// Optional second line saying what would fill it.
  final String? message;

  /// Optional single action, usually "Retry" or "Clear filters".
  final Widget? action;

  /// Compact layout for panels embedded in a scrolling settings page, as
  /// opposed to a whole screen's body.
  final bool compact;

  const TalonEmptyState({
    super.key,
    required this.title,
    this.icon,
    this.message,
    this.action,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final gap = compact ? TalonSpace.sm : TalonSpace.md;
    // The whole block reads as one announcement to a screen reader rather than
    // three unrelated fragments.
    return Semantics(
      container: true,
      label: message == null ? title : '$title. $message',
      child: Center(
        child: Padding(
          padding: EdgeInsets.all(compact ? TalonSpace.lg : TalonSpace.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[
                ExcludeSemantics(
                  child: Icon(
                    icon,
                    size: compact ? 26 : 34,
                    color: TalonColors.textFaint,
                  ),
                ),
                SizedBox(height: gap),
              ],
              ExcludeSemantics(
                child: Text(
                  title,
                  textAlign: TextAlign.center,
                  style: compact
                      ? TextStyle(
                          fontWeight: FontWeight.w600,
                          color: TalonColors.text,
                        )
                      : TalonType.title,
                ),
              ),
              if (message != null) ...[
                const SizedBox(height: TalonSpace.xs + 2),
                ExcludeSemantics(
                  child: Text(
                    message!,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontSize: 12.5,
                      height: 1.5,
                      color: TalonColors.textDim,
                    ),
                  ),
                ),
              ],
              if (action != null) ...[
                SizedBox(height: compact ? TalonSpace.md : TalonSpace.lg),
                action!,
              ],
            ],
          ),
        ),
      ),
    );
  }
}
