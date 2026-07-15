import 'package:flutter/material.dart';

import '../theme.dart';
import 'brand.dart';

/// Shared response card for completed and live assistant turns.
///
/// Keeping both states in the same silhouette prevents the streaming reply
/// from jumping when it becomes history, and gives the light conversation
/// canvas the same crisp card language as Settings.
class AssistantSurface extends StatelessWidget {
  final String botName;
  final Widget? trailing;
  final Widget child;
  final Key? surfaceKey;

  const AssistantSurface({
    super.key,
    required this.botName,
    required this.child,
    this.trailing,
    this.surfaceKey,
  });

  @override
  Widget build(BuildContext context) {
    final dark = TalonTheme.isDark;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Container(
        key: surfaceKey,
        padding: const EdgeInsets.fromLTRB(14, 13, 14, 12),
        decoration: BoxDecoration(
          color: dark
              ? TalonColors.surface.withValues(alpha: 0.54)
              : TalonColors.surface.withValues(alpha: 0.96),
          borderRadius: const BorderRadius.only(
            topLeft: Radius.circular(20),
            topRight: Radius.circular(20),
            bottomRight: Radius.circular(20),
            bottomLeft: Radius.circular(7),
          ),
          border: Border.all(color: TalonColors.glassStroke),
          boxShadow: dark
              ? null
              : [
                  BoxShadow(
                    color: const Color(0xFF171A3D).withValues(alpha: 0.055),
                    blurRadius: 18,
                    offset: const Offset(0, 5),
                  ),
                ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const BrandMark(size: 26),
                const SizedBox(width: 10),
                Expanded(child: Text(botName, style: TalonType.subtitle)),
                if (trailing != null) trailing!,
              ],
            ),
            const SizedBox(height: 11),
            child,
          ],
        ),
      ),
    );
  }
}
