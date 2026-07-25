import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'chat_actions.dart';

/// Short token counts for tight UI: `840`, `12.4k`, `128k`, `1.2M`. Shared with
/// the header's context pill so the sheet and the pill can never disagree about
/// how a figure is spelled.
String formatTokens(int n) {
  if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
  if (n >= 1000) return '${(n / 1000).toStringAsFixed(n >= 10000 ? 0 : 1)}k';
  return '$n';
}

/// The context-window detail sheet, opened by tapping the header's context
/// pill.
///
/// The pill used to be a dead end: a ring, a percentage, and a tooltip holding
/// the only copy of the raw token figures in the whole app. Tooltips don't
/// exist as an affordance on touch, so on a phone those numbers were
/// unreachable — and the moment the window crosses [ContextInfo.warn] is
/// exactly when the user needs both the figures and the remedy. This sheet
/// carries all three: the numbers, an explanation of what filling up costs
/// them, and the reset that empties the window.
///
/// A modal bottom sheet rather than a desktop popover because it has to work on
/// both: an anchored menu would be a hover-scale surface on a phone, whereas a
/// bottom sheet is already this app's cross-platform detail idiom (see
/// `openModelSheet` and `showChatActionsSheet`). On a wide window it is
/// constrained to a readable measure instead of stretching the copy across the
/// whole display.
Future<void> openContextSheet(
  BuildContext context,
  AppState state,
  ClientChat chat,
) async {
  final action = await showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    backgroundColor: TalonColors.surface,
    constraints: const BoxConstraints(maxWidth: 520),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(TalonRadius.lg)),
    ),
    builder: (_) => _ContextSheet(
      state: state,
      chatId: chat.id,
      lastKnown: chat.context,
    ),
  );
  if (action != 'reset' || !context.mounted) return;
  // The confirm + reset + snackbar sequence is shared with the action sheet and
  // the header's overflow menu, so all three ask the same question.
  await confirmResetSession(context, state, chat);
}

class _ContextSheet extends StatelessWidget {
  final AppState state;
  final String chatId;

  /// The figures the pill was showing when the sheet opened, used only if the
  /// chat itself disappears from [AppState.chats] (deleted from another client)
  /// while the sheet is up.
  final ContextInfo? lastKnown;

  const _ContextSheet({
    required this.state,
    required this.chatId,
    required this.lastKnown,
  });

  /// The live figures. Subscribed rather than snapshotted because a turn
  /// running behind the sheet pushes `chat_updated` events, and a readout that
  /// froze at open time would be the same half-truth as the old tooltip.
  ContextInfo? get _info {
    for (final c in state.chats) {
      if (c.id == chatId) return c.context;
    }
    return lastKnown;
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: state,
      builder: (context, _) => SafeArea(
        child: SingleChildScrollView(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              TalonSpace.lg,
              TalonSpace.md,
              TalonSpace.lg,
              TalonSpace.lg,
            ),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: _content(context),
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _content(BuildContext context) {
    final info = _info;
    // Three shapes, tested inline rather than through helper booleans so the
    // null-promotion is unambiguous: full figures, usage without a window size
    // (some backends report one and not the other), and no figures at all —
    // which is also the state right after a reset, since the daemon drops the
    // chat's context entry. In every case the sheet still explains the window
    // and offers the remedy; only the plot goes away.
    final warn = info != null && info.known && info.warn;
    final tint = warn ? TalonColors.warn : TalonColors.accent;

    return [
      Center(
        child: Container(
          width: 40,
          height: 4,
          decoration: BoxDecoration(
            color: TalonColors.textFaint,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
      const SizedBox(height: TalonSpace.lg),
      Row(
        children: [
          Icon(Icons.donut_large_rounded, size: 18, color: tint),
          const SizedBox(width: TalonSpace.sm),
          Expanded(child: Text('Context window', style: TalonType.subtitle)),
          if (info != null && info.known)
            // Status carried by words as well as colour, like tool_timeline's
            // badges — the amber alone is invisible to a colour-blind or
            // grayscale reader.
            _StateBadge(
              label: warn ? 'Filling up' : 'Healthy',
              color: warn ? TalonColors.warn : TalonColors.ok,
            ),
        ],
      ),
      const SizedBox(height: TalonSpace.lg),
      if (info == null || !info.known)
        Text(
          'This chat has no context figures yet — the backend reports them '
          'once the session has run a turn.',
          style: TalonType.caption,
        )
      else if (info.max <= 0) ...[
        Text(
          '${formatTokens(info.used)} tokens in play',
          style: TalonType.display.copyWith(fontSize: 24),
        ),
        const SizedBox(height: TalonSpace.xs),
        Text(
          'This backend reports usage but not a window size, so there is no '
          'percentage to plot.',
          style: TalonType.caption,
        ),
      ] else ...[
        Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Text(
              '${info.pct.clamp(0, 100)}%',
              style: TalonType.display.copyWith(fontSize: 30, color: tint),
            ),
            const SizedBox(width: TalonSpace.xs),
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text('used', style: TalonType.caption),
            ),
            // Expanded rather than a Spacer + fixed text: at a large UI text
            // scale (Settings can push it well past 1.0) the token figures
            // would otherwise run past the sheet's edge instead of eliding.
            Expanded(
              child: Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text(
                  '${formatTokens(info.used)} / ${formatTokens(info.max)}'
                  ' tokens',
                  textAlign: TextAlign.right,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TalonType.mono.copyWith(
                    fontSize: 12.5,
                    color: TalonColors.textDim,
                    fontFeatures: const [FontFeature.tabularFigures()],
                  ),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: TalonSpace.sm),
        // A proportional bar rather than the header's ring: at sheet width the
        // bar reads as "how much room is left" at a glance, which the 13px ring
        // never could.
        _FillBar(fraction: info.pct.clamp(0, 100) / 100, color: tint),
      ],
      const SizedBox(height: TalonSpace.lg),
      Text(
        'Every message, reply, tool result and file in this chat shares one '
        'window. As it fills, the oldest turns drop out of what the model can '
        'see: earlier details get forgotten, and each new turn costs more to '
        'produce.',
        style: TalonType.body.copyWith(color: TalonColors.textDim),
      ),
      if (warn) ...[
        const SizedBox(height: TalonSpace.md),
        Container(
          padding: const EdgeInsets.all(TalonSpace.md),
          decoration: BoxDecoration(
            color: TalonColors.warn.withValues(alpha: 0.12),
            borderRadius: TalonRadius.rMd,
            border: Border.all(color: TalonColors.warn.withValues(alpha: 0.35)),
          ),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(Icons.warning_amber_rounded,
                  size: 17, color: TalonColors.warn),
              const SizedBox(width: TalonSpace.sm),
              Expanded(
                child: Text(
                  'Nearly full. Replies may start losing earlier detail — '
                  'reset to start this conversation from a clean window.',
                  style: TalonType.label.copyWith(color: TalonColors.warn),
                ),
              ),
            ],
          ),
        ),
      ],
      const SizedBox(height: TalonSpace.lg),
      SizedBox(
        width: double.infinity,
        child: FilledButton.icon(
          onPressed: () => Navigator.pop(context, 'reset'),
          icon: const Icon(Icons.refresh, size: 18),
          label: const Text('Reset session'),
        ),
      ),
      const SizedBox(height: TalonSpace.sm),
      Text(
        'Empties the window and clears this chat’s stored transcript. You will '
        'be asked to confirm.',
        style: TalonType.caption,
      ),
    ];
  }
}

/// Word + colour status pill, matching the tool timeline's badge silhouette.
class _StateBadge extends StatelessWidget {
  final String label;
  final Color color;
  const _StateBadge({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: TalonRadius.rPill,
        border: Border.all(color: color.withValues(alpha: 0.3)),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: color,
          fontSize: 10.5,
          fontWeight: FontWeight.w700,
          letterSpacing: 0.3,
        ),
      ),
    );
  }
}

/// Proportional fill bar. [fraction] is already clamped to 0..1 by the caller.
class _FillBar extends StatelessWidget {
  final double fraction;
  final Color color;
  const _FillBar({required this.fraction, required this.color});

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: TalonRadius.rPill,
      child: Container(
        height: 10,
        color: TalonColors.glassStroke,
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: fraction,
          heightFactor: 1,
          child: ColoredBox(color: color),
        ),
      ),
    );
  }
}
