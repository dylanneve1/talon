import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';

/// Shared chat management actions: one bottom sheet for touch (long-press a
/// chat tile) and the dialogs it drives, reused by the chat header's overflow
/// menu so both surfaces stay in sync.
///
/// Before this existed, rename/reset/pulse/export lived only in the open
/// conversation's overflow menu and delete-from-the-list required a hover —
/// which doesn't exist on a phone. The sheet makes every chat action reachable
/// from the list with a long-press.
Future<void> showChatActionsSheet(
  BuildContext context,
  AppState state,
  ClientChat chat,
) async {
  final pulseOn = chat.pulse ?? false;
  final action = await showModalBottomSheet<String>(
    context: context,
    backgroundColor: TalonColors.surface,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(TalonRadius.lg)),
    ),
    builder: (ctx) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
                TalonSpace.lg, TalonSpace.md, TalonSpace.lg, TalonSpace.xs),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    chat.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TalonType.subtitle,
                  ),
                ),
              ],
            ),
          ),
          _sheetTile(ctx, 'rename', Icons.edit_outlined, 'Rename'),
          _sheetTile(
            ctx,
            'pulse',
            pulseOn ? Icons.notifications_off : Icons.notifications_active,
            pulseOn ? 'Disable pulse' : 'Enable pulse',
          ),
          _sheetTile(
              ctx, 'export', Icons.ios_share_outlined, 'Copy as Markdown'),
          _sheetTile(ctx, 'reset', Icons.refresh, 'Reset session'),
          _sheetTile(ctx, 'delete', Icons.delete_outline, 'Delete',
              danger: true),
          const SizedBox(height: TalonSpace.sm),
        ],
      ),
    ),
  );
  if (action == null || !context.mounted) return;
  switch (action) {
    case 'rename':
      await promptRenameChat(context, state, chat);
    case 'pulse':
      await state.setPulse(chat.id, !pulseOn);
    case 'export':
      final messenger = ScaffoldMessenger.maybeOf(context);
      await Clipboard.setData(
        ClipboardData(text: state.exportMarkdown(chat.id)),
      );
      messenger?.showSnackBar(
        const SnackBar(content: Text('Conversation copied as Markdown')),
      );
    case 'reset':
      await state.resetChat(chat.id);
    case 'delete':
      await confirmDeleteChat(context, state, chat);
  }
}

Widget _sheetTile(
  BuildContext ctx,
  String value,
  IconData icon,
  String label, {
  bool danger = false,
}) {
  final color = danger ? TalonColors.bad : TalonColors.text;
  return ListTile(
    leading: Icon(icon, size: 20, color: danger ? color : TalonColors.textDim),
    title: Text(label, style: TextStyle(color: color, fontSize: 14.5)),
    visualDensity: VisualDensity.compact,
    onTap: () => Navigator.pop(ctx, value),
  );
}

/// Rename dialog. Applies the change through [AppState.renameChat] when
/// confirmed with a non-empty name.
Future<void> promptRenameChat(
  BuildContext context,
  AppState state,
  ClientChat chat,
) async {
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

/// Delete confirmation. Removes the chat through [AppState.deleteChat] when
/// confirmed.
Future<void> confirmDeleteChat(
  BuildContext context,
  AppState state,
  ClientChat chat,
) async {
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
