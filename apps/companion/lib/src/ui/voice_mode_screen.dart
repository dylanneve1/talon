import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../services/haptics.dart';
import '../state/app_state.dart';
import '../state/voice_session.dart';
import '../theme.dart';
import 'motion.dart';

/// Full-screen voice conversation: a living orb that listens, thinks, and
/// speaks; live captions you can toggle; and the whole agent pipeline (tools
/// included) narrated underneath. Pushed over everything — this is the app's
/// "assistant surface", including when Android's assist gesture launches it.
class VoiceModeScreen extends StatefulWidget {
  final AppState state;
  const VoiceModeScreen({super.key, required this.state});

  /// True while a voice-mode route is mounted. AppShell defers its
  /// conversation-route syncing while this is set (a selection change from
  /// inside the voice session must not push a chat screen over the orb), and
  /// the assist-launch handler uses it to avoid stacking a second session.
  static final ValueNotifier<bool> open = ValueNotifier(false);

  /// The route voice mode always uses: a fade-through with a slight rise, so
  /// entering feels like the orb surfacing rather than a page turn.
  static Route<void> route(AppState state) {
    return PageRouteBuilder<void>(
      fullscreenDialog: true,
      transitionDuration: const Duration(milliseconds: 320),
      reverseTransitionDuration: const Duration(milliseconds: 240),
      pageBuilder: (_, __, ___) => VoiceModeScreen(state: state),
      transitionsBuilder: (_, anim, __, child) {
        final curved =
            CurvedAnimation(parent: anim, curve: Curves.easeOutCubic);
        return FadeTransition(
          opacity: curved,
          child: ScaleTransition(
            scale: Tween(begin: 1.04, end: 1.0).animate(curved),
            child: child,
          ),
        );
      },
    );
  }

  @override
  State<VoiceModeScreen> createState() => _VoiceModeScreenState();
}

class _VoiceModeScreenState extends State<VoiceModeScreen>
    with SingleTickerProviderStateMixin {
  late final VoiceSession _session;
  late final AnimationController _ambient;
  late bool _captions;

  @override
  void initState() {
    super.initState();
    VoiceModeScreen.open.value = true;
    _captions = widget.state.prefs.voiceCaptions;
    _session = VoiceSession(
      widget.state,
      handsFree: widget.state.prefs.voiceHandsFree,
    );
    // One slow clock drives all ambient orb motion; per-phase speeds are
    // derived from it inside the painter.
    _ambient = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 6),
    )..repeat();
    WidgetsBinding.instance.addPostFrameCallback((_) => _session.start());
  }

  @override
  void dispose() {
    VoiceModeScreen.open.value = false;
    _ambient.dispose();
    _session.dispose();
    super.dispose();
  }

  void _toggleCaptions() {
    Haptics.selection();
    setState(() => _captions = !_captions);
    widget.state.prefs.setVoiceCaptions(_captions);
  }

  String _statusFor(VoiceSession s) {
    if (s.muted && s.phase != VoicePhase.speaking) return 'Muted';
    switch (s.phase) {
      case VoicePhase.idle:
        return 'Tap the orb to talk';
      case VoicePhase.arming:
        return 'Opening the microphone…';
      case VoicePhase.listening:
        return 'Listening…';
      case VoicePhase.finalizing:
        return 'Got it…';
      case VoicePhase.thinking:
        final tool = s.toolLabel;
        return tool != null ? 'Running $tool…' : 'Thinking…';
      case VoicePhase.speaking:
        return 'Tap to interrupt';
      case VoicePhase.recovering:
        return s.recoveryText;
      case VoicePhase.error:
        return s.errorText ?? 'Something went wrong';
    }
  }

  @override
  Widget build(BuildContext context) {
    final still = reduceMotion(context);
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Container(
        decoration: BoxDecoration(gradient: TalonColors.backdrop),
        child: SafeArea(
          child: ListenableBuilder(
            listenable: _session,
            builder: (context, _) {
              final s = _session;
              return Column(
                children: [
                  _topBar(context),
                  const Spacer(),
                  // The orb IS the interface: it pulses with the mic while
                  // listening, orbits while thinking, and swells while
                  // speaking. Tap semantics live in the session.
                  GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onTap: () {
                      Haptics.medium();
                      s.onOrbTap();
                    },
                    child: AnimatedBuilder(
                      animation: _ambient,
                      builder: (context, _) => CustomPaint(
                        size: const Size.square(240),
                        painter: _OrbPainter(
                          t: still ? 0.25 : _ambient.value,
                          phase: s.phase,
                          level: s.level,
                          muted: s.muted,
                          palette: TalonTheme.palette,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 28),
                  // Status line morphs between phases.
                  AnimatedSwitcher(
                    duration: TalonMotion.base,
                    switchInCurve: Curves.easeOutCubic,
                    switchOutCurve: Curves.easeIn,
                    transitionBuilder: (child, anim) => FadeTransition(
                      opacity: anim,
                      child: SlideTransition(
                        position: Tween(
                          begin: const Offset(0, 0.35),
                          end: Offset.zero,
                        ).animate(anim),
                        child: child,
                      ),
                    ),
                    child: Text(
                      _statusFor(s),
                      key: ValueKey(
                        '${s.phase}·${s.toolLabel}·${s.muted}·${s.errorText}',
                      ),
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w600,
                        color: s.phase == VoicePhase.error
                            ? TalonColors.bad
                            : TalonColors.textDim,
                      ),
                    ),
                  ),
                  const Spacer(),
                  _captionsPanel(s),
                  const SizedBox(height: 18),
                  _controls(s),
                  const SizedBox(height: 22),
                ],
              );
            },
          ),
        ),
      ),
    );
  }

  Widget _topBar(BuildContext context) {
    final title = widget.state.selectedChat?.title ?? 'Talon';
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 14, 12, 0),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('VOICE MODE', style: TalonType.eyebrow),
                const SizedBox(height: 3),
                Text(
                  title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Close voice mode',
            onPressed: () => Navigator.of(context).maybePop(),
            icon: Icon(Icons.keyboard_arrow_down_rounded,
                size: 28, color: TalonColors.textDim),
          ),
        ],
      ),
    );
  }

  /// Live captions: what Talon heard, then what it's saying. The whole panel
  /// slides + fades away when captions are off — AnimatedSwitcher with a
  /// SizeTransition so the layout closes up smoothly instead of snapping.
  Widget _captionsPanel(VoiceSession s) {
    final userLine =
        (s.phase == VoicePhase.listening || s.phase == VoicePhase.finalizing) &&
                s.partial.isNotEmpty
            ? s.partial
            : s.lastUserText;
    final assistantLine = s.assistantCaption;
    final hasContent = userLine.isNotEmpty || assistantLine.isNotEmpty;
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 280),
      switchInCurve: Curves.easeOutCubic,
      switchOutCurve: Curves.easeInCubic,
      transitionBuilder: (child, anim) => FadeTransition(
        opacity: anim,
        child: SizeTransition(
          sizeFactor: anim,
          alignment: Alignment.bottomCenter,
          child: child,
        ),
      ),
      child: !_captions || !hasContent
          ? const SizedBox(width: double.infinity, key: ValueKey('cc-off'))
          : Container(
              key: const ValueKey('cc-on'),
              width: double.infinity,
              margin: const EdgeInsets.symmetric(horizontal: 20),
              padding: const EdgeInsets.fromLTRB(18, 14, 18, 14),
              constraints: const BoxConstraints(maxHeight: 180),
              decoration: BoxDecoration(
                color: TalonColors.surface.withValues(
                  alpha: TalonTheme.isDark ? 0.6 : 0.92,
                ),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: TalonColors.glassStroke),
              ),
              // reverse:true keeps the newest words in view while the reply
              // streams, without fighting the user's own scrolling.
              child: SingleChildScrollView(
                reverse: true,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (userLine.isNotEmpty)
                      Padding(
                        padding: EdgeInsets.only(
                          bottom: assistantLine.isNotEmpty ? 8 : 0,
                        ),
                        child: Text(
                          userLine,
                          style: TextStyle(
                            fontSize: 13.5,
                            height: 1.45,
                            color: TalonColors.textFaint,
                            fontStyle: FontStyle.italic,
                          ),
                        ),
                      ),
                    if (assistantLine.isNotEmpty)
                      Text(
                        assistantLine,
                        style: TextStyle(
                          fontSize: 14.5,
                          height: 1.5,
                          color: TalonColors.text,
                        ),
                      ),
                  ],
                ),
              ),
            ),
    );
  }

  Widget _controls(VoiceSession s) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        _RoundControl(
          icon: _captions
              ? Icons.closed_caption_rounded
              : Icons.closed_caption_off_outlined,
          label: _captions ? 'Captions on' : 'Captions off',
          active: _captions,
          onTap: _toggleCaptions,
        ),
        const SizedBox(width: 22),
        _RoundControl(
          icon: s.muted ? Icons.mic_off_rounded : Icons.mic_rounded,
          label: s.muted ? 'Unmute mic' : 'Mute mic',
          active: !s.muted,
          warning: s.muted,
          onTap: () {
            Haptics.selection();
            s.toggleMute();
          },
        ),
        const SizedBox(width: 22),
        _RoundControl(
          icon: Icons.close_rounded,
          label: 'End voice mode',
          active: false,
          onTap: () {
            Haptics.selection();
            Navigator.of(context).maybePop();
          },
        ),
      ],
    );
  }
}

/// A circular glass control for the bottom row.
class _RoundControl extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;
  final bool warning;
  final VoidCallback onTap;
  const _RoundControl({
    required this.icon,
    required this.label,
    required this.active,
    required this.onTap,
    this.warning = false,
  });

  @override
  Widget build(BuildContext context) {
    final tint = warning
        ? TalonColors.warn
        : active
            ? TalonColors.accent
            : TalonColors.textDim;
    return Tooltip(
      message: label,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: TalonMotion.fast,
          width: 58,
          height: 58,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: active
                ? TalonColors.accent.withValues(alpha: 0.16)
                : TalonColors.glassFill,
            border: Border.all(
              color: active
                  ? TalonColors.accent.withValues(alpha: 0.55)
                  : TalonColors.glassStroke,
            ),
          ),
          child: Icon(icon, size: 24, color: tint),
        ),
      ),
    );
  }
}

/// The voice orb. Three soft radial blobs orbiting a bright core; motion and
/// scale are keyed to the session phase:
///   arming/recovering → soft concentric breath,
///   listening → pulse follows the mic level,
///   thinking  → slow orbit with a sweeping arc,
///   speaking  → rhythmic swell,
///   idle/muted/error → near-still.
class _OrbPainter extends CustomPainter {
  final double t; // 0..1 ambient clock
  final VoicePhase phase;
  final double level; // 0..1 smoothed mic level
  final bool muted;
  final TalonPalette palette;

  _OrbPainter({
    required this.t,
    required this.phase,
    required this.level,
    required this.muted,
    required this.palette,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final c = size.center(Offset.zero);
    const tau = 2 * math.pi;

    // Per-phase energy: how much the blobs breathe and drift.
    final double energy;
    switch (phase) {
      case VoicePhase.listening:
        energy = muted ? 0.06 : 0.25 + level * 0.75;
      case VoicePhase.arming:
        energy = 0.16 + 0.08 * (0.5 + 0.5 * math.sin(t * tau * 2));
      case VoicePhase.finalizing:
        energy = 0.28;
      case VoicePhase.speaking:
        // Synthetic rhythm — TTS gives no level feedback, so fake a cadence.
        energy = 0.45 + 0.35 * (0.5 + 0.5 * math.sin(t * tau * 7));
      case VoicePhase.thinking:
        energy = 0.22;
      case VoicePhase.recovering:
        energy = 0.13 + 0.07 * (0.5 + 0.5 * math.sin(t * tau * 1.5));
      case VoicePhase.idle:
      case VoicePhase.error:
        energy = 0.10;
    }

    final base = size.shortestSide * 0.30;
    final swell = base * (1 + energy * 0.22);

    // Ambient halo.
    canvas.drawCircle(
      c,
      swell * 1.9,
      Paint()
        ..shader = RadialGradient(
          colors: [
            palette.accent.withValues(alpha: 0.10 + energy * 0.10),
            palette.accent.withValues(alpha: 0),
          ],
        ).createShader(Rect.fromCircle(center: c, radius: swell * 1.9)),
    );

    // Three drifting blobs, each on its own slow orbit and hue.
    final blobs = [
      (palette.accent, 1.0, 0.0),
      (palette.accent2, 1.6, tau / 3),
      (palette.accentDeep, 2.2, 2 * tau / 3),
    ];
    for (final (color, speed, phi) in blobs) {
      final a = t * tau * speed + phi;
      final drift = swell * (0.16 + energy * 0.10);
      final off = Offset(math.cos(a) * drift, math.sin(a * 1.3) * drift);
      final r = swell * (0.85 + 0.10 * math.sin(a * 1.7));
      canvas.drawCircle(
        c + off,
        r,
        Paint()
          ..shader = RadialGradient(
            colors: [
              color.withValues(alpha: 0.55),
              color.withValues(alpha: 0.0),
            ],
          ).createShader(Rect.fromCircle(center: c + off, radius: r)),
      );
    }

    // Bright core.
    canvas.drawCircle(
      c,
      swell * 0.58,
      Paint()
        ..shader = RadialGradient(
          colors: [
            Colors.white.withValues(
                alpha: palette.brightness == Brightness.dark ? 0.9 : 0.95),
            palette.accent.withValues(alpha: 0.65),
            palette.accent.withValues(alpha: 0.0),
          ],
          stops: const [0.0, 0.45, 1.0],
        ).createShader(Rect.fromCircle(center: c, radius: swell * 0.58)),
    );

    // Thinking: a sweeping arc that says "working" even when audio is quiet.
    if (phase == VoicePhase.thinking) {
      final rect = Rect.fromCircle(center: c, radius: swell * 1.28);
      canvas.drawArc(
        rect,
        t * tau * 2,
        tau * 0.28,
        false,
        Paint()
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.4
          ..strokeCap = StrokeCap.round
          ..shader = SweepGradient(
            startAngle: 0,
            endAngle: tau,
            colors: [
              palette.accent2.withValues(alpha: 0),
              palette.accent2.withValues(alpha: 0.9),
            ],
            transform: GradientRotation(t * tau * 2),
          ).createShader(rect),
      );
    }

    // Arming and silent-room recovery should feel alive, not broken: two
    // feather-light rings travel out from the core and dissolve.
    if (phase == VoicePhase.arming || phase == VoicePhase.recovering) {
      for (var i = 0; i < 2; i++) {
        final progress = (t * 1.35 + i * 0.5) % 1.0;
        final radius = swell * (0.82 + progress * 0.72);
        canvas.drawCircle(
          c,
          radius,
          Paint()
            ..style = PaintingStyle.stroke
            ..strokeWidth = 1.8
            ..color = palette.accent2.withValues(
              alpha: (1 - progress) * 0.34,
            ),
        );
      }
    }

    // Muted: a quiet slash over the core so the state is unmissable.
    if (muted && phase != VoicePhase.speaking) {
      final p = Paint()
        ..color = palette.text.withValues(alpha: 0.55)
        ..strokeWidth = 3
        ..strokeCap = StrokeCap.round;
      final d = swell * 0.4;
      canvas.drawLine(c + Offset(-d, -d), c + Offset(d, d), p);
    }
  }

  @override
  bool shouldRepaint(_OrbPainter old) =>
      old.t != t ||
      old.phase != phase ||
      old.level != level ||
      old.muted != muted ||
      old.palette != palette;
}
