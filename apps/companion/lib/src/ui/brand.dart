import 'package:flutter/material.dart';

import '../theme.dart';

/// The Talon glyph: a gradient rounded-square holding three converging talon
/// strokes. Drawn, not an asset, so it stays crisp at any size on any platform.
class BrandMark extends StatelessWidget {
  final double size;
  const BrandMark({super.key, this.size = 36});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.28),
        gradient: TalonColors.accentGradient,
        boxShadow: [
          BoxShadow(
            color: TalonColors.accent.withValues(alpha: 0.45),
            blurRadius: size * 0.5,
            offset: Offset(0, size * 0.14),
          ),
        ],
      ),
      child: Padding(
        padding: EdgeInsets.all(size * 0.24),
        child: CustomPaint(painter: _TalonPainter()),
      ),
    );
  }
}

class _TalonPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = size.width * 0.14
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    final w = size.width, h = size.height;
    // Three curved claws converging toward the lower point.
    for (final dx in [0.0, 0.32, 0.64]) {
      final path = Path()
        ..moveTo(w * (0.08 + dx), h * 0.05)
        ..quadraticBezierTo(
          w * (0.12 + dx),
          h * 0.62,
          w * (0.40 + dx * 0.4),
          h * 0.95,
        );
      canvas.drawPath(path, paint);
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
