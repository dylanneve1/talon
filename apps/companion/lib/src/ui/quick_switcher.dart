import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Cmd/Ctrl+K quick switcher: fuzzy chat jump + daemon-side full-text search
/// over message content, keyboard-first (↑↓ to move, Enter to open, Esc to
/// dismiss). Chats match locally and instantly; message hits stream in from
/// `GET /search` after a short debounce.
Future<void> openQuickSwitcher(BuildContext context, AppState state) {
  return showDialog<void>(
    context: context,
    barrierColor: Colors.black.withValues(alpha: 0.55),
    builder: (_) => _QuickSwitcher(state: state),
  );
}

/// One selectable row: either a chat (jump to it) or a message hit
/// (jump to its chat).
class _Entry {
  final String chatId;
  final String title;
  final String? subtitle;
  final IconData icon;
  const _Entry({
    required this.chatId,
    required this.title,
    this.subtitle,
    required this.icon,
  });
}

class _QuickSwitcher extends StatefulWidget {
  final AppState state;
  const _QuickSwitcher({required this.state});

  @override
  State<_QuickSwitcher> createState() => _QuickSwitcherState();
}

class _QuickSwitcherState extends State<_QuickSwitcher> {
  final _controller = TextEditingController();
  Timer? _debounce;
  List<SearchHit> _hits = const [];
  bool _searching = false;
  int _highlighted = 0;

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _onQuery(String q) {
    setState(() => _highlighted = 0);
    _debounce?.cancel();
    if (q.trim().length < 2) {
      setState(() {
        _hits = const [];
        _searching = false;
      });
      return;
    }
    setState(() => _searching = true);
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      final hits = await widget.state.searchMessages(q);
      if (mounted) {
        setState(() {
          _hits = hits;
          _searching = false;
        });
      }
    });
  }

  List<_Entry> _entries() {
    final q = _controller.text.trim().toLowerCase();
    final chats = widget.state.chats
        .where((c) => q.isEmpty || c.title.toLowerCase().contains(q))
        .take(6)
        .map((c) => _Entry(
              chatId: c.id,
              title: c.title,
              subtitle: c.preview.isEmpty ? null : c.preview,
              icon: Icons.chat_bubble_outline,
            ));
    final hits = _hits.take(12).map((h) => _Entry(
          chatId: h.chatId,
          title: h.chatTitle,
          subtitle: h.message.text.replaceAll('\n', ' '),
          icon: Icons.manage_search,
        ));
    return [...chats, ...hits];
  }

  void _open(_Entry entry) {
    Navigator.of(context).pop();
    widget.state.selectChat(entry.chatId);
  }

  KeyEventResult _onKey(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final entries = _entries();
    if (event.logicalKey == LogicalKeyboardKey.arrowDown) {
      setState(() => _highlighted =
          entries.isEmpty ? 0 : (_highlighted + 1) % entries.length);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.arrowUp) {
      setState(() => _highlighted = entries.isEmpty
          ? 0
          : (_highlighted - 1 + entries.length) % entries.length);
      return KeyEventResult.handled;
    }
    if (event.logicalKey == LogicalKeyboardKey.enter) {
      if (entries.isNotEmpty) {
        _open(entries[_highlighted.clamp(0, entries.length - 1)]);
      }
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  @override
  Widget build(BuildContext context) {
    final entries = _entries();
    return Dialog(
      backgroundColor: Colors.transparent,
      alignment: const Alignment(0, -0.5),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560, maxHeight: 460),
        child: Container(
          decoration: BoxDecoration(
            color: TalonColors.void1,
            borderRadius: TalonRadius.rLg,
            border: Border.all(color: TalonColors.glassStroke),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Padding(
                padding: const EdgeInsets.all(10),
                child: Focus(
                  onKeyEvent: _onKey,
                  child: TextField(
                    controller: _controller,
                    autofocus: true,
                    onChanged: _onQuery,
                    style: const TextStyle(fontSize: 15),
                    decoration: InputDecoration(
                      prefixIcon: const Icon(Icons.search, size: 19),
                      suffixIcon: _searching
                          ? const Padding(
                              padding: EdgeInsets.all(12),
                              child: SizedBox(
                                width: 14,
                                height: 14,
                                child:
                                    CircularProgressIndicator(strokeWidth: 2),
                              ),
                            )
                          : null,
                      hintText: 'Jump to a chat or search messages…',
                      filled: true,
                      fillColor: TalonColors.void0.withValues(alpha: 0.6),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(12),
                        borderSide: BorderSide.none,
                      ),
                    ),
                  ),
                ),
              ),
              Flexible(
                child: entries.isEmpty
                    ? Padding(
                        padding: const EdgeInsets.fromLTRB(16, 6, 16, 18),
                        child: Text(
                          _controller.text.trim().length >= 2 && !_searching
                              ? 'No matches.'
                              : 'Type to search chats and messages.',
                          style: TextStyle(color: TalonColors.textFaint),
                        ),
                      )
                    : ListView.builder(
                        shrinkWrap: true,
                        padding: const EdgeInsets.fromLTRB(8, 0, 8, 8),
                        itemCount: entries.length,
                        itemBuilder: (context, i) {
                          final e = entries[i];
                          final selected = i == _highlighted;
                          return InkWell(
                            onTap: () => _open(e),
                            borderRadius: TalonRadius.rSm,
                            child: Container(
                              padding: const EdgeInsets.symmetric(
                                  horizontal: 10, vertical: 8),
                              decoration: BoxDecoration(
                                borderRadius: TalonRadius.rSm,
                                color: selected
                                    ? TalonColors.surfaceHi
                                    : Colors.transparent,
                              ),
                              child: Row(
                                children: [
                                  Icon(e.icon,
                                      size: 15,
                                      color: selected
                                          ? TalonColors.accent
                                          : TalonColors.textFaint),
                                  const SizedBox(width: 10),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          e.title,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                              fontSize: 13.5,
                                              fontWeight: FontWeight.w600),
                                        ),
                                        if (e.subtitle != null)
                                          Text(
                                            e.subtitle!,
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: TextStyle(
                                                fontSize: 12,
                                                color: TalonColors.textFaint),
                                          ),
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
