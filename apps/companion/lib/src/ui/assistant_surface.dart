import 'package:flutter/material.dart';

import '../theme.dart';
import 'brand.dart';

/// Shared assistant-turn layout for completed and live turns.
///
/// The identity header (avatar + name + timestamp / live badge), the tool
/// activity, and the stats footer all live OUTSIDE the reply bubble on the
/// open canvas — only the reply content itself wears the bubble, like a chat
/// app. Keeping live and history turns in the same silhouette prevents the
/// streaming reply from jumping when it becomes history.
class AssistantSurface extends StatelessWidget {
  final String botName;

  /// Small widget beside the name: a clock stamp in history, the live badge
  /// while streaming. Sits in the header row, outside the bubble.
  final Widget? trailing;

  /// Rendered on the canvas between the header and the bubble — tool
  /// timelines / traces, reasoning strips.
  final Widget? aboveBubble;

  /// The reply content. Wrapped in the response bubble; null renders no
  /// bubble at all (e.g. a live turn that hasn't produced text yet).
  final Widget? bubble;

  /// Rendered on the canvas under the bubble — copy action, token/duration
  /// stats, buttons, reactions, typing indicators.
  final Widget? belowBubble;

  /// Applied to the bubble container so tests/screenshots can find it.
  final Key? surfaceKey;

  /// False for a turn grouped under the previous assistant row: the avatar +
  /// name header is skipped (the run's first row already carries it) and the
  /// content stays aligned by an avatar-width gutter.
  final bool showHeader;

  const AssistantSurface({
    super.key,
    required this.botName,
    this.trailing,
    this.aboveBubble,
    this.bubble,
    this.belowBubble,
    this.surfaceKey,
    this.showHeader = true,
  });

  @override
  Widget build(BuildContext context) {
    final dark = TalonTheme.isDark;
    return Padding(
      padding: EdgeInsets.only(top: showHeader ? 10 : 2, bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (showHeader)
            const Padding(
              padding: EdgeInsets.only(top: 1),
              child: BrandMark(size: 26),
            )
          else
            const SizedBox(width: 26),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Identity header on the canvas, not in the bubble.
                if (showHeader) ...[
                  Padding(
                    padding: const EdgeInsets.only(top: 3),
                    child: Row(
                      children: [
                        Flexible(
                          child: Text(
                            botName,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TalonType.subtitle,
                          ),
                        ),
                        if (trailing != null) ...[
                          const SizedBox(width: TalonSpace.sm),
                          trailing!,
                        ],
                      ],
                    ),
                  ),
                  const SizedBox(height: 7),
                ],
                // Tool calls / reasoning live on the canvas above the reply.
                if (aboveBubble != null) ...[
                  aboveBubble!,
                  const SizedBox(height: 4),
                ],
                if (bubble != null)
                  Container(
                    key: surfaceKey,
                    padding: const EdgeInsets.fromLTRB(14, 11, 14, 11),
                    decoration: BoxDecoration(
                      color: dark
                          ? TalonColors.surface.withValues(alpha: 0.54)
                          : TalonColors.surface.withValues(alpha: 0.96),
                      borderRadius: const BorderRadius.only(
                        topLeft: Radius.circular(7),
                        topRight: Radius.circular(20),
                        bottomRight: Radius.circular(20),
                        bottomLeft: Radius.circular(20),
                      ),
                      border: Border.all(color: TalonColors.glassStroke),
                      boxShadow: dark
                          ? null
                          : [
                              BoxShadow(
                                color: const Color(0xFF171A3D)
                                    .withValues(alpha: 0.055),
                                blurRadius: 18,
                                offset: const Offset(0, 5),
                              ),
                            ],
                    ),
                    child: bubble!,
                  ),
                // Stats / actions footer on the canvas below the bubble.
                if (belowBubble != null) belowBubble!,
              ],
            ),
          ),
        ],
      ),
    );
  }
}
