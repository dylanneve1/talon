import 'package:flutter/material.dart';

import '../theme.dart';

/// The Talon mark: the same falcon-on-dark-tile as the platform launcher
/// icons, drawn as a vector so it stays crisp at any size. The geometry and
/// gradients mirror assets/icon/talon_icon.svg exactly (1024 viewbox) — keep
/// the two in sync when the icon changes.
class BrandMark extends StatelessWidget {
  final double size;
  const BrandMark({super.key, this.size = 36});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        // Matches the icon tile's corner radius (230/1024).
        borderRadius: BorderRadius.circular(size * 0.225),
        boxShadow: [
          BoxShadow(
            color: TalonColors.accent.withValues(alpha: 0.22),
            blurRadius: size * 0.28,
            offset: Offset(0, size * 0.1),
          ),
        ],
      ),
      child: const CustomPaint(painter: _FalconIconPainter()),
    );
  }
}

class _FalconIconPainter extends CustomPainter {
  const _FalconIconPainter();

  // Fixed brand colors from the icon artwork — deliberately not theme tokens,
  // so the mark is identical to the launcher icon in both light and dark.
  static const _tileTop = Color(0xFF171A2B);
  static const _tileBottom = Color(0xFF0A0B12);
  static const _bird0 = Color(0xFF8E9BFF);
  static const _bird1 = Color(0xFF6E7EFF);
  static const _bird2 = Color(0xFF54E6FF);

  @override
  void paint(Canvas canvas, Size size) {
    // Draw in the SVG's 1024-unit space and let the canvas scale.
    final k = size.width / 1024;
    canvas.save();
    canvas.scale(k, size.height / 1024);

    const rect = Rect.fromLTWH(0, 0, 1024, 1024);
    final tile = RRect.fromRectAndRadius(rect, const Radius.circular(230));
    canvas.drawRRect(
      tile,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [_tileTop, _tileBottom],
        ).createShader(
          const Rect.fromLTRB(160, 120, 880, 920),
        ),
    );
    canvas.drawRRect(
      tile.deflate(1),
      Paint()
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2
        ..color = Colors.white.withValues(alpha: 0.06),
    );

    final bird = Path()
      ..moveTo(512, 306)
      ..cubicTo(500, 306, 492, 313, 489, 325)
      ..lineTo(460, 462)
      ..cubicTo(358, 438, 240, 442, 142, 494)
      ..cubicTo(246, 512, 340, 548, 412, 602)
      ..lineTo(446, 626)
      ..cubicTo(464, 640, 484, 658, 494, 690)
      ..cubicTo(500, 712, 506, 732, 512, 752)
      ..cubicTo(518, 732, 524, 712, 530, 690)
      ..cubicTo(540, 658, 560, 640, 578, 626)
      ..lineTo(612, 602)
      ..cubicTo(684, 548, 778, 512, 882, 494)
      ..cubicTo(784, 442, 666, 438, 564, 462)
      ..lineTo(535, 325)
      ..cubicTo(532, 313, 524, 306, 512, 306)
      ..close();
    canvas.drawPath(
      bird,
      Paint()
        ..shader = const LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [_bird0, _bird1, _bird2],
          stops: [0, 0.55, 1],
        ).createShader(const Rect.fromLTRB(300, 300, 760, 760)),
    );

    canvas.restore();
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}
