import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';

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

  /// Ids we've already shown, so the entrance animation plays once per message
  /// and never re-fires when a row is recycled back into view on scroll.
  final Set<String> _seen = <String>{};

  /// Which chat the list is currently anchored to, and whether we still owe it
  /// a jump-to-newest. When you open a chat it should land on the most recent
  /// message (like any chat app), not the top of the scrollback.
  String? _anchoredChatId;
  bool _pendingJumpToBottom = false;

  /// Whether the user has scrolled up into history far enough that a
  /// jump-to-latest affordance is useful.
  bool _awayFromBottom = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScrolled);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _onScrolled() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    final away = pos.maxScrollExtent - pos.pixels > 420;
    if (away != _awayFromBottom) setState(() => _awayFromBottom = away);
    // Nearing the top of loaded scrollback → pull the previous page in.
    if (pos.pixels < 240 && !_pendingJumpToBottom) _maybeLoadOlder();
  }

  /// Fetch the page above the current scrollback and keep the viewport
  /// anchored on the row the user was looking at (prepending grows
  /// maxScrollExtent; jump by the delta so nothing visibly shifts).
  Future<void> _maybeLoadOlder() async {
    final chatId = _anchoredChatId;
    if (chatId == null) return;
    final state = widget.state;
    if (state.isLoadingOlder(chatId) || !state.hasMoreHistory(chatId)) return;
    final extentBefore =
        _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
    final pixelsBefore = _scroll.hasClients ? _scroll.position.pixels : 0.0;
    final added = await state.loadOlderMessages(chatId);
    if (added > 0 && mounted) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scroll.hasClients) return;
        final delta = _scroll.position.maxScrollExtent - extentBefore;
        if (delta > 0) _scroll.jumpTo(pixelsBefore + delta);
      });
    }
  }

  void _jumpToLatest() {
    if (!_scroll.hasClients) return;
    _scroll.animateTo(
      _scroll.position.maxScrollExtent,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  /// A row animates in only the first time we see it AND when it's genuinely
  /// fresh (sent/received seconds ago) — so opening a chat's history doesn't
  /// trigger a cascade of animations.
  bool _shouldAnimate(ClientMessage m) {
    final firstSight = _seen.add(m.id);
    if (!firstSight) return false;
    return DateTime.now().difference(m.time).inMilliseconds < 4000;
  }

  void _autoScroll(String chatId, int messageCount) {
    // Opening (or switching to) a chat should land on the newest message. The
    // history often loads a frame or two after the switch, so keep owing the
    // jump until the chat actually has content, then snap to the bottom.
    if (chatId != _anchoredChatId) {
      _anchoredChatId = chatId;
      _pendingJumpToBottom = true;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final pos = _scroll.position;
      if (_pendingJumpToBottom) {
        _scroll.jumpTo(pos.maxScrollExtent);
        // Only consider it settled once there's something to anchor to, so an
        // async history load right after the switch still snaps to newest.
        if (messageCount > 0) _pendingJumpToBottom = false;
        return;
      }
      // Otherwise follow live growth only when the user is already near the
      // bottom, so we never yank them up while they're reading scrollback.
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
            _autoScroll(chat.id, widget.state.messagesFor(chat.id).length);
            return Column(
              children: [
                _Header(
                  state: widget.state,
                  chat: chat,
                  showBack: widget.showBack,
                  onBack: widget.onBack,
                ),
                if (widget.state.conn != ConnState.connected)
                  _ConnBanner(state: widget.state),
                Expanded(child: _messages(chat.id)),
                Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: _columnMax),
                    child: Composer(
                      onSend: widget.state.sendMessage,
                      onUpload: widget.state.uploadImage,
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

    if (msgs.isEmpty && widget.state.isHistoryLoading(chatId)) {
      return const _HistorySkeleton();
    }

    if (msgs.isEmpty && !showActivity) {
      return _ConversationEmpty(
        onPrompt: widget.state.conn == ConnState.connected
            ? (p) => widget.state.sendMessage(p)
            : null,
      );
    }

    final topLoader = widget.state.isLoadingOlder(chatId);
    final itemCount = (topLoader ? 1 : 0) + msgs.length + (showActivity ? 1 : 0);
    return Stack(
      children: [
        Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _columnMax),
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 10),
              itemCount: itemCount,
              itemBuilder: (context, i) {
                if (topLoader && i == 0) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 10),
                    child: Center(
                      child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  );
                }
                final mi = i - (topLoader ? 1 : 0);
                if (mi < msgs.length) {
                  final m = msgs[mi];
                  return MessageBubble(
                    message: m,
                    botName: widget.state.status.botName,
                    animateIn: _shouldAnimate(m),
                    // activeConfig, not config: in local auto-discover mode the
                    // saved config lacks the bridge's real port/token, and media
                    // fetched through it 404s or gets rejected.
                    imageUrl: m.imagePath == null
                        ? null
                        : widget.state.activeConfig.mediaUrl(m.imagePath!),
                  );
                }
                return LiveTurn(
                    turn: turn, botName: widget.state.status.botName);
              },
            ),
          ),
        ),
        Positioned(
          right: 18,
          bottom: 12,
          child: AnimatedSlide(
            duration: TalonMotion.base,
            curve: TalonMotion.emphasized,
            offset: _awayFromBottom ? Offset.zero : const Offset(0, 0.4),
            child: AnimatedOpacity(
              duration: TalonMotion.fast,
              opacity: _awayFromBottom ? 1 : 0,
              child: IgnorePointer(
                ignoring: !_awayFromBottom,
                child: _JumpToLatest(onTap: _jumpToLatest),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Round "back to the newest message" button shown once the user scrolls up
/// into history.
class _JumpToLatest extends StatelessWidget {
  final VoidCallback onTap;
  const _JumpToLatest({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: TalonColors.surfaceHi,
      shape: CircleBorder(
        side: BorderSide(color: TalonColors.glassStroke),
      ),
      elevation: 3,
      child: InkWell(
        onTap: onTap,
        customBorder: const CircleBorder(),
        child: Padding(
          padding: const EdgeInsets.all(9),
          child: Icon(Icons.arrow_downward_rounded,
              size: 18, color: TalonColors.textDim),
        ),
      ),
    );
  }
}

/// Slim status strip under the header while the app is reconnecting or the
/// bridge is unreachable, so a dead connection is visible from the chat
/// itself (not just the sidebar pill) and recoverable in place.
class _ConnBanner extends StatelessWidget {
  final AppState state;
  const _ConnBanner({required this.state});

  @override
  Widget build(BuildContext context) {
    final error = state.conn == ConnState.error;
    final color = error ? TalonColors.bad : TalonColors.warn;
    final text = error
        ? (state.connError ?? 'Connection lost')
        : 'Connecting to Talon…';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      color: color.withValues(alpha: 0.10),
      child: Row(
        children: [
          if (error)
            Icon(Icons.cloud_off_rounded, size: 15, color: color)
          else
            SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(
                strokeWidth: 1.8,
                valueColor: AlwaysStoppedAnimation(color),
              ),
            ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, color: color),
            ),
          ),
          if (error)
            TextButton(
              onPressed: state.start,
              style: TextButton.styleFrom(
                foregroundColor: color,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                minimumSize: const Size(0, 30),
                textStyle: const TextStyle(
                    fontSize: 12.5, fontWeight: FontWeight.w700),
              ),
              child: const Text('Retry'),
            ),
        ],
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
      decoration: BoxDecoration(
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
              style:
                  const TextStyle(fontSize: 15.5, fontWeight: FontWeight.w700),
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
      icon: Icon(Icons.more_vert, size: 20, color: TalonColors.textDim),
      color: TalonColors.surfaceHi,
      onSelected: (v) async {
        switch (v) {
          case 'reset':
            await state.resetChat(chat.id);
            break;
          case 'pulse':
            await state.setPulse(chat.id, !pulseOn);
            break;
          case 'export':
            final messenger = ScaffoldMessenger.of(context);
            await Clipboard.setData(
              ClipboardData(text: state.exportMarkdown(chat.id)),
            );
            messenger.showSnackBar(
              const SnackBar(content: Text('Conversation copied as Markdown')),
            );
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
        const PopupMenuItem(
          value: 'export',
          child: _MenuRow(
              icon: Icons.ios_share_outlined, label: 'Copy as Markdown'),
        ),
        PopupMenuItem(
          value: 'pulse',
          child: _MenuRow(
            icon:
                pulseOn ? Icons.notifications_active : Icons.notifications_off,
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
                style:
                    TextStyle(fontSize: 12, color: TalonColors.textDim),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shimmering placeholder rows while a chat's first history page loads, in
/// the same silhouette as real messages so the swap doesn't jump.
class _HistorySkeleton extends StatelessWidget {
  const _HistorySkeleton();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    Widget bar(double width, {bool right = false}) {
      final box = Align(
        alignment: right ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          width: width,
          height: 40,
          margin: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: TalonColors.surfaceHi.withValues(alpha: 0.55),
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      );
      if (reduceMotion) return box;
      return box.animate(onPlay: (c) => c.repeat()).shimmer(
            duration: 1200.ms,
            color: Colors.white.withValues(alpha: 0.06),
          );
    }

    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _columnMax),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 10),
          children: [
            bar(220, right: true),
            bar(320),
            bar(180, right: true),
            bar(380),
            bar(260),
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
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    const mark = BrandMark(size: 64);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          reduceMotion
              ? mark
              : mark
                  .animate()
                  .fadeIn(duration: TalonMotion.slow)
                  .scaleXY(begin: 0.85, end: 1, curve: TalonMotion.emphasized),
          const SizedBox(height: TalonSpace.lg),
          Text('Talon', style: TalonType.display),
          const SizedBox(height: 6),
          Text('Select a chat, or start a new one.',
              style: TextStyle(color: TalonColors.textFaint)),
        ],
      ),
    );
  }
}

/// Suggested prompts shown in a fresh conversation, à la ChatGPT/Claude — a few
/// tappable starters so an empty chat feels intentional rather than blank.
const List<({IconData icon, String label, String prompt})> _starters = [
  (
    icon: Icons.summarize_outlined,
    label: 'Summarize my day',
    prompt: 'Summarize what happened today and what needs my attention.',
  ),
  (
    icon: Icons.checklist_rounded,
    label: 'Plan a task',
    prompt: 'Help me break down a task into clear, actionable steps.',
  ),
  (
    icon: Icons.lightbulb_outline,
    label: 'Brainstorm ideas',
    prompt: 'Brainstorm a few creative ideas with me.',
  ),
];

class _ConversationEmpty extends StatelessWidget {
  /// Sends a suggested prompt; null while disconnected (chips disabled).
  final void Function(String prompt)? onPrompt;
  const _ConversationEmpty({required this.onPrompt});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    final header = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const BrandMark(size: 52),
        const SizedBox(height: TalonSpace.lg),
        Text(
          'How can I help?',
          style: TalonType.title.copyWith(fontSize: 19),
        ),
        const SizedBox(height: 6),
        Text('Send a message to begin.',
            style: TextStyle(color: TalonColors.textFaint)),
      ],
    );

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(TalonSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            reduceMotion
                ? header
                : header
                    .animate()
                    .fadeIn(duration: TalonMotion.slow)
                    .slideY(begin: 0.1, end: 0, curve: TalonMotion.emphasized),
            const SizedBox(height: TalonSpace.xl),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: TalonSpace.sm,
              runSpacing: TalonSpace.sm,
              children: [
                for (var i = 0; i < _starters.length; i++)
                  _StarterChip(
                    starter: _starters[i],
                    index: i,
                    reduceMotion: reduceMotion,
                    onTap: onPrompt == null
                        ? null
                        : () => onPrompt!(_starters[i].prompt),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StarterChip extends StatelessWidget {
  final ({IconData icon, String label, String prompt}) starter;
  final int index;
  final bool reduceMotion;
  final VoidCallback? onTap;

  const _StarterChip({
    required this.starter,
    required this.index,
    required this.reduceMotion,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final chip = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: TalonRadius.rMd,
        child: Container(
          padding: const EdgeInsets.symmetric(
              horizontal: TalonSpace.md, vertical: TalonSpace.sm),
          decoration: BoxDecoration(
            color: TalonColors.glassFill,
            borderRadius: TalonRadius.rMd,
            border: Border.all(color: TalonColors.glassStroke),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(starter.icon, size: 15, color: TalonColors.accent),
              const SizedBox(width: 7),
              Text(starter.label, style: TalonType.label),
            ],
          ),
        ),
      ),
    );
    if (reduceMotion) return chip;
    final delay = (120 + index * 70).ms;
    return chip
        .animate()
        .fadeIn(delay: delay, duration: TalonMotion.base)
        .slideY(
            begin: 0.3, end: 0, delay: delay, curve: TalonMotion.emphasized);
  }
}
