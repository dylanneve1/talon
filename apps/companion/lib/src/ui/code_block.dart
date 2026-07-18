import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_highlight/flutter_highlight.dart';
import 'package:flutter_highlight/themes/atom-one-dark.dart';
import 'package:flutter_highlight/themes/atom-one-light.dart';
import 'package:flutter_markdown/flutter_markdown.dart';
import 'package:markdown/markdown.dart' as md;

import '../theme.dart';

/// Renders fenced code blocks as framed, syntax-highlighted panels with a
/// language tag and a copy button — inline code falls through to the default
/// markdown styling (returning null keeps flutter_markdown's own rendering).
class CodeElementBuilder extends MarkdownElementBuilder {
  @override
  Widget? visitElementAfter(md.Element element, TextStyle? preferredStyle) {
    var language = '';
    final className = element.attributes['class'];
    if (className != null && className.startsWith('language-')) {
      language = className.substring('language-'.length);
    }
    final code = element.textContent;
    // Fenced blocks carry a language class or contain newlines; single-line
    // `inline code` gets the default pill styling from the stylesheet.
    final isBlock = language.isNotEmpty || code.contains('\n');
    if (!isBlock) return null;
    return CodeBlock(code: code.trimRight(), language: language);
  }
}

class CodeBlock extends StatefulWidget {
  final String code;
  final String language;
  const CodeBlock({super.key, required this.code, this.language = ''});

  @override
  State<CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends State<CodeBlock> {
  bool _copied = false;

  /// Tabs render as a single space-ish advance in Flutter text, collapsing
  /// indentation — expand for display. The clipboard keeps the original.
  String get _display => widget.code.replaceAll('\t', '    ');

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    Future.delayed(const Duration(milliseconds: 1400), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 6),
      decoration: BoxDecoration(
        // On light mode the tinted fill reads as a weird grey slab; the
        // syntax colors + monospace font carry the "this is code" signal on
        // their own, so keep the panel frameless there (border alone delimits
        // it). Dark mode keeps the subtle inky panel.
        color: TalonTheme.isDark
            ? TalonColors.void0.withValues(alpha: 0.65)
            : Colors.transparent,
        borderRadius: TalonRadius.rMd,
        border: Border.all(color: TalonColors.glassStroke),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Header strip: language tag + copy affordance.
          Container(
            padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(color: TalonColors.glassStroke),
              ),
            ),
            child: Row(
              children: [
                Text(
                  widget.language.isEmpty ? 'code' : widget.language,
                  style: TalonType.mono.copyWith(
                    fontSize: 11,
                    color: TalonColors.textFaint,
                    letterSpacing: 0.4,
                  ),
                ),
                const Spacer(),
                InkWell(
                  onTap: _copy,
                  borderRadius: TalonRadius.rSm,
                  child: Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          _copied ? Icons.check : Icons.copy_rounded,
                          size: 13,
                          color:
                              _copied ? TalonColors.ok : TalonColors.textFaint,
                        ),
                        const SizedBox(width: 5),
                        Text(
                          _copied ? 'Copied' : 'Copy',
                          style: TextStyle(
                            fontSize: 11,
                            color: _copied
                                ? TalonColors.ok
                                : TalonColors.textFaint,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          _FadingHScroll(
            padding: const EdgeInsets.all(12),
            // SelectionArea makes both branches selectable — HighlightView
            // is a plain RichText, so without it highlighted code (unlike
            // the plain branch) couldn't be selected at all.
            child: SelectionArea(
              child: widget.language.isEmpty
                  ? Text(
                      _display,
                      style:
                          TalonType.mono.copyWith(fontSize: 12.5, height: 1.5),
                    )
                  : Builder(builder: (context) {
                      final base = TalonTheme.isDark
                          ? atomOneDarkTheme
                          : atomOneLightTheme;
                      return HighlightView(
                        _display,
                        language: widget.language,
                        theme: {
                          ...base,
                          'root': (base['root'] ?? const TextStyle())
                              .copyWith(backgroundColor: Colors.transparent),
                        },
                        textStyle: TalonType.mono
                            .copyWith(fontSize: 12.5, height: 1.5),
                      );
                    }),
            ),
          ),
        ],
      ),
    );
  }
}


/// Horizontal code scroller whose overflowing edge fades out — the cue that
/// there's more off-screen. A hard clip at the panel border reads as
/// truncated output, not scrollable code.
class _FadingHScroll extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const _FadingHScroll({required this.child, required this.padding});

  @override
  State<_FadingHScroll> createState() => _FadingHScrollState();
}

class _FadingHScrollState extends State<_FadingHScroll> {
  final ScrollController _controller = ScrollController();
  bool _fadeStart = false;
  bool _fadeEnd = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_update);
    // Extents aren't known until after the first layout.
    WidgetsBinding.instance.addPostFrameCallback((_) => _update());
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _update() {
    if (!mounted || !_controller.hasClients) return;
    final pos = _controller.position;
    final start = pos.extentBefore > 1;
    final end = pos.extentAfter > 1;
    if (start != _fadeStart || end != _fadeEnd) {
      setState(() {
        _fadeStart = start;
        _fadeEnd = end;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return NotificationListener<ScrollMetricsNotification>(
      // Fires when content/viewport size changes (e.g. streaming appends a
      // longer line) — scroll offsets go through the controller listener.
      onNotification: (_) {
        _update();
        return false;
      },
      child: ShaderMask(
        shaderCallback: (rect) {
          // dstIn: the gradient's alpha masks the child, so the fade works
          // over any panel/bubble background without color-matching it.
          final fade = (24.0 / rect.width).clamp(0.0, 0.35);
          return LinearGradient(
            begin: Alignment.centerLeft,
            end: Alignment.centerRight,
            colors: const [
              Colors.transparent,
              Colors.white,
              Colors.white,
              Colors.transparent,
            ],
            stops: [
              0,
              _fadeStart ? fade : 0,
              _fadeEnd ? 1 - fade : 1,
              1,
            ],
          ).createShader(rect);
        },
        blendMode: BlendMode.dstIn,
        child: SingleChildScrollView(
          controller: _controller,
          scrollDirection: Axis.horizontal,
          padding: widget.padding,
          child: widget.child,
        ),
      ),
    );
  }
}
