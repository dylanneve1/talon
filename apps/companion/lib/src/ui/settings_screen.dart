import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/bridge_models.dart';
import '../services/log.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'connect_screen.dart';
import 'glass.dart';

/// Talon control panel: live daemon status, the daemon's own settings (synced
/// and editable), connection profile, and a restart action. This is the parity
/// surface — everything Telegram's `/settings` exposes, plus the global config
/// the chat frontends can't touch.
class SettingsScreen extends StatefulWidget {
  final AppState state;
  const SettingsScreen({super.key, required this.state});

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  ConfigSnapshot? _cfg;
  bool _loading = true;
  String? _error;

  final _name = TextEditingController();
  final _tz = TextEditingController();

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _name.dispose();
    _tz.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final c = await widget.state.loadConfig();
      if (!mounted) return;
      setState(() {
        _cfg = c;
        _loading = false;
        if (c != null) {
          _name.text = c.botDisplayName;
          _tz.text = c.timezone;
        }
      });
    } catch (e) {
      AppLog.error('settings', 'config load failed', e);
      if (mounted) {
        setState(() {
          _loading = false;
          _error = e.toString();
        });
      }
    }
  }

  Future<void> _apply(Map<String, dynamic> update) async {
    final c = await widget.state.updateConfig(update);
    if (mounted && c != null) setState(() => _cfg = c);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('Talon settings'),
        actions: [
          IconButton(
            onPressed: _load,
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
          ),
        ],
      ),
      body: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 560),
            child: _loading
                ? const Padding(
                    padding: EdgeInsets.all(40),
                    child: CircularProgressIndicator(),
                  )
                : _body(),
          ),
        ),
      ),
    );
  }

  Widget _body() {
    final cfg = _cfg;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _statusCard(cfg),
        const SizedBox(height: 16),
        if (cfg == null)
          _Section(
            title: 'Settings unavailable',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _error ?? 'Could not read settings from the daemon.',
                  style: const TextStyle(color: TalonColors.textFaint),
                ),
                if (_error != null && AppLog.diagnose(_error!) != null) ...[
                  const SizedBox(height: 10),
                  Container(
                    padding: const EdgeInsets.all(10),
                    decoration: BoxDecoration(
                      color: TalonColors.accent.withValues(alpha: 0.08),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(Icons.lightbulb_outline,
                            size: 16, color: TalonColors.accent),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            AppLog.diagnose(_error!)!,
                            style: const TextStyle(
                                fontSize: 12.5, color: TalonColors.textDim),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
                const SizedBox(height: 10),
                Align(
                  alignment: Alignment.centerLeft,
                  child: TextButton.icon(
                    onPressed: () async {
                      final dump =
                          '${_error ?? ''}\n\n--- recent log ---\n${AppLog.dump()}';
                      await Clipboard.setData(ClipboardData(text: dump));
                      if (mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                              content: Text('Diagnostics copied to clipboard')),
                        );
                      }
                    },
                    icon: const Icon(Icons.copy_all_outlined, size: 16),
                    label: const Text('Copy diagnostics'),
                  ),
                ),
              ],
            ),
          )
        else ...[
          _Section(
            title: 'General',
            child: Column(
              children: [
                _ModelRow(
                    state: widget.state,
                    cfg: cfg,
                    onPick: (id) => _apply({'model': id})),
                const SizedBox(height: 14),
                _textRow('Display name', _name,
                    onSubmit: (v) => _apply({'botDisplayName': v})),
                const SizedBox(height: 14),
                _textRow('Timezone', _tz,
                    hint: 'e.g. Europe/London',
                    onSubmit: (v) => _apply({'timezone': v})),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _Section(
            title: 'Background agents',
            child: Column(
              children: [
                _switchRow(
                  'Pulse',
                  'Proactive check-ins when something matters',
                  cfg.pulse,
                  (v) => _apply({'pulse': v}),
                ),
                if (cfg.pulse)
                  _intervalRow(
                    'Pulse interval',
                    '${(cfg.pulseIntervalMs / 60000).round()} min',
                    (cfg.pulseIntervalMs / 60000).round(),
                    min: 1,
                    onChange: (m) => _apply({'pulseIntervalMs': m * 60000}),
                  ),
                const Divider(height: 22),
                _switchRow(
                  'Heartbeat',
                  'Periodic goal advancement',
                  cfg.heartbeat,
                  (v) => _apply({'heartbeat': v}),
                ),
                if (cfg.heartbeat)
                  _intervalRow(
                    'Heartbeat interval',
                    '${cfg.heartbeatIntervalMinutes} min',
                    cfg.heartbeatIntervalMinutes,
                    min: 5,
                    onChange: (m) => _apply({'heartbeatIntervalMinutes': m}),
                  ),
                const Divider(height: 22),
                _switchRow(
                  'Dream',
                  'Memory consolidation + diary',
                  cfg.dream,
                  (v) => _apply({'dream': v}),
                ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 16),
        _connectionCard(),
        const SizedBox(height: 24),
      ],
    );
  }

  Widget _statusCard(ConfigSnapshot? cfg) {
    final s = widget.state;
    final connected = s.conn == ConnState.connected;
    final up = cfg == null ? '' : _fmtUptime(cfg.uptimeMs);
    return Glass(
      radius: 18,
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: connected ? TalonColors.ok : TalonColors.bad,
                ),
              ),
              const SizedBox(width: 8),
              Text(
                connected ? 'Connected' : 'Disconnected',
                style:
                    const TextStyle(fontWeight: FontWeight.w700, fontSize: 15),
              ),
              const Spacer(),
              if (s.config.canManageDaemon)
                TextButton.icon(
                  onPressed: () async {
                    final r = await s.restartDaemon();
                    if (mounted && !r.ok && r.detail != null) {
                      ScaffoldMessenger.of(context)
                          .showSnackBar(SnackBar(content: Text(r.detail!)));
                    }
                  },
                  icon: const Icon(Icons.restart_alt, size: 18),
                  label: const Text('Restart'),
                ),
            ],
          ),
          if (cfg != null) ...[
            const SizedBox(height: 12),
            Wrap(
              spacing: 18,
              runSpacing: 10,
              children: [
                _stat('Backend', cfg.backend),
                _stat('Sessions', '${cfg.sessions}'),
                _stat('Messages', '${cfg.messages}'),
                _stat('Memory', '${cfg.memoryMb} MB'),
                if (up.isNotEmpty) _stat('Uptime', up),
              ],
            ),
          ],
        ],
      ),
    );
  }

  Widget _connectionCard() {
    final c = widget.state.config;
    final where = c.isLoopback
        ? 'This computer${c.canManageDaemon ? ' (managed)' : ''}'
        : '${c.host}:${c.port}';
    return _Section(
      title: 'Connection',
      child: Column(
        children: [
          Row(
            children: [
              const Icon(Icons.lan_outlined,
                  size: 18, color: TalonColors.textDim),
              const SizedBox(width: 10),
              Expanded(
                child: Text(where, style: const TextStyle(fontSize: 14)),
              ),
              TextButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) =>
                        ConnectScreen(state: widget.state, firstRun: false),
                  ),
                ),
                child: const Text('Change'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  // ── Row builders ──────────────────────────────────────────────────────────

  Widget _stat(String label, String value) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label.toUpperCase(),
              style: const TextStyle(
                  fontSize: 10,
                  color: TalonColors.textFaint,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.8)),
          const SizedBox(height: 2),
          Text(value, style: const TextStyle(fontSize: 14)),
        ],
      );

  Widget _textRow(String label, TextEditingController c,
      {String? hint, required ValueChanged<String> onSubmit}) {
    return Row(
      children: [
        SizedBox(
          width: 120,
          child: Text(label, style: const TextStyle(fontSize: 13.5)),
        ),
        Expanded(
          child: TextField(
            controller: c,
            style: const TextStyle(fontSize: 14),
            onSubmitted: onSubmit,
            decoration: InputDecoration(
              isDense: true,
              hintText: hint,
              suffixIcon: IconButton(
                icon: const Icon(Icons.check, size: 16),
                onPressed: () => onSubmit(c.text),
              ),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(10),
                borderSide: const BorderSide(color: TalonColors.glassStroke),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _switchRow(
      String title, String subtitle, bool value, ValueChanged<bool> onChanged) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w600)),
                Text(subtitle,
                    style: const TextStyle(
                        fontSize: 12, color: TalonColors.textFaint)),
              ],
            ),
          ),
          // Plain Switch, not .adaptive: this app uses fully custom Material
          // theming everywhere (not platform-native widgets), and .adaptive
          // renders a CupertinoSwitch on macOS/iOS that ignores
          // SwitchThemeData entirely, bypassing the border/contrast fix in
          // theme.dart. Colors come from SwitchThemeData now, not a local
          // override here -- the previous override set the thumb to the
          // same accent color as the selected track, making the switch
          // look like one solid pill with no visible thumb.
          Switch(
            value: value,
            onChanged: onChanged,
          ),
        ],
      ),
    );
  }

  Widget _intervalRow(String label, String current, int value,
      {required int min, required ValueChanged<int> onChange}) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, left: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(label,
                style:
                    const TextStyle(fontSize: 13, color: TalonColors.textDim)),
          ),
          IconButton(
            iconSize: 18,
            onPressed: value > min ? () => onChange(value - 1) : null,
            icon: const Icon(Icons.remove_circle_outline),
          ),
          Text(current, style: const TextStyle(fontSize: 13.5)),
          IconButton(
            iconSize: 18,
            onPressed: () => onChange(value + 1),
            icon: const Icon(Icons.add_circle_outline),
          ),
        ],
      ),
    );
  }

  String _fmtUptime(int ms) {
    final s = ms ~/ 1000;
    if (s < 60) return '${s}s';
    final m = s ~/ 60;
    if (m < 60) return '${m}m';
    final h = m ~/ 60;
    if (h < 24) return '${h}h ${m % 60}m';
    return '${h ~/ 24}d ${h % 24}h';
  }
}

class _Section extends StatelessWidget {
  final String title;
  final Widget child;
  const _Section({required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    return Glass(
      radius: 18,
      padding: const EdgeInsets.all(18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title.toUpperCase(),
              style: const TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 1.1,
                  color: TalonColors.textFaint)),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

class _ModelRow extends StatelessWidget {
  final AppState state;
  final ConfigSnapshot cfg;
  final ValueChanged<String> onPick;
  const _ModelRow(
      {required this.state, required this.cfg, required this.onPick});

  @override
  Widget build(BuildContext context) {
    return Row(
      children: [
        const SizedBox(
          width: 120,
          child: Text('Default model', style: TextStyle(fontSize: 13.5)),
        ),
        Expanded(
          child: InkWell(
            onTap: () => _pick(context),
            borderRadius: BorderRadius.circular(10),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: TalonColors.glassStroke),
              ),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      cfg.modelDisplay.isEmpty ? cfg.model : cfg.modelDisplay,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontSize: 14),
                    ),
                  ),
                  const Icon(Icons.unfold_more,
                      size: 16, color: TalonColors.textFaint),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _pick(BuildContext context) async {
    HapticFeedback.selectionClick();
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: TalonColors.void1,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SizedBox(
        height: MediaQuery.of(ctx).size.height * 0.7,
        child: ListView(
          padding: const EdgeInsets.all(12),
          children: [
            for (final m in state.models)
              ListTile(
                title: Text(m.displayName),
                subtitle: Text(m.provider,
                    style: const TextStyle(color: TalonColors.textFaint)),
                trailing: m.id == cfg.model
                    ? const Icon(Icons.check, color: TalonColors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, m.id),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onPick(picked);
  }
}
