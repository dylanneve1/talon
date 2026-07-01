import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../theme.dart';

/// Result of an image upload: the relative render path + on-disk path.
typedef UploadResult = ({String imagePath, String path});

/// The message input. Enter sends; Shift+Enter inserts a newline. Grows with
/// content up to a cap, then scrolls. Supports attaching a single image, which
/// is uploaded on send and passed through to the model.
class Composer extends StatefulWidget {
  final Future<void> Function(
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

  const Composer({
    super.key,
    required this.onSend,
    required this.onUpload,
    required this.enabled,
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

  @override
  void initState() {
    super.initState();
    _controller.addListener(_recomputeCanSend);
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
    await widget.onSend(
      text,
      imagePath: imagePath,
      attachmentPath: attachmentPath,
    );
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
      padding: const EdgeInsets.fromLTRB(14, 8, 14, 14),
      child: Container(
        decoration: BoxDecoration(
          color: TalonColors.void1.withValues(alpha: 0.7),
          borderRadius: BorderRadius.circular(18),
          border: Border.all(color: TalonColors.glassStroke),
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
                      style: const TextStyle(fontSize: 14.5, height: 1.4),
                      decoration: InputDecoration(
                        isCollapsed: true,
                        border: InputBorder.none,
                        contentPadding:
                            const EdgeInsets.symmetric(vertical: 12),
                        hintText:
                            widget.enabled ? 'Message Talon…' : 'Connecting…',
                        hintStyle:
                            TextStyle(color: TalonColors.textFaint),
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 6),
                _SendButton(
                  enabled: canSend,
                  busy: _uploading,
                  onTap: _send,
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
      icon: const Icon(Icons.add_photo_alternate_outlined, size: 22),
      color: TalonColors.textDim,
      tooltip: 'Attach image',
    );
  }
}

class _SendButton extends StatefulWidget {
  final bool enabled;
  final bool busy;
  final VoidCallback onTap;
  const _SendButton({
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
          width: 40,
          height: 40,
          decoration: BoxDecoration(
            color: colored ? TalonColors.accent : TalonColors.surfaceHi,
            borderRadius: BorderRadius.circular(13),
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
                  size: 20,
                ),
        ),
      ),
    );
  }
}
