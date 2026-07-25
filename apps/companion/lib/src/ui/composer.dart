import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../services/haptics.dart';
import '../theme.dart';

/// Result of an image upload: the relative render path + on-disk path.
typedef UploadResult = ({String imagePath, String path});

/// The message input. Enter sends; Shift+Enter inserts a newline. Grows with
/// content up to a cap, then scrolls. Supports attaching a single image, which
/// is uploaded on send and passed through to the model.
class Composer extends StatefulWidget {
  /// Sends the message; resolves false when the daemon rejected it (dead
  /// bridge, network error) so the draft can be handed back to the user.
  final Future<bool> Function(
    String text, {
    String? imagePath,
    String? attachmentPath,
  }) onSend;
  final Future<UploadResult?> Function(
    List<int> bytes,
    String filename,
    String contentType,
  ) onUpload;
  final bool enabled;

  /// True while a turn is running for this chat. When set (and the input is
  /// empty) the send button morphs into a stop button — the ChatGPT/Claude
  /// pattern. Typing still turns it back into send so a follow-up can queue.
  final bool running;

  /// Interrupt the running turn. Null when the backend can't interrupt.
  final Future<void> Function()? onStop;

  /// Open full-screen voice mode. Null where voice isn't available (desktop,
  /// no recognizer) — the mic button simply doesn't exist then. Shown in the
  /// send slot while the input is empty, WhatsApp-style.
  final VoidCallback? onVoice;

  const Composer({
    super.key,
    required this.onSend,
    required this.onUpload,
    required this.enabled,
    this.running = false,
    this.onStop,
    this.onVoice,
  });

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  final _controller = TextEditingController();
  final _focus = FocusNode();
  bool _canSend = false;
  bool _uploading = false;
  Uint8List? _pendingBytes;
  String? _pendingName;

  bool _focused = false;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_recomputeCanSend);
    _focus.addListener(() {
      if (_focused != _focus.hasFocus) {
        setState(() => _focused = _focus.hasFocus);
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _recomputeCanSend() {
    final can = _controller.text.trim().isNotEmpty || _pendingBytes != null;
    if (can != _canSend) setState(() => _canSend = can);
  }

  Future<void> _pickImage() async {
    if (!widget.enabled || _uploading) return;
    try {
      final result = await FilePicker.platform.pickFiles(
        type: FileType.image,
        withData: true,
      );
      final file = result?.files.firstOrNull;
      if (file?.bytes == null) return;
      setState(() {
        _pendingBytes = file!.bytes;
        _pendingName = file.name;
      });
      _recomputeCanSend();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Could not pick image: $e')),
        );
      }
    }
  }

  void _clearAttachment() {
    setState(() {
      _pendingBytes = null;
      _pendingName = null;
    });
    _recomputeCanSend();
  }

  Future<void> _send() async {
    final text = _controller.text.trim();
    final bytes = _pendingBytes;
    if ((text.isEmpty && bytes == null) || !widget.enabled || _uploading) {
      return;
    }
    // A send is the one irreversible thing this control does: acknowledge it
    // in the hand, the same way the FAB and long-presses do. Silent on
    // desktop (the engine no-ops) and gated by the Settings haptics switch.
    Haptics.selection();
    final name = _pendingName ?? 'image.jpg';
    _controller.clear();
    setState(() {
      _canSend = false;
      _pendingBytes = null;
      _pendingName = null;
    });
    _focus.requestFocus();

    String? imagePath;
    String? attachmentPath;
    if (bytes != null) {
      setState(() => _uploading = true);
      final up = await widget.onUpload(bytes, name, _contentTypeFor(name));
      if (mounted) setState(() => _uploading = false);
      if (up == null) {
        // Upload failed (a system note explains why). Hand the draft back so
        // the user's message and attachment aren't silently thrown away —
        // unless they already started typing a new one.
        if (mounted) {
          setState(() {
            _pendingBytes = bytes;
            _pendingName = name;
          });
          if (_controller.text.trim().isEmpty) _controller.text = text;
          _recomputeCanSend();
        }
        return;
      }
      imagePath = up.imagePath;
      attachmentPath = up.path;
    }
    final ok = await widget.onSend(
      text,
      imagePath: imagePath,
      attachmentPath: attachmentPath,
    );
    if (!ok && mounted) {
      // Send failed (a system note in the chat explains why). Hand the text
      // back so the message isn't silently thrown away — unless the user
      // already started typing a new one.
      if (_controller.text.trim().isEmpty && text.isNotEmpty) {
        _controller.text = text;
      }
      _recomputeCanSend();
    }
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is KeyDownEvent &&
        (event.logicalKey == LogicalKeyboardKey.enter ||
            event.logicalKey == LogicalKeyboardKey.numpadEnter) &&
        !HardwareKeyboard.instance.isShiftPressed) {
      _send();
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final canSend = _canSend && widget.enabled && !_uploading;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 7, 12, 12),
      // The input is the app's one persistent control, so it floats: layered
      // shadow at rest, and on focus the hairline warms to the accent with a
      // soft matching glow — the "you are here" signal.
      child: AnimatedContainer(
        duration: TalonMotion.base,
        curve: TalonMotion.standard,
        decoration: BoxDecoration(
          color: TalonColors.surface.withValues(
            alpha: TalonTheme.isDark ? 0.72 : 0.96,
          ),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(
            color: _focused
                ? TalonColors.accent.withValues(alpha: 0.65)
                : TalonColors.glassStroke,
            width: _focused ? 1.4 : 1,
          ),
          boxShadow: [
            ...TalonShadows.raised,
            if (_focused)
              BoxShadow(
                color: TalonColors.accent.withValues(alpha: 0.18),
                blurRadius: 20,
                offset: const Offset(0, 2),
              ),
          ],
        ),
        padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (_pendingBytes != null) _attachmentPreview(),
            Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _AttachButton(
                  enabled: widget.enabled && !_uploading,
                  onTap: _pickImage,
                ),
                Expanded(
                  child: Focus(
                    onKeyEvent: _onKey,
                    child: TextField(
                      controller: _controller,
                      focusNode: _focus,
                      enabled: widget.enabled,
                      minLines: 1,
                      maxLines: 6,
                      textInputAction: TextInputAction.newline,
                      keyboardType: TextInputType.multiline,
                      style: TextStyle(
                          fontSize: TalonDensity.d(14.5, 16), height: 1.4),
                      decoration: InputDecoration(
                        isCollapsed: true,
                        border: InputBorder.none,
                        contentPadding:
                            const EdgeInsets.symmetric(vertical: 12),
                        hintText:
                            widget.enabled ? 'Message Talon…' : 'Connecting…',
                        hintStyle: TextStyle(color: TalonColors.textFaint),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                // Stop while a turn runs and there's nothing staged to send;
                // as soon as the user types, it flips back to send-to-queue.
                // The two buttons morph through a scale+fade so the swap reads
                // as one control changing mode, not a replacement.
                AnimatedSwitcher(
                  duration: TalonMotion.base,
                  switchInCurve: TalonMotion.emphasized,
                  switchOutCurve: Curves.easeIn,
                  transitionBuilder: (child, anim) => ScaleTransition(
                    scale: Tween(begin: 0.6, end: 1.0).animate(anim),
                    child: FadeTransition(opacity: anim, child: child),
                  ),
                  child: (widget.running &&
                          !canSend &&
                          !_uploading &&
                          widget.onStop != null)
                      ? _StopButton(
                          key: const ValueKey('stop'), onTap: widget.onStop!)
                      : (!canSend &&
                              !_uploading &&
                              widget.enabled &&
                              !widget.running &&
                              widget.onVoice != null)
                          // Empty input + voice available → the slot offers
                          // voice mode instead of a dead send button.
                          ? _VoiceButton(
                              key: const ValueKey('voice'),
                              onTap: widget.onVoice!,
                            )
                          : _SendButton(
                              key: const ValueKey('send'),
                              enabled: canSend,
                              busy: _uploading,
                              onTap: _send,
                            ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _attachmentPreview() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(6, 6, 6, 2),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: Image.memory(
                _pendingBytes!,
                width: 72,
                height: 72,
                fit: BoxFit.cover,
              ),
            ),
            Positioned(
              top: -6,
              right: -6,
              child: GestureDetector(
                onTap: _clearAttachment,
                child: Container(
                  decoration: BoxDecoration(
                    color: TalonColors.surfaceHi,
                    shape: BoxShape.circle,
                  ),
                  padding: const EdgeInsets.all(2),
                  child: const Icon(Icons.close, size: 15, color: Colors.white),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  static String _contentTypeFor(String name) {
    final n = name.toLowerCase();
    if (n.endsWith('.png')) return 'image/png';
    if (n.endsWith('.gif')) return 'image/gif';
    if (n.endsWith('.webp')) return 'image/webp';
    if (n.endsWith('.bmp')) return 'image/bmp';
    return 'image/jpeg';
  }
}

class _AttachButton extends StatelessWidget {
  final bool enabled;
  final VoidCallback onTap;
  const _AttachButton({required this.enabled, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      onPressed: enabled ? onTap : null,
      icon: Icon(Icons.add_photo_alternate_outlined,
          size: TalonDensity.d(20, 23)),
      color: TalonColors.textDim,
      tooltip: 'Attach image',
    );
  }
}

/// Fills the send slot when there's nothing typed and voice is available:
/// a quiet mic that opens full-screen voice mode. Same footprint as the send
/// button so the AnimatedSwitcher morph between them reads as one control.
class _VoiceButton extends StatelessWidget {
  final VoidCallback onTap;
  const _VoiceButton({super.key, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: 'Voice mode',
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          width: TalonDensity.d(40, 46),
          height: TalonDensity.d(40, 46),
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: [TalonColors.accent, TalonColors.accentDeep],
            ),
            borderRadius: BorderRadius.circular(TalonDensity.d(14, 16)),
            boxShadow: TalonShadows.glow,
          ),
          child: Icon(Icons.mic_rounded,
              color: Colors.white, size: TalonDensity.d(20, 22)),
        ),
      ),
    );
  }
}

/// Shown in the send slot while a turn is generating and the input is empty.
/// A calm square "stop" that pulses gently so it reads as live, and fires the
/// interrupt on tap.
class _StopButton extends StatelessWidget {
  final Future<void> Function() onTap;
  const _StopButton({super.key, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    final button = GestureDetector(
      onTap: () => onTap(),
      child: Container(
        width: TalonDensity.d(40, 46),
        height: TalonDensity.d(40, 46),
        decoration: BoxDecoration(
          color: TalonColors.surfaceHi,
          borderRadius: BorderRadius.circular(TalonDensity.d(13, 15)),
          border: Border.all(color: TalonColors.glassStroke),
        ),
        child: Icon(Icons.stop_rounded,
            color: TalonColors.text, size: TalonDensity.d(22, 24)),
      ),
    );
    return Tooltip(
      message: 'Stop generating',
      child: reduceMotion
          ? button
          : button
              .animate(onPlay: (c) => c.repeat(reverse: true))
              .fadeIn(begin: 0.75, duration: 850.ms, curve: Curves.easeInOut),
    );
  }
}

class _SendButton extends StatefulWidget {
  final bool enabled;
  final bool busy;
  final VoidCallback onTap;
  const _SendButton({
    super.key,
    required this.enabled,
    required this.busy,
    required this.onTap,
  });

  @override
  State<_SendButton> createState() => _SendButtonState();
}

class _SendButtonState extends State<_SendButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final active = widget.enabled;
    final busy = widget.busy;
    // Coloured while there's something to send OR an upload is in flight.
    final colored = active || busy;
    // Springs up to full size + full colour when actionable, dips under the
    // finger, softens to a flat idle state when empty, and shows a spinner
    // while the attached image uploads.
    return GestureDetector(
      onTapDown: active ? (_) => setState(() => _pressed = true) : null,
      onTapUp: active ? (_) => setState(() => _pressed = false) : null,
      onTapCancel: active ? () => setState(() => _pressed = false) : null,
      onTap: active ? widget.onTap : null,
      child: AnimatedScale(
        scale: _pressed
            ? 0.88
            : colored
                ? 1.0
                : 0.9,
        duration: TalonMotion.fast,
        curve: TalonMotion.emphasized,
        child: AnimatedContainer(
          duration: TalonMotion.base,
          curve: TalonMotion.standard,
          width: TalonDensity.d(40, 46),
          height: TalonDensity.d(40, 46),
          decoration: BoxDecoration(
            gradient: colored
                ? LinearGradient(
                    begin: Alignment.topLeft,
                    end: Alignment.bottomRight,
                    colors: [TalonColors.accent, TalonColors.accentDeep],
                  )
                : null,
            color: colored ? null : TalonColors.surfaceHi,
            borderRadius: BorderRadius.circular(TalonDensity.d(14, 16)),
            boxShadow: colored ? TalonShadows.glow : null,
          ),
          child: busy
              ? const Padding(
                  padding: EdgeInsets.all(11),
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    valueColor: AlwaysStoppedAnimation(Colors.white),
                  ),
                )
              : Icon(
                  Icons.arrow_upward_rounded,
                  color: colored ? Colors.white : TalonColors.textFaint,
                  size: TalonDensity.d(20, 22),
                ),
        ),
      ),
    );
  }
}
