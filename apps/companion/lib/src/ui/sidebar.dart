import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'glass.dart';
import 'settings_screen.dart';
import 'status_pill.dart';

/// ChatGPT-style left rail: new chat, search, time-grouped history, and a
/// footer with live status + settings.
class Sidebar extends StatefulWidget {
  final AppState state;

  /// When set (narrow layout) tapping a chat routes through this.
  final void Function(String chatId)? onSelect;

  const Sidebar({super.key, required this.state, required this.onSelect});

  @override
  State<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<Sidebar> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    return Glass(
      radius: 22,
      blur: 24,
      padding: const EdgeInsets.fromLTRB(12, 14, 12, 10),
      child: ListenableBuilder(
        listenable: widget.state,
        builder: (context, _) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const BrandMark(size: 30),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      widget.state.status.botName,
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              _NewChatButton(onTap: widget.state.newChat),
              const SizedBox(height: 10),
              _SearchBox(onChanged: (v) => setState(() => _query = v)),
              const SizedBox(height: 8),
              Expanded(child: _groupedList(context)),
              const Divider(height: 14),
              Row(
                children: [
                  Expanded(child: StatusPill(state: widget.state)),
                  IconButton(
                    tooltip: 'Settings',
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => SettingsScreen(state: widget.state),
                      ),
                    ),
                    icon: const Icon(Icons.settings_outlined,
                        size: 20, color: TalonColors.textDim),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _groupedList(BuildContext context) {
    final chats = widget.state.chats.where((c) {
      if (_query.isEmpty) return true;
      final q = _query.toLowerCase();
      return c.title.toLowerCase().contains(q) ||
          c.preview.toLowerCase().contains(q);
    }).toList();

    if (chats.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Text(
            widget.state.conn == ConnState.connected
                ? (_query.isEmpty ? 'No chats yet.' : 'No matches.')
                : 'Connecting…',
            textAlign: TextAlign.center,
            style: const TextStyle(color: TalonColors.textFaint, height: 1.5),
          ),
        ),
      );
    }

    final groups = _groupByTime(chats);
    return ListView(
      padding: EdgeInsets.zero,
      children: [
        for (final group in groups) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 10, 8, 6),
            child: Text(
              group.label.toUpperCase(),
              style: const TextStyle(
                color: TalonColors.textFaint,
                fontSize: 10.5,
                fontWeight: FontWeight.w700,
                letterSpacing: 1.1,
              ),
            ),
          ),
          for (final chat in group.chats)
            _ChatTile(
              chat: chat,
              selected: chat.id == widget.state.selectedChatId,
              onTap: () =>
                  (widget.onSelect ?? widget.state.selectChat)(chat.id),
              onDelete: () => _confirmDelete(context, chat),
            ),
        ],
      ],
    );
  }

  List<_Group> _groupByTime(List<ClientChat> chats) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final week = today.subtract(const Duration(days: 7));
    final month = today.subtract(const Duration(days: 30));

    final buckets = <String, List<ClientChat>>{
      'Today': [],
      'Yesterday': [],
      'Previous 7 days': [],
      'Previous 30 days': [],
      'Older': [],
    };
    for (final c in chats) {
      final d = c.lastActiveTime;
      if (!d.isBefore(today)) {
        buckets['Today']!.add(c);
      } else if (!d.isBefore(yesterday)) {
        buckets['Yesterday']!.add(c);
      } else if (!d.isBefore(week)) {
        buckets['Previous 7 days']!.add(c);
      } else if (!d.isBefore(month)) {
        buckets['Previous 30 days']!.add(c);
      } else {
        buckets['Older']!.add(c);
      }
    }
    return [
      for (final entry in buckets.entries)
        if (entry.value.isNotEmpty) _Group(entry.key, entry.value),
    ];
  }

  Future<void> _confirmDelete(BuildContext context, ClientChat chat) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: TalonColors.surface,
        title: const Text('Delete chat?'),
        content: Text('"${chat.title}" and its history will be removed.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: TalonColors.bad),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok == true) await widget.state.deleteChat(chat.id);
  }
}

class _Group {
  final String label;
  final List<ClientChat> chats;
  _Group(this.label, this.chats);
}

class _ChatTile extends StatefulWidget {
  final ClientChat chat;
  final bool selected;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  const _ChatTile({
    required this.chat,
    required this.selected,
    required this.onTap,
    required this.onDelete,
  });

  @override
  State<_ChatTile> createState() => _ChatTileState();
}

class _ChatTileState extends State<_ChatTile> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 130),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(10),
            color: selected
                ? TalonColors.surfaceHi
                : (_hover ? TalonColors.surface : Colors.transparent),
          ),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  widget.chat.title,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
                    color: selected ? TalonColors.text : TalonColors.textDim,
                  ),
                ),
              ),
              if (_hover || selected)
                InkWell(
                  onTap: widget.onDelete,
                  borderRadius: BorderRadius.circular(6),
                  child: const Padding(
                    padding: EdgeInsets.all(2),
                    child: Icon(Icons.close,
                        size: 15, color: TalonColors.textFaint),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _NewChatButton extends StatelessWidget {
  final VoidCallback onTap;
  const _NewChatButton({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 11, horizontal: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          gradient: TalonColors.accentGradient,
          boxShadow: [
            BoxShadow(
              color: TalonColors.accent.withValues(alpha: 0.30),
              blurRadius: 16,
              offset: const Offset(0, 5),
            ),
          ],
        ),
        child: const Row(
          children: [
            Icon(Icons.add_rounded, color: Colors.white, size: 19),
            SizedBox(width: 8),
            Text(
              'New chat',
              style: TextStyle(
                  color: Colors.white,
                  fontWeight: FontWeight.w700,
                  fontSize: 13.5),
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchBox extends StatelessWidget {
  final ValueChanged<String> onChanged;
  const _SearchBox({required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return TextField(
      onChanged: onChanged,
      style: const TextStyle(fontSize: 13.5),
      decoration: InputDecoration(
        isDense: true,
        prefixIcon: const Icon(Icons.search, size: 17),
        prefixIconConstraints:
            const BoxConstraints(minWidth: 36, minHeight: 36),
        hintText: 'Search chats',
        hintStyle: const TextStyle(color: TalonColors.textFaint, fontSize: 13),
        filled: true,
        fillColor: TalonColors.void0.withValues(alpha: 0.5),
        contentPadding: const EdgeInsets.symmetric(vertical: 10),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: const BorderSide(color: TalonColors.glassStroke),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: const BorderSide(color: TalonColors.glassStroke),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: const BorderSide(color: TalonColors.accent),
        ),
      ),
    );
  }
}
