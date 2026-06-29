import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'activity_card.dart';
import 'brand.dart';
import 'composer.dart';
import 'message_bubble.dart';
import 'model_sheet.dart';

const double _columnMax = 768;

class ChatView extends StatefulWidget {
  final AppState state;
  final bool showBack;
  final VoidCallback? onBack;

  const ChatView({
    super.key,
    required this.state,
    required this.showBack,
    this.onBack,
  });

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _scroll = ScrollController();

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _autoScroll() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final pos = _scroll.position;
      if (pos.maxScrollExtent - pos.pixels < 260) {
        _scroll.animateTo(
          pos.maxScrollExtent,
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return ClipRRect(
      borderRadius: BorderRadius.circular(22),
      child: Container(
        color: TalonColors.void1.withValues(alpha: 0.55),
        child: ListenableBuilder(
          listenable: widget.state,
          builder: (context, _) {
            final chat = widget.state.selectedChat;
            if (chat == null) return const _EmptyState();
            _autoScroll();
            return Column(
              children: [
                _Header(
                  state: widget.state,
                  chat: chat,
                  showBack: widget.showBack,
                  onBack: widget.onBack,
                ),
                Expanded(child: _messages(chat.id)),
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: _columnMax),
                    child: Composer(
                      onSend: widget.state.sendMessage,
                      enabled: widget.state.conn == ConnState.connected,
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _messages(String chatId) {
    final msgs = widget.state.messagesFor(chatId);
    final turn = widget.state.turnFor(chatId);
    final showActivity = turn.active &&
        (turn.draft.isNotEmpty ||
            turn.reasoning.isNotEmpty ||
            turn.tools.isNotEmpty ||
            turn.typing);

    if (msgs.isEmpty && !showActivity) return const _ConversationEmpty();

    final itemCount = msgs.length + (showActivity ? 1 : 0);
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _columnMax),
        child: ListView.builder(
          controller: _scroll,
          padding: const EdgeInsets.fromLTRB(20, 18, 20, 10),
          itemCount: itemCount,
          itemBuilder: (context, i) {
            if (i < msgs.length) {
              return MessageBubble(
                  message: msgs[i], botName: widget.state.status.botName);
            }
            return LiveTurn(turn: turn, botName: widget.state.status.botName);
          },
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final AppState state;
  final ClientChat chat;
  final bool showBack;
  final VoidCallback? onBack;

  const _Header({
    required this.state,
    required this.chat,
    required this.showBack,
    this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    final model = chat.model ?? state.status.model;
    final effort = chat.effort ?? 'adaptive';
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: TalonColors.glassStroke)),
      ),
      child: Row(
        children: [
          if (showBack)
            IconButton(
              onPressed: onBack,
              icon: const Icon(Icons.arrow_back_ios_new, size: 18),
            ),
          Expanded(
            child: Text(
              chat.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
            ),
          ),
          _Chip(
            icon: Icons.memory,
            label: model.isEmpty ? 'model' : model,
            onTap: () => openModelSheet(context, state, chat),
          ),
          const SizedBox(width: 6),
          _Chip(
            icon: Icons.tune,
            label: effort,
            onTap: () => openModelSheet(context, state, chat),
          ),
          _ChatMenu(state: state, chat: chat),
        ],
      ),
    );
  }
}

class _ChatMenu extends StatelessWidget {
  final AppState state;
  final ClientChat chat;
  const _ChatMenu({required this.state, required this.chat});

  @override
  Widget build(BuildContext context) {
    final pulseOn = chat.pulse ?? false;
    return PopupMenuButton<String>(
      icon: const Icon(Icons.more_vert, size: 20, color: TalonColors.textDim),
      color: TalonColors.surfaceHi,
      onSelected: (v) async {
        switch (v) {
          case 'reset':
            await state.resetChat(chat.id);
            break;
          case 'pulse':
            await state.setPulse(chat.id, !pulseOn);
            break;
          case 'rename':
            await _rename(context);
            break;
          case 'delete':
            await _delete(context);
            break;
        }
      },
      itemBuilder: (_) => [
        const PopupMenuItem(
          value: 'reset',
          child: _MenuRow(icon: Icons.refresh, label: 'Reset session'),
        ),
        PopupMenuItem(
          value: 'pulse',
          child: _MenuRow(
            icon: pulseOn ? Icons.notifications_active : Icons.notifications_off,
            label: pulseOn ? 'Disable pulse' : 'Enable pulse',
          ),
        ),
        const PopupMenuItem(
          value: 'rename',
          child: _MenuRow(icon: Icons.edit_outlined, label: 'Rename'),
        ),
        const PopupMenuItem(
          value: 'delete',
          child: _MenuRow(
              icon: Icons.delete_outline, label: 'Delete', danger: true),
        ),
      ],
    );
  }

  Future<void> _rename(BuildContext context) async {
    final controller = TextEditingController(text: chat.title);
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: TalonColors.surface,
        title: const Text('Rename chat'),
        content: TextField(
          controller: controller,
          autofocus: true,
          onSubmitted: (v) => Navigator.pop(ctx, v),
          decoration: const InputDecoration(hintText: 'Chat name'),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    if (name != null && name.trim().isNotEmpty) {
      await state.renameChat(chat.id, name.trim());
    }
  }

  Future<void> _delete(BuildContext context) async {
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
    if (ok == true) await state.deleteChat(chat.id);
  }
}

class _MenuRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool danger;
  const _MenuRow(
      {required this.icon, required this.label, this.danger = false});

  @override
  Widget build(BuildContext context) {
    final color = danger ? TalonColors.bad : TalonColors.text;
    return Row(
      children: [
        Icon(icon, size: 17, color: color),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(color: color, fontSize: 13.5)),
      ],
    );
  }
}

class _Chip extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const _Chip({required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 170),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: TalonColors.glassFill,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: TalonColors.glassStroke),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: TalonColors.textDim),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12, color: TalonColors.textDim),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    return const Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          BrandMark(size: 64),
          SizedBox(height: 18),
          Text('Talon', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w700)),
          SizedBox(height: 6),
          Text('Select a chat, or start a new one.',
              style: TextStyle(color: TalonColors.textFaint)),
        ],
      ),
    );
  }
}

class _ConversationEmpty extends StatelessWidget {
  const _ConversationEmpty();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const BrandMark(size: 52),
            const SizedBox(height: 18),
            Text(
              'How can I help?',
              style: TextStyle(
                fontSize: 19,
                fontWeight: FontWeight.w600,
                color: TalonColors.text.withValues(alpha: 0.92),
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Send a message to begin.',
              style: TextStyle(color: TalonColors.textFaint),
            ),
          ],
        ),
      ),
    );
  }
}
