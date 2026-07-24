import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../models/bridge_models.dart';
import '../services/autostart.dart';
import '../services/haptics.dart';
import '../services/log.dart';
import '../services/mesh_background.dart';
import '../services/voice.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'connect_screen.dart';
import 'extensions_screen.dart';
import 'glass.dart';
import 'logs_screen.dart';

/// Severity for a diagnostics check row.
enum _Health { ok, warn, bad, info }

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

class _SettingsScreenState extends State<SettingsScreen>
    with WidgetsBindingObserver {
  ConfigSnapshot? _cfg;
  bool _loading = true;
  String? _error;
  bool _restarting = false;
  bool _dreaming = false;

  /// Desktop start-at-login state (null = unknown/loading). Read from the OS
  /// on open, reconciled after every flip (the OS is the source of truth).
  bool? _autostart;
  bool _autostartBusy = false;

  /// This app's own version, for the About card ('' until loaded).
  String _appVersion = '';

  /// Optimistic overrides for in-flight `_apply` config updates, keyed by
  /// config field. A toggle flips the moment it's tapped; the entry is
  /// dropped when the daemon confirms (snapshot replaces it) or reverted
  /// with a toast if the round-trip fails. Without this the Switch only
  /// moved after the HTTP call — up to the 12s client timeout of nothing.
  final Map<String, Object?> _pending = {};

  final _name = TextEditingController();
  final _tz = TextEditingController();

  /// Whether Talon currently holds Android's digital-assistant role
  /// (null = unknown/loading). Android only.
  bool? _assistantDefault;
  List<SpeechVoice> _voices = const [];
  bool _voicesLoading = false;
  int _voicePreviewSeq = 0;

  @override
  void initState() {
    super.initState();
    // Rebuild on AppState changes: the mesh toggles / device list live in
    // AppState + prefs, and mutate via notifyListeners — without this
    // subscription the switches only repainted on a manual refresh.
    widget.state.addListener(_onAppState);
    _load();
    if (Autostart.isSupported) {
      Autostart.isEnabled().then((v) {
        if (mounted) setState(() => _autostart = v);
      });
    }
    PackageInfo.fromPlatform().then((info) {
      if (mounted) {
        setState(() => _appVersion = 'v${info.version}+${info.buildNumber}');
      }
    }).catchError((_) {});
    if (VoiceService.supported) {
      // Observe lifecycle so returning from the system settings picker
      // refreshes the "default assistant" status row immediately.
      WidgetsBinding.instance.addObserver(this);
      _refreshAssistantStatus();
      _loadVoices();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refreshAssistantStatus();
  }

  Future<void> _refreshAssistantStatus() async {
    if (!VoiceService.supported) return;
    final v = await VoiceService.instance.isDefaultAssistant();
    if (mounted) setState(() => _assistantDefault = v);
  }

  Future<void> _loadVoices() async {
    if (!VoiceService.supported || _voicesLoading) return;
    setState(() => _voicesLoading = true);
    final voices = await VoiceService.instance.listVoices();
    if (!mounted) return;
    setState(() {
      _voices = voices;
      _voicesLoading = false;
    });
  }

  Future<void> _previewVoice(String? voiceName) async {
    final service = VoiceService.instance;
    final id = 'voice-preview-${_voicePreviewSeq++}';
    final complete = Completer<void>();
    final subscriptions = <StreamSubscription<TtsEvent>>[];

    void finish(TtsEvent event) {
      if (event.id == id && !complete.isCompleted) complete.complete();
    }

    subscriptions.addAll([
      service.onTtsDone.listen(finish),
      service.onTtsError.listen(finish),
      service.onTtsStopped.listen(finish),
    ]);
    try {
      await service.stopSpeaking();
      final accepted = await service.speak(
        'Hi, I’m Talon. This is how I’ll sound in voice mode.',
        id: id,
        rate: widget.state.prefs.voiceRate,
        pitch: widget.state.prefs.voicePitch,
        voiceName: voiceName,
      );
      if (accepted) {
        await complete.future.timeout(
          const Duration(seconds: 12),
          onTimeout: () {},
        );
      }
    } finally {
      for (final subscription in subscriptions) {
        await subscription.cancel();
      }
    }
  }

  Future<void> _openVoicePicker() async {
    if (_voicesLoading) return;
    if (_voices.isEmpty) await _loadVoices();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: Colors.transparent,
      barrierColor: Colors.black.withValues(alpha: 0.58),
      builder: (_) => _VoicePickerSheet(
        voices: _voices,
        selectedName: widget.state.prefs.voiceName,
        onSelected: (name) async {
          await widget.state.prefs.setVoiceName(name);
          if (mounted) setState(() {});
        },
        onPreview: _previewVoice,
      ),
    );
    if (mounted) setState(() {});
  }

  Future<void> _setAutostart(bool v) async {
    if (_autostartBusy) return;
    setState(() {
      _autostartBusy = true;
      _autostart = v; // optimistic; reconciled below
    });
    final actual = await Autostart.setEnabled(v);
    if (!mounted) return;
    setState(() {
      _autostart = actual;
      _autostartBusy = false;
    });
    if (actual != v) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            v
                ? 'Could not enable start at login (check System Settings → Login Items)'
                : 'Could not disable start at login',
          ),
        ),
      );
    }
  }

  @override
  void dispose() {
    if (VoiceService.supported) WidgetsBinding.instance.removeObserver(this);
    if (VoiceService.supported) {
      // A settings preview must never keep speaking after its route closes.
      unawaited(VoiceService.instance.stopSpeaking());
    }
    widget.state.removeListener(_onAppState);
    _name.dispose();
    _tz.dispose();
    super.dispose();
  }

  void _onAppState() {
    if (mounted) setState(() {});
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    // Device and foreground-service health are useful, but neither is needed
    // to paint Settings. Refresh them alongside the config request instead of
    // serialising all three and holding the whole screen behind the result.
    unawaited(_refreshMeshStatus());
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

  Future<void> _refreshMeshStatus() async {
    try {
      await Future.wait([
        widget.state.refreshMeshDevices(),
        widget.state.refreshMeshBackgroundHealth(),
      ]);
    } catch (e) {
      // Mesh status is auxiliary to this screen. Keep the last known state if
      // the platform query fails; the config UI must remain usable.
      AppLog.warn('settings', 'mesh status refresh failed', e);
    }
  }

  Future<void> _apply(Map<String, dynamic> update) async {
    // Optimistic: reflect the change immediately, then reconcile with the
    // daemon's confirmed snapshot (or revert + toast on failure).
    setState(() => _pending.addAll(update));
    final c = await widget.state.updateConfig(update);
    if (!mounted) return;
    setState(() {
      update.keys.forEach(_pending.remove);
      if (c != null) _cfg = c;
    });
    if (c == null) {
      _toast('Update failed — check the connection and try again');
    }
  }

  /// Read a config value with any in-flight optimistic override applied.
  T _eff<T>(String key, T base) {
    final v = _pending[key];
    return v is T ? v : base;
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _runControl(String action) async {
    final result = await widget.state.daemonControl(action);
    _toast(
      result.message.isEmpty ? (result.ok ? 'Done' : 'Failed') : result.message,
    );
  }

  Future<void> _confirmRestart() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (dialogCtx) => AlertDialog(
        backgroundColor: TalonColors.surface,
        title: const Text('Restart Talon?'),
        content: const Text(
          'The daemon goes offline for a few seconds while it restarts. '
          'This client will reconnect automatically.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(false),
            child: const Text('Cancel'),
          ),
          TextButton(
            onPressed: () => Navigator.of(dialogCtx).pop(true),
            child: const Text('Restart'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    setState(() => _restarting = true);
    await _runControl('restart');
    if (mounted) setState(() => _restarting = false);
  }

  Future<void> _triggerDream() async {
    setState(() => _dreaming = true);
    await _runControl('dream');
    if (mounted) setState(() => _dreaming = false);
  }

  /// Plugins + Skills sub-menus. Gated on the daemon's `plugins-skills`
  /// bridge capability — an older daemon simply doesn't show the card.
  Widget _extensionsCard() {
    return _Section(
      title: 'Extensions',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ControlButton(
            icon: Icons.extension_outlined,
            label: 'Plugins',
            subtitle:
                'Built-ins, module plugins, and MCP servers — view & toggle',
            pending: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => PluginsScreen(state: widget.state),
              ),
            ),
          ),
          const SizedBox(height: 10),
          _ControlButton(
            icon: Icons.menu_book_outlined,
            label: 'Skills',
            subtitle: 'SKILL.md workflow bundles — view & toggle',
            pending: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => SkillsScreen(state: widget.state),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _controlsCard() {
    return _Section(
      title: 'Controls',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _ControlButton(
            icon: Icons.restart_alt,
            label: 'Restart Talon',
            subtitle: 'Bounce the daemon — applies pending config changes',
            pending: _restarting,
            onTap: _restarting ? null : _confirmRestart,
          ),
          const SizedBox(height: 10),
          _ControlButton(
            icon: Icons.auto_awesome_outlined,
            label: 'Run dream now',
            subtitle: 'Consolidate memory + write the diary immediately',
            pending: _dreaming,
            onTap: _dreaming ? null : _triggerDream,
          ),
          const SizedBox(height: 10),
          _ControlButton(
            icon: Icons.receipt_long_outlined,
            label: 'View logs',
            subtitle: 'Live daemon log — filter by severity or subsystem',
            pending: false,
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => LogsScreen(state: widget.state),
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    // This screen is a pushed route, outside the root's theme rebuild chain —
    // subscribe to palette changes so toggling Appearance repaints in place.
    return ValueListenableBuilder<int>(
      valueListenable: TalonTheme.revision,
      builder: (context, _, __) => TalonBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            title: const Text('Talon settings'),
            actions: [
              IconButton(
                onPressed: _loading ? null : _load,
                icon: _loading
                    ? const SizedBox.square(
                        dimension: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.refresh),
                tooltip: 'Refresh',
              ),
            ],
          ),
          body: Center(
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(20),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                // Status, Appearance, diagnostics, and connection data are
                // already local. Paint them on the first frame; only the
                // daemon-backed cards below use a loading placeholder.
                child: _body(),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body() {
    // Fall back to the cached snapshot so the status card shows instantly on a
    // cold start, before the fresh fetch lands.
    final cfg = _cfg ?? widget.state.appConfig;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _statusCard(cfg),
        const SizedBox(height: 16),
        _appearanceCard(),
        const SizedBox(height: 16),
        if (VoiceService.supported) ...[
          _voiceCard(),
          const SizedBox(height: 16),
        ],
        if (cfg == null && _loading)
          const _SettingsSkeleton()
        else if (cfg == null)
          _Section(
            title: 'Settings unavailable',
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  _error ?? 'Could not read settings from the daemon.',
                  style: TextStyle(color: TalonColors.textFaint),
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
                        Icon(
                          Icons.lightbulb_outline,
                          size: 16,
                          color: TalonColors.accent,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            AppLog.diagnose(_error!)!,
                            style: TextStyle(
                              fontSize: 12.5,
                              color: TalonColors.textDim,
                            ),
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
                            content: Text('Diagnostics copied to clipboard'),
                          ),
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
                  onPick: (id) => _apply({'model': id}),
                ),
                const SizedBox(height: 14),
                _textRow(
                  'Display name',
                  _name,
                  onSubmit: (v) => _apply({'botDisplayName': v}),
                ),
                const SizedBox(height: 14),
                _textRow(
                  'Timezone',
                  _tz,
                  hint: 'e.g. Europe/London',
                  onSubmit: (v) => _apply({'timezone': v}),
                ),
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
                  _eff('pulse', cfg.pulse),
                  (v) => _apply({'pulse': v}),
                ),
                if (_eff('pulse', cfg.pulse))
                  _intervalRow(
                    'Pulse interval',
                    '${(_eff('pulseIntervalMs', cfg.pulseIntervalMs) / 60000).round()} min',
                    (_eff('pulseIntervalMs', cfg.pulseIntervalMs) / 60000)
                        .round(),
                    min: 1,
                    onChange: (m) => _apply({'pulseIntervalMs': m * 60000}),
                  ),
                const Divider(height: 22),
                _switchRow(
                  'Heartbeat',
                  'Periodic goal advancement',
                  _eff('heartbeat', cfg.heartbeat),
                  (v) => _apply({'heartbeat': v}),
                ),
                if (_eff('heartbeat', cfg.heartbeat))
                  _intervalRow(
                    'Heartbeat interval',
                    '${_eff('heartbeatIntervalMinutes', cfg.heartbeatIntervalMinutes)} min',
                    _eff(
                      'heartbeatIntervalMinutes',
                      cfg.heartbeatIntervalMinutes,
                    ),
                    min: 5,
                    onChange: (m) => _apply({'heartbeatIntervalMinutes': m}),
                  ),
                const Divider(height: 22),
                _switchRow(
                  'Dream',
                  'Memory consolidation + diary',
                  _eff('dream', cfg.dream),
                  (v) => _apply({'dream': v}),
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          if (widget.state.status.hasCapability('plugins-skills')) ...[
            _extensionsCard(),
            const SizedBox(height: 16),
          ],
          _meshCard(),
          const SizedBox(height: 16),
          _controlsCard(),
        ],
        const SizedBox(height: 16),
        _diagnosticsCard(cfg),
        const SizedBox(height: 16),
        _aboutCard(cfg),
        const SizedBox(height: 16),
        _connectionCard(),
        const SizedBox(height: 24),
      ],
    );
  }

  /// Voice mode preferences + the Android digital-assistant role. Android
  /// only — VoiceService.supported gates the card at the call site.
  Widget _voiceCard() {
    final prefs = widget.state.prefs;
    final isDefault = _assistantDefault;
    final selected =
        _voices.where((voice) => voice.name == prefs.voiceName).firstOrNull;
    return _Section(
      title: 'Voice',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Default-assistant status + the jump into system settings. The
          // role can only be granted there, so this row is a signpost.
          Row(
            children: [
              AnimatedSwitcher(
                duration: TalonMotion.base,
                child: Icon(
                  key: ValueKey(isDefault),
                  isDefault == true
                      ? Icons.verified_rounded
                      : Icons.assistant_outlined,
                  size: 20,
                  color:
                      isDefault == true ? TalonColors.ok : TalonColors.textDim,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Default assistant',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      isDefault == null
                          ? 'Checking…'
                          : isDefault
                              ? 'Talon answers the assistant gesture'
                              : 'Let the assistant gesture open Talon voice '
                                  'mode',
                      style: TextStyle(
                        fontSize: 12,
                        height: 1.35,
                        color: TalonColors.textFaint,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              TextButton(
                onPressed: () async {
                  final ok =
                      await VoiceService.instance.openAssistantSettings();
                  if (!ok && mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(
                        content: Text('Could not open system settings'),
                      ),
                    );
                  }
                },
                child: Text(isDefault == true ? 'Change' : 'Set up'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          InkWell(
            borderRadius: BorderRadius.circular(18),
            onTap: _voicesLoading ? null : _openVoicePicker,
            child: AnimatedContainer(
              duration: TalonMotion.base,
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  colors: [
                    TalonColors.accent.withValues(alpha: 0.14),
                    TalonColors.accent2.withValues(alpha: 0.07),
                  ],
                ),
                borderRadius: BorderRadius.circular(18),
                border: Border.all(
                  color: TalonColors.accent.withValues(alpha: 0.26),
                ),
              ),
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: TalonColors.accent.withValues(alpha: 0.16),
                    ),
                    child: AnimatedSwitcher(
                      duration: TalonMotion.fast,
                      child: Icon(
                        _voicesLoading
                            ? Icons.hourglass_top_rounded
                            : Icons.graphic_eq_rounded,
                        key: ValueKey(_voicesLoading),
                        color: TalonColors.accent,
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          selected == null
                              ? 'Best available voice'
                              : _voiceDisplayName(selected),
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          selected == null
                              ? (_voicesLoading
                                  ? 'Finding voices on this device…'
                                  : 'Highest-quality voice for your language, '
                                      'picked automatically')
                              : _voiceDescription(selected),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            fontSize: 12,
                            color: TalonColors.textFaint,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Icon(
                    Icons.chevron_right_rounded,
                    color: TalonColors.textDim,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 10),
          _switchRow(
            'Hands-free conversation',
            'Keep listening after each reply — talk back and forth without '
                'touching the screen',
            prefs.voiceHandsFree,
            (v) {
              Haptics.selection();
              prefs.setVoiceHandsFree(v);
              setState(() {});
            },
          ),
          _switchRow(
            'Captions',
            'Show the live transcript in voice mode (toggleable in-session '
                'too)',
            prefs.voiceCaptions,
            (v) {
              Haptics.selection();
              prefs.setVoiceCaptions(v);
              setState(() {});
            },
          ),
          const SizedBox(height: 4),
          // Speech-rate slider: how fast Talon reads replies aloud.
          Row(
            children: [
              Expanded(
                child: Text(
                  'Speech rate',
                  style: TextStyle(fontSize: 13, color: TalonColors.textDim),
                ),
              ),
              Text(
                '${prefs.voiceRate.toStringAsFixed(1)}×',
                style: TalonType.mono.copyWith(
                  fontSize: 12,
                  color: TalonColors.textDim,
                ),
              ),
              const SizedBox(width: 4),
              IconButton(
                tooltip: 'Preview voice and speed',
                visualDensity: VisualDensity.compact,
                onPressed: () => _previewVoice(prefs.voiceName),
                icon: const Icon(Icons.play_circle_outline_rounded, size: 21),
              ),
            ],
          ),
          Slider(
            value: prefs.voiceRate,
            min: 0.6,
            max: 1.6,
            divisions: 10,
            onChanged: (v) {
              prefs.setVoiceRate(v);
              setState(() {});
            },
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              children: [
                Text(
                  'Relaxed',
                  style:
                      TextStyle(fontSize: 10.5, color: TalonColors.textFaint),
                ),
                const Spacer(),
                Text(
                  'Expressive',
                  style:
                      TextStyle(fontSize: 10.5, color: TalonColors.textFaint),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          // Pitch: a narrow ±20% band. Wider than that and every engine starts
          // sounding like a cartoon rather than a different speaker.
          Row(
            children: [
              Expanded(
                child: Text(
                  'Pitch',
                  style: TextStyle(fontSize: 13, color: TalonColors.textDim),
                ),
              ),
              Text(
                '${prefs.voicePitch.toStringAsFixed(2)}×',
                style: TalonType.mono.copyWith(
                  fontSize: 12,
                  color: TalonColors.textDim,
                ),
              ),
            ],
          ),
          Slider(
            value: prefs.voicePitch,
            min: 0.8,
            max: 1.2,
            divisions: 8,
            onChanged: (v) {
              prefs.setVoicePitch(v);
              setState(() {});
            },
          ),
        ],
      ),
    );
  }

  Widget _meshCard() {
    final prefs = widget.state.prefs;
    final locByDevice = {
      for (final loc in widget.state.meshLocations) loc.deviceId: loc,
    };
    return _Section(
      title: 'Mesh',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _switchRow(
            'Location sharing',
            'Register this device and answer on-demand locate requests',
            prefs.meshSharing,
            (v) => widget.state.setMeshSharing(v),
          ),
          const SizedBox(height: 10),
          _check(
            _meshBackgroundHealth(widget.state.meshBackgroundHealth.kind),
            'Background',
            widget.state.meshBackgroundHealth.label,
          ),
          if (Autostart.isSupported) ...[
            const Divider(height: 22),
            _switchRow(
              'Start at login',
              'Launch Talon when you sign in, so the mesh is online from boot',
              _autostart ?? false,
              (_autostart == null || _autostartBusy) ? null : _setAutostart,
            ),
          ],
          const Divider(height: 22),
          _switchRow(
            'Periodic reporting',
            'Send a live location fix on an interval',
            prefs.meshPeriodic,
            // null = properly disabled (greyed out) while sharing is off —
            // an enabled-looking switch that swallows taps reads as stuck.
            prefs.meshSharing ? (v) => widget.state.setMeshPeriodic(v) : null,
          ),
          if (prefs.meshSharing && prefs.meshPeriodic)
            _intervalRow(
              'Mesh interval',
              '${(prefs.meshIntervalSeconds / 60).round()} min',
              (prefs.meshIntervalSeconds / 60).round(),
              min: 1,
              onChange: (m) => widget.state.setMeshIntervalSeconds(m * 60),
            ),
          const Divider(height: 22),
          _switchRow(
            'Device control',
            'Let Talon run shell + file commands on this device (teleport). '
                'Uses app permissions, or Shizuku if available for elevated access.',
            prefs.meshDeviceControl,
            prefs.meshSharing
                ? (v) => widget.state.setMeshDeviceControl(v)
                : null,
          ),
          const Divider(height: 22),
          Row(
            children: [
              Icon(Icons.hub_outlined, size: 18, color: TalonColors.textDim),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  widget.state.meshDevices.isEmpty
                      ? 'No mesh devices yet'
                      : '${widget.state.meshDevices.length} device${widget.state.meshDevices.length == 1 ? '' : 's'}',
                  style: const TextStyle(fontSize: 14),
                ),
              ),
              IconButton(
                onPressed: widget.state.refreshMeshDevices,
                icon: const Icon(Icons.refresh, size: 18),
                tooltip: 'Refresh mesh',
              ),
            ],
          ),
          const SizedBox(height: 6),
          for (final device in widget.state.meshDevices)
            _meshDeviceRow(device, locByDevice[device.id]),
        ],
      ),
    );
  }

  _Health _meshBackgroundHealth(MeshForegroundHealthKind kind) {
    switch (kind) {
      case MeshForegroundHealthKind.healthy:
        return _Health.ok;
      case MeshForegroundHealthKind.starting:
      case MeshForegroundHealthKind.off:
      case MeshForegroundHealthKind.unsupported:
        return _Health.warn;
      case MeshForegroundHealthKind.stale:
        return _Health.bad;
    }
  }

  Widget _meshDeviceRow(DeviceInfo device, DeviceLocation? loc) {
    final battery = device.battery == null
        ? ''
        : ' · ${device.battery}%${device.charging == true ? ' charging' : ''}';
    final last = _fmtAge(
      DateTime.now().millisecondsSinceEpoch - device.lastSeen,
    );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            device.online ? Icons.radio_button_checked : Icons.radio_button_off,
            size: 16,
            color: device.online ? TalonColors.ok : TalonColors.textFaint,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  device.name,
                  style: const TextStyle(
                    fontSize: 13.5,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  '${device.platform} · $last$battery',
                  style: TextStyle(fontSize: 12, color: TalonColors.textFaint),
                ),
                if (device.appVersion.isNotEmpty)
                  Text(
                    'v${device.appVersion}',
                    style: TextStyle(
                      fontSize: 11,
                      color: TalonColors.textFaint,
                    ),
                  ),
              ],
            ),
          ),
          if (loc != null)
            IconButton(
              onPressed: () => launchUrl(
                Uri.parse('https://maps.google.com/?q=${loc.lat},${loc.lon}'),
                mode: LaunchMode.externalApplication,
              ),
              icon: const Icon(Icons.map_outlined, size: 18),
              tooltip: 'Open map',
            ),
        ],
      ),
    );
  }

  // ── Appearance ────────────────────────────────────────────────────────────

  Widget _appearanceCard() {
    final current = TalonTheme.mode.value;
    const options = [
      (ThemeMode.system, 'Auto', Icons.brightness_auto_outlined),
      (ThemeMode.light, 'Light', Icons.light_mode_outlined),
      (ThemeMode.dark, 'Dark', Icons.dark_mode_outlined),
    ];
    final seed = TalonTheme.accentSeed.value;
    final isPreset = seed != null &&
        TalonAccents.presets.any((p) => p.$2.toARGB32() == seed.toARGB32());
    final isCustom = seed != null && !isPreset;
    final scale = TalonTheme.textScale.value;
    final mobile = defaultTargetPlatform == TargetPlatform.android ||
        defaultTargetPlatform == TargetPlatform.iOS;
    return _Section(
      title: 'Appearance',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Full-width segmented row: each mode gets the same room, so there
          // is no dead strip after Dark on wider cards.
          Row(
            children: [
              for (final (i, (mode, label, icon)) in options.indexed) ...[
                if (i > 0) const SizedBox(width: 8),
                Expanded(
                  child: _ModeButton(
                    label: label,
                    icon: icon,
                    selected: current == mode,
                    onTap: () {
                      TalonTheme.mode.value = mode;
                      widget.state.prefs.setThemeMode(switch (mode) {
                        ThemeMode.light => 'light',
                        ThemeMode.dark => 'dark',
                        ThemeMode.system => 'system',
                      });
                    },
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 18),
          const Text(
            'Accent color',
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 10),
          _SwatchGrid(
            swatches: [
              _AccentSwatch(
                tooltip: 'Talon (default)',
                gradient: const LinearGradient(
                  colors: [Color(0xFF7C8CFF), Color(0xFF54E6FF)],
                ),
                selected: seed == null,
                onTap: () => _setAccent(null),
              ),
              for (final (label, color) in TalonAccents.presets)
                _AccentSwatch(
                  tooltip: label,
                  color: color,
                  selected: seed != null && seed.toARGB32() == color.toARGB32(),
                  onTap: () => _setAccent(color),
                ),
              _AccentSwatch(
                tooltip: 'Custom…',
                gradient: const SweepGradient(
                  colors: [
                    Color(0xFFFF5C5C),
                    Color(0xFFFFC53D),
                    Color(0xFF3ED598),
                    Color(0xFF38C8F0),
                    Color(0xFFA78BFA),
                    Color(0xFFFF5C5C),
                  ],
                ),
                icon: Icons.colorize,
                selected: isCustom,
                onTap: _pickCustomAccent,
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              const SizedBox(
                width: 120,
                child: Text(
                  'Text size',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
              Expanded(
                child: Slider(
                  value: scale,
                  min: 0.85,
                  max: 1.3,
                  divisions: 9,
                  label: '${(scale * 100).round()}%',
                  onChanged: (v) {
                    setState(() {
                      TalonTheme.textScale.value =
                          double.parse(v.toStringAsFixed(2));
                    });
                  },
                  onChangeEnd: (v) => widget.state.prefs.setTextScale(v),
                ),
              ),
              SizedBox(
                width: 42,
                child: Text(
                  '${(scale * 100).round()}%',
                  textAlign: TextAlign.right,
                  style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
                ),
              ),
            ],
          ),
          if (mobile) ...[
            const SizedBox(height: 6),
            _switchRow(
              'Haptic feedback',
              'Vibrate lightly on long-presses and pickers',
              Haptics.enabled,
              (v) {
                setState(() => Haptics.enabled = v);
                widget.state.prefs.setHaptics(v);
                if (v) Haptics.selection();
              },
            ),
          ],
        ],
      ),
    );
  }

  void _setAccent(Color? seed) {
    Haptics.selection();
    // main.dart listens on accentSeed → re-applies the palette and rebuilds.
    TalonTheme.accentSeed.value = seed;
    widget.state.prefs.setAccentSeed(seed?.toARGB32());
  }

  Future<void> _pickCustomAccent() async {
    final picked = await showDialog<Color>(
      context: context,
      builder: (_) => _AccentPickerDialog(
        initial: TalonTheme.accentSeed.value ?? TalonColors.accent,
      ),
    );
    if (picked != null) _setAccent(picked);
  }

  // ── Diagnostics ("doctor") + About ─────────────────────────────────────────

  Widget _diagnosticsCard(ConfigSnapshot? cfg) {
    final s = widget.state;
    // The effective connection (with any auto-discovered port/token), not the
    // saved profile — diagnostics should describe what's actually in use.
    final c = s.activeConfig;
    final protoOk = s.status.protocol == kBridgeProtocolVersion;
    final connected = s.conn == ConnState.connected;

    _Health connHealth;
    String connDetail;
    switch (s.conn) {
      case ConnState.connected:
        connHealth = _Health.ok;
        connDetail = 'Streaming events';
      case ConnState.connecting:
        connHealth = _Health.warn;
        connDetail = 'Connecting…';
      case ConnState.error:
        connHealth = _Health.bad;
        connDetail = 'Not connected';
      case ConnState.idle:
        connHealth = _Health.warn;
        connDetail = 'Idle';
    }

    return _Section(
      title: 'Diagnostics',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _check(connHealth, 'Connection', connDetail),
          _check(
            !connected ? _Health.warn : (protoOk ? _Health.ok : _Health.bad),
            'Bridge protocol',
            connected
                ? (protoOk
                    ? 'v${s.status.protocol} — matched'
                    : 'app v$kBridgeProtocolVersion · daemon v${s.status.protocol} — mismatch')
                : 'Unknown until connected',
          ),
          _check(
            cfg == null
                ? _Health.warn
                : (cfg.healthy ? _Health.ok : _Health.bad),
            'Daemon health',
            cfg == null
                ? 'No status yet'
                : (cfg.healthy ? 'Reporting healthy' : 'Unhealthy'),
          ),
          _check(
            _Health.info,
            'Transport',
            '${c.baseUrl}${c.tls ? ' · TLS' : ''}',
          ),
          _check(
            _Health.info,
            'Authentication',
            (c.token != null && c.token!.isNotEmpty)
                ? 'Bearer token set'
                : (c.isLoopback ? 'None (loopback)' : 'None'),
          ),
          const SizedBox(height: 12),
          // Wrap, not Row: both labelled buttons don't always fit one line on
          // a narrow phone (and Inter runs a touch wider than the old system
          // face) — wrapping beats clipping.
          Wrap(
            spacing: 10,
            runSpacing: 8,
            children: [
              OutlinedButton.icon(
                onPressed: () => s.start(),
                icon: const Icon(Icons.wifi_tethering, size: 16),
                label: const Text('Reconnect'),
                style: OutlinedButton.styleFrom(
                  foregroundColor: TalonColors.accent,
                  side: BorderSide(
                    color: TalonColors.accent.withValues(alpha: 0.5),
                  ),
                ),
              ),
              TextButton.icon(
                onPressed: _copyDiagnostics,
                icon: const Icon(Icons.copy_all_outlined, size: 16),
                label: const Text('Copy diagnostics'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _copyDiagnostics() async {
    final s = widget.state;
    final cfg = _cfg;
    final buf = StringBuffer()
      ..writeln('Talon diagnostics')
      ..writeln('connection: ${s.conn.name}')
      ..writeln('endpoint: ${s.activeConfig.baseUrl}')
      ..writeln(
        'protocol: app v$kBridgeProtocolVersion / daemon v${s.status.protocol}',
      )
      ..writeln('backend: ${s.status.backend}')
      ..writeln('model: ${s.status.model}')
      ..writeln('bot: ${s.status.botName}');
    if (cfg != null) {
      buf
        ..writeln('healthy: ${cfg.healthy}')
        ..writeln('uptimeMs: ${cfg.uptimeMs}')
        ..writeln('sessions: ${cfg.sessions}')
        ..writeln('messages: ${cfg.messages}')
        ..writeln('memoryMb: ${cfg.memoryMb}');
    }
    buf
      ..writeln('--- recent log ---')
      ..writeln(AppLog.dump());
    await Clipboard.setData(ClipboardData(text: buf.toString()));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Diagnostics copied to clipboard')),
      );
    }
  }

  Widget _aboutCard(ConfigSnapshot? cfg) {
    final s = widget.state;
    return _Section(
      title: 'About',
      child: Column(
        children: [
          if (_appVersion.isNotEmpty) _infoRow('App version', _appVersion),
          _infoRow('Assistant', s.status.botName),
          _infoRow('Backend', s.status.backend),
          _infoRow(
            'Default model',
            cfg?.modelDisplay.isNotEmpty == true
                ? cfg!.modelDisplay
                : s.status.model,
          ),
          _infoRow('Bridge protocol', 'v$kBridgeProtocolVersion'),
          _infoRow('Active chats', '${s.status.activeChats}'),
          if (cfg != null) _infoRow('Uptime', _fmtUptime(cfg.uptimeMs)),
          if (s.status.startedAt.isNotEmpty)
            _infoRow(
              'Started',
              s.status.startedAt.replaceFirst('T', ' ').split('.').first,
            ),
        ],
      ),
    );
  }

  Widget _check(_Health h, String label, String detail) {
    final (icon, color) = switch (h) {
      _Health.ok => (Icons.check_circle, TalonColors.ok),
      _Health.warn => (Icons.error_outline, TalonColors.warn),
      _Health.bad => (Icons.cancel_outlined, TalonColors.bad),
      _Health.info => (Icons.info_outline, TalonColors.textFaint),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(icon, size: 16, color: color),
          const SizedBox(width: 10),
          SizedBox(
            width: 118,
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 13.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Expanded(
            child: Text(
              detail,
              style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
            ),
          ),
        ],
      ),
    );
  }

  Widget _infoRow(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(
              width: 128,
              child: Text(
                label,
                style: TextStyle(fontSize: 13, color: TalonColors.textDim),
              ),
            ),
            Expanded(
              child: SelectableText(
                value.isEmpty ? '—' : value,
                style: const TextStyle(fontSize: 13.5),
              ),
            ),
          ],
        ),
      );

  Widget _statusCard(ConfigSnapshot? cfg) {
    final s = widget.state;
    final connected = s.conn == ConnState.connected;
    final up = cfg == null ? '' : _fmtUptime(cfg.uptimeMs);
    final healthy = connected && (cfg?.healthy ?? true);
    final badgeColor = !connected
        ? TalonColors.bad
        : (healthy ? TalonColors.ok : TalonColors.warn);
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        // Faint indigo→teal wash so the white stat tiles pop off the card.
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            TalonColors.accent.withValues(alpha: 0.07),
            TalonColors.accent2.withValues(alpha: 0.05),
          ],
        ),
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: TalonColors.glassStroke, width: 1),
        boxShadow: TalonShadows.soft,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 11,
                height: 11,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: connected ? TalonColors.ok : TalonColors.bad,
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      connected ? 'Connected' : 'Disconnected',
                      style: const TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 18,
                      ),
                    ),
                    Text(
                      connected
                          ? (healthy
                              ? 'Agent online and healthy'
                              : 'Agent online')
                          : 'Not connected to the daemon',
                      style:
                          TextStyle(fontSize: 13, color: TalonColors.textDim),
                    ),
                  ],
                ),
              ),
              Container(
                width: 44,
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: badgeColor.withValues(alpha: 0.14),
                ),
                child: Icon(
                  connected && healthy
                      ? Icons.verified_user_outlined
                      : Icons.gpp_maybe_outlined,
                  size: 22,
                  color: badgeColor,
                ),
              ),
            ],
          ),
          if (cfg != null) ...[
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                    child:
                        _statTile(Icons.dns_outlined, 'Backend', cfg.backend)),
                const SizedBox(width: 10),
                Expanded(
                    child: _statTile(Icons.account_tree_outlined, 'Sessions',
                        '${cfg.sessions}')),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                    child: _statTile(
                        Icons.forum_outlined, 'Messages', '${cfg.messages}')),
                const SizedBox(width: 10),
                Expanded(
                    child: _statTile(
                        Icons.memory_outlined, 'Memory', '${cfg.memoryMb} MB')),
              ],
            ),
            if (up.isNotEmpty) ...[
              const SizedBox(height: 10),
              Row(
                children: [
                  Expanded(
                      child: _statTile(Icons.schedule_outlined, 'Uptime', up)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: _statTile(
                      Icons.favorite_outline,
                      'Health',
                      healthy ? 'Good' : 'Check',
                      pill: healthy,
                    ),
                  ),
                ],
              ),
            ],
          ],
          if (s.config.canManageDaemon) ...[
            const SizedBox(height: 14),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: () async {
                  final r = await s.restartDaemon();
                  if (mounted && !r.ok && r.detail != null) {
                    ScaffoldMessenger.of(
                      context,
                    ).showSnackBar(SnackBar(content: Text(r.detail!)));
                  }
                },
                icon: const Icon(Icons.restart_alt, size: 18),
                label: const Text('Restart daemon'),
              ),
            ),
          ],
        ],
      ),
    );
  }

  /// A compact stat tile: an indigo icon square, a small uppercase label, and a
  /// bold value (or a green "Good" pill for the health readout).
  Widget _statTile(IconData icon, String label, String value,
      {bool pill = false}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      decoration: BoxDecoration(
        color: TalonColors.surface,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: TalonColors.glassStroke, width: 1),
      ),
      child: Row(
        children: [
          Container(
            width: 30,
            height: 30,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: TalonColors.accent.withValues(alpha: 0.12),
              borderRadius: BorderRadius.circular(9),
            ),
            child: Icon(icon, size: 17, color: TalonColors.accent),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  label.toUpperCase(),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 9.5,
                    letterSpacing: 0.6,
                    fontWeight: FontWeight.w700,
                    color: TalonColors.textFaint,
                  ),
                ),
                const SizedBox(height: 1),
                if (pill)
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
                    decoration: BoxDecoration(
                      color: TalonColors.ok.withValues(alpha: 0.15),
                      borderRadius: BorderRadius.circular(999),
                    ),
                    child: Text(
                      value,
                      style: TextStyle(
                        fontSize: 12.5,
                        fontWeight: FontWeight.w700,
                        color: TalonColors.ok,
                      ),
                    ),
                  )
                else
                  Text(
                    value,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w700,
                    ),
                  ),
              ],
            ),
          ),
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
              Icon(Icons.lan_outlined, size: 18, color: TalonColors.textDim),
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

  Widget _textRow(
    String label,
    TextEditingController c, {
    String? hint,
    required ValueChanged<String> onSubmit,
  }) {
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
                borderSide: BorderSide(color: TalonColors.glassStroke),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _switchRow(
    String title,
    String subtitle,
    bool value,
    ValueChanged<bool>? onChanged,
  ) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: TextStyle(
                    fontSize: 12,
                    height: 1.35,
                    color: TalonColors.textFaint,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          // Plain Switch, not .adaptive: this app uses fully custom Material
          // theming everywhere (not platform-native widgets), and .adaptive
          // renders a CupertinoSwitch on macOS/iOS that ignores
          // SwitchThemeData entirely, bypassing the border/contrast fix in
          // theme.dart. Colors come from SwitchThemeData now, not a local
          // override here -- the previous override set the thumb to the
          // same accent color as the selected track, making the switch
          // look like one solid pill with no visible thumb.
          Switch(value: value, onChanged: onChanged),
        ],
      ),
    );
  }

  Widget _intervalRow(
    String label,
    String current,
    int value, {
    required int min,
    required ValueChanged<int> onChange,
  }) {
    return Padding(
      padding: const EdgeInsets.only(top: 8, left: 6),
      child: Row(
        children: [
          Expanded(
            child: Text(
              label,
              style: TextStyle(fontSize: 13, color: TalonColors.textDim),
            ),
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

  String _fmtAge(int ms) {
    final s = (ms ~/ 1000).clamp(0, 1 << 31);
    if (s < 60) return '${s}s ago';
    final m = s ~/ 60;
    if (m < 60) return '${m}m ago';
    final h = m ~/ 60;
    return '${h}h ago';
  }
}

String _voiceDisplayName(SpeechVoice voice) {
  final locale = _spokenLocale(voice.locale);
  if (voice.networkRequired && voice.quality >= 400) return '$locale · Natural';
  if (voice.quality >= 400) return '$locale · Enhanced';
  if (voice.networkRequired) return '$locale · Online';
  return '$locale · On-device';
}

String _voiceDescription(SpeechVoice voice) {
  final source = voice.networkRequired ? 'Uses network' : 'Available offline';
  return '${voice.qualityLabel} · $source';
}

String _spokenLocale(String tag) {
  final normalized = tag.replaceAll('_', '-');
  final parts = normalized.split('-');
  const languages = {
    'ar': 'Arabic',
    'de': 'German',
    'en': 'English',
    'es': 'Spanish',
    'fr': 'French',
    'hi': 'Hindi',
    'it': 'Italian',
    'ja': 'Japanese',
    'ko': 'Korean',
    'nl': 'Dutch',
    'pl': 'Polish',
    'pt': 'Portuguese',
    'ru': 'Russian',
    'sv': 'Swedish',
    'tr': 'Turkish',
    'zh': 'Chinese',
  };
  const regions = {
    'AU': 'Australia',
    'CA': 'Canada',
    'GB': 'UK',
    'IE': 'Ireland',
    'IN': 'India',
    'NZ': 'New Zealand',
    'US': 'US',
  };
  final language =
      languages[parts.first.toLowerCase()] ?? parts.first.toUpperCase();
  if (parts.length < 2) return language;
  final region = regions[parts[1].toUpperCase()] ?? parts[1].toUpperCase();
  return '$language ($region)';
}

/// Immersive voice browser used by Settings. Preview state stays local to the
/// sheet so the play affordance animates immediately without rebuilding the
/// entire settings route.
class _VoicePickerSheet extends StatefulWidget {
  final List<SpeechVoice> voices;
  final String? selectedName;
  final Future<void> Function(String? name) onSelected;
  final Future<void> Function(String? name) onPreview;

  const _VoicePickerSheet({
    required this.voices,
    required this.selectedName,
    required this.onSelected,
    required this.onPreview,
  });

  @override
  State<_VoicePickerSheet> createState() => _VoicePickerSheetState();
}

class _VoicePickerSheetState extends State<_VoicePickerSheet> {
  String? _selectedName;
  String? _previewingKey;

  @override
  void initState() {
    super.initState();
    _selectedName = widget.selectedName;
  }

  Future<void> _select(String? name) async {
    Haptics.selection();
    setState(() => _selectedName = name);
    await widget.onSelected(name);
  }

  Future<void> _preview(String? name) async {
    final key = name ?? '__system__';
    if (_previewingKey != null) return;
    Haptics.selection();
    setState(() => _previewingKey = key);
    await widget.onPreview(name);
    if (mounted) setState(() => _previewingKey = null);
  }

  @override
  Widget build(BuildContext context) {
    final height = MediaQuery.sizeOf(context).height * 0.82;
    return Container(
      height: height,
      decoration: BoxDecoration(
        color: TalonColors.void1,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(30)),
        border: Border.all(color: TalonColors.glassStroke),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withValues(alpha: 0.28),
            blurRadius: 32,
            offset: const Offset(0, -8),
          ),
        ],
      ),
      child: Column(
        children: [
          const SizedBox(height: 10),
          Container(
            width: 42,
            height: 4,
            decoration: BoxDecoration(
              color: TalonColors.textFaint.withValues(alpha: 0.45),
              borderRadius: BorderRadius.circular(99),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(22, 18, 12, 14),
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    gradient: LinearGradient(
                      colors: [TalonColors.accent, TalonColors.accent2],
                    ),
                  ),
                  child: const Icon(
                    Icons.multitrack_audio_rounded,
                    color: Colors.white,
                  ),
                ),
                const SizedBox(width: 13),
                const Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Choose Talon’s voice',
                        style: TextStyle(
                          fontSize: 19,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                      SizedBox(height: 2),
                      Text(
                        'Preview the voices installed on this device',
                        style: TextStyle(fontSize: 12.5),
                      ),
                    ],
                  ),
                ),
                IconButton(
                  tooltip: 'Close',
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(Icons.close_rounded),
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 2, 16, 24),
              children: [
                _choice(
                  name: null,
                  icon: Icons.auto_awesome_rounded,
                  title: 'System voice',
                  subtitle: 'Follow the Android default voice',
                  network: false,
                ),
                for (final voice in widget.voices)
                  _choice(
                    name: voice.name,
                    icon: voice.networkRequired
                        ? Icons.cloud_outlined
                        : Icons.offline_bolt_outlined,
                    title: _voiceDisplayName(voice),
                    subtitle: '${_voiceDescription(voice)}\n${voice.name}',
                    network: voice.networkRequired,
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _choice({
    required String? name,
    required IconData icon,
    required String title,
    required String subtitle,
    required bool network,
  }) {
    final selected = _selectedName == name;
    final previewing = _previewingKey == (name ?? '__system__');
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: AnimatedContainer(
        duration: TalonMotion.base,
        curve: Curves.easeOutCubic,
        decoration: BoxDecoration(
          color: selected
              ? TalonColors.accent.withValues(alpha: 0.13)
              : TalonColors.surface,
          borderRadius: BorderRadius.circular(19),
          border: Border.all(
            color: selected
                ? TalonColors.accent.withValues(alpha: 0.62)
                : TalonColors.glassStroke,
            width: selected ? 1.4 : 1,
          ),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(19),
          onTap: () => _select(name),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
            child: Row(
              children: [
                AnimatedContainer(
                  duration: TalonMotion.fast,
                  width: 42,
                  height: 42,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: selected
                        ? TalonColors.accent.withValues(alpha: 0.2)
                        : TalonColors.glassFill,
                  ),
                  child: Icon(
                    selected ? Icons.graphic_eq_rounded : icon,
                    color: selected ? TalonColors.accent : TalonColors.textDim,
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                          if (network) ...[
                            const SizedBox(width: 7),
                            Container(
                              padding: const EdgeInsets.symmetric(
                                horizontal: 7,
                                vertical: 2,
                              ),
                              decoration: BoxDecoration(
                                color:
                                    TalonColors.accent2.withValues(alpha: 0.12),
                                borderRadius: BorderRadius.circular(99),
                              ),
                              child: Text(
                                'ONLINE',
                                style: TextStyle(
                                  fontSize: 8.5,
                                  letterSpacing: 0.5,
                                  fontWeight: FontWeight.w800,
                                  color: TalonColors.accent2,
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                      const SizedBox(height: 3),
                      Text(
                        subtitle,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 11.5,
                          height: 1.35,
                          color: TalonColors.textFaint,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                IconButton(
                  tooltip: 'Preview',
                  onPressed:
                      _previewingKey == null ? () => _preview(name) : null,
                  icon: AnimatedSwitcher(
                    duration: TalonMotion.fast,
                    child: previewing
                        ? SizedBox.square(
                            key: const ValueKey('playing'),
                            dimension: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: TalonColors.accent,
                            ),
                          )
                        : Icon(
                            Icons.play_arrow_rounded,
                            key: const ValueKey('play'),
                            color: TalonColors.textDim,
                          ),
                  ),
                ),
                AnimatedSwitcher(
                  duration: TalonMotion.fast,
                  child: selected
                      ? Icon(
                          Icons.check_circle_rounded,
                          key: const ValueKey('selected'),
                          color: TalonColors.accent,
                          size: 21,
                        )
                      : const SizedBox(
                          key: ValueKey('unselected'),
                          width: 21,
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Shimmering placeholder cards shown while the daemon config loads — reads as
/// "loading this specific layout" rather than a lonely spinner.
class _SettingsSkeleton extends StatelessWidget {
  const _SettingsSkeleton();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    Widget bar(double w, double h) {
      final box = Container(
        width: w,
        height: h,
        decoration: BoxDecoration(
          color: TalonColors.surfaceHi,
          borderRadius: BorderRadius.circular(6),
        ),
      );
      if (reduceMotion) return box;
      return box.animate(onPlay: (c) => c.repeat()).shimmer(
            duration: 1200.ms,
            color: Colors.white.withValues(alpha: 0.08),
          );
    }

    Widget card(int rows) => Glass(
          radius: TalonRadius.md,
          padding: const EdgeInsets.all(TalonSpace.lg),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              bar(120, 12),
              const SizedBox(height: TalonSpace.lg),
              for (var i = 0; i < rows; i++) ...[
                if (i > 0) const SizedBox(height: TalonSpace.md),
                bar(double.infinity, 16),
              ],
            ],
          ),
        );

    return Column(
      children: [
        card(3),
        const SizedBox(height: TalonSpace.lg),
        card(2),
        const SizedBox(height: TalonSpace.lg),
        card(4),
      ],
    );
  }
}

class _Section extends StatelessWidget {
  final String title;
  final Widget child;
  const _Section({required this.title, required this.child});

  @override
  Widget build(BuildContext context) {
    // A crisp solid card — white surface, hairline border, soft shadow —
    // floating on the off-white canvas. Not a blurred glass panel: the light
    // design reads as clean layered paper, not frost.
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: TalonColors.surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: TalonColors.glassStroke, width: 1),
        boxShadow: TalonShadows.soft,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title.toUpperCase(), style: TalonType.eyebrow),
          const SizedBox(height: 14),
          child,
        ],
      ),
    );
  }
}

/// A full-width action row for daemon controls (restart / dream): icon,
/// label + subtitle, and a trailing spinner while the action is in flight.
class _ControlButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final String subtitle;
  final bool pending;
  final VoidCallback? onTap;
  const _ControlButton({
    required this.icon,
    required this.label,
    required this.subtitle,
    required this.pending,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: TalonRadius.rMd,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: TalonRadius.rMd,
          border: Border.all(color: TalonColors.glassStroke),
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: TalonColors.textDim),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.35,
                      color: TalonColors.textFaint,
                    ),
                  ),
                ],
              ),
            ),
            if (pending)
              const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              )
            else
              Icon(Icons.chevron_right, size: 18, color: TalonColors.textFaint),
          ],
        ),
      ),
    );
  }
}

class _ModelRow extends StatelessWidget {
  final AppState state;
  final ConfigSnapshot cfg;
  final ValueChanged<String> onPick;
  const _ModelRow({
    required this.state,
    required this.cfg,
    required this.onPick,
  });

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
                  Icon(
                    Icons.unfold_more,
                    size: 16,
                    color: TalonColors.textFaint,
                  ),
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
                subtitle: Text(
                  m.provider,
                  style: TextStyle(color: TalonColors.textFaint),
                ),
                trailing: m.id == cfg.model
                    ? Icon(Icons.check, color: TalonColors.accent)
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

/// One equal-width segment of the Auto / Light / Dark selector.
class _ModeButton extends StatelessWidget {
  final String label;
  final IconData icon;
  final bool selected;
  final VoidCallback onTap;
  const _ModeButton({
    required this.label,
    required this.icon,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: AnimatedContainer(
        duration: TalonMotion.fast,
        height: 36,
        decoration: BoxDecoration(
          color: selected ? TalonColors.accent : TalonColors.surface,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: selected ? TalonColors.accent : TalonColors.glassStroke,
          ),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              icon,
              size: 15,
              color: selected ? Colors.white : TalonColors.textFaint,
            ),
            const SizedBox(width: 6),
            Text(
              label,
              style: TextStyle(
                color: selected ? Colors.white : TalonColors.textDim,
                fontSize: 13,
                fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Balanced accent grid from the glass-settings pass. Ten swatches become
/// two even rows of five, with free width shared by both margins and gaps.
class _SwatchGrid extends StatelessWidget {
  final List<Widget> swatches;
  const _SwatchGrid({required this.swatches});

  static const double _size = 34;
  static const double _minGap = 12;
  static const double _rowGap = 12;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final n = swatches.length;
        final maxCols = ((constraints.maxWidth + _minGap) / (_size + _minGap))
            .floor()
            .clamp(1, n);
        final rows = (n / maxCols).ceil();
        final cols = (n / rows).ceil();
        return Column(
          children: [
            for (var r = 0; r < rows; r++) ...[
              if (r > 0) const SizedBox(height: _rowGap),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                children: [
                  for (var i = r * cols; i < (r + 1) * cols; i++)
                    i < n
                        ? swatches[i]
                        : const SizedBox(width: _size, height: _size),
                ],
              ),
            ],
          ],
        );
      },
    );
  }
}

/// A circular accent color swatch: solid [color] or [gradient] fill, a check
/// mark when selected, and an optional glyph (the custom picker's eyedropper).
class _AccentSwatch extends StatelessWidget {
  final Color? color;
  final Gradient? gradient;
  final IconData? icon;
  final bool selected;
  final String tooltip;
  final VoidCallback onTap;
  const _AccentSwatch({
    this.color,
    this.gradient,
    this.icon,
    required this.selected,
    required this.tooltip,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    // Pick a glyph color that survives both light swatches (amber) and dark.
    final base = color ?? const Color(0xFF7C8CFF);
    final glyph = base.computeLuminance() > 0.6 ? Colors.black87 : Colors.white;
    return Tooltip(
      message: tooltip,
      waitDuration: const Duration(milliseconds: 400),
      child: Semantics(
        button: true,
        selected: selected,
        label: tooltip,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: AnimatedContainer(
            duration: TalonMotion.fast,
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: gradient == null ? color : null,
              gradient: gradient,
              border: Border.all(
                color: selected ? TalonColors.text : TalonColors.glassStroke,
                width: selected ? 2 : 1,
              ),
            ),
            child: selected
                ? Icon(Icons.check, size: 16, color: glyph)
                : (icon == null ? null : Icon(icon, size: 15, color: glyph)),
          ),
        ),
      ),
    );
  }
}

/// Dependency-free custom accent picker: hue + saturation sliders over
/// gradient tracks, with a live preview of the accent the active palette
/// would derive from the chosen seed.
class _AccentPickerDialog extends StatefulWidget {
  final Color initial;
  const _AccentPickerDialog({required this.initial});

  @override
  State<_AccentPickerDialog> createState() => _AccentPickerDialogState();
}

class _AccentPickerDialogState extends State<_AccentPickerDialog> {
  late double _hue;
  late double _sat;

  @override
  void initState() {
    super.initState();
    final hsl = HSLColor.fromColor(widget.initial);
    _hue = hsl.hue;
    // A grey initial (saturation ~0) would make the hue slider feel dead.
    _sat = hsl.saturation < 0.05 ? 0.8 : hsl.saturation;
  }

  Color get _seed => HSLColor.fromColor(Colors.red)
      .withHue(_hue)
      .withSaturation(_sat)
      .withLightness(0.62)
      .toColor();

  @override
  Widget build(BuildContext context) {
    final preview = TalonAccents.derive(TalonTheme.palette, _seed);
    return AlertDialog(
      backgroundColor: TalonColors.surface,
      title: const Text('Custom accent'),
      content: SizedBox(
        width: 320,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Live preview: the derived accent gradient with sample text.
            Container(
              height: 44,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: preview.accentGradient,
                borderRadius: TalonRadius.rMd,
              ),
              child: Text(
                'Talon',
                style: TextStyle(
                  fontWeight: FontWeight.w700,
                  color: preview.accent.computeLuminance() > 0.6
                      ? Colors.black87
                      : Colors.white,
                ),
              ),
            ),
            const SizedBox(height: 18),
            _gradientSlider(
              label: 'Hue',
              value: _hue,
              max: 360,
              gradient: LinearGradient(
                colors: [
                  for (var h = 0; h <= 360; h += 60)
                    HSLColor.fromAHSL(1, h.toDouble() % 360, _sat, 0.6)
                        .toColor(),
                ],
              ),
              onChanged: (v) => setState(() => _hue = v),
            ),
            const SizedBox(height: 12),
            _gradientSlider(
              label: 'Saturation',
              value: _sat,
              max: 1,
              gradient: LinearGradient(
                colors: [
                  HSLColor.fromAHSL(1, _hue, 0, 0.6).toColor(),
                  HSLColor.fromAHSL(1, _hue, 1, 0.6).toColor(),
                ],
              ),
              onChanged: (v) => setState(() => _sat = v),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            backgroundColor: preview.accent,
            foregroundColor: preview.accent.computeLuminance() > 0.6
                ? Colors.black87
                : Colors.white,
          ),
          onPressed: () => Navigator.of(context).pop(_seed),
          child: const Text('Use color'),
        ),
      ],
    );
  }

  /// A slider whose track is the given [gradient] — the standard trick of a
  /// rounded gradient bar underneath a Slider with transparent tracks.
  Widget _gradientSlider({
    required String label,
    required double value,
    required double max,
    required Gradient gradient,
    required ValueChanged<double> onChanged,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
        ),
        const SizedBox(height: 4),
        SizedBox(
          height: 32,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Container(
                height: 12,
                margin: const EdgeInsets.symmetric(horizontal: 2),
                decoration: BoxDecoration(
                  gradient: gradient,
                  borderRadius: TalonRadius.rPill,
                  border: Border.all(color: TalonColors.glassStroke),
                ),
              ),
              SliderTheme(
                data: SliderTheme.of(context).copyWith(
                  trackHeight: 12,
                  activeTrackColor: Colors.transparent,
                  inactiveTrackColor: Colors.transparent,
                  overlayShape:
                      const RoundSliderOverlayShape(overlayRadius: 14),
                  thumbShape: const RoundSliderThumbShape(
                    enabledThumbRadius: 9,
                    elevation: 2,
                  ),
                  thumbColor: Colors.white,
                ),
                child: Slider(
                  value: value.clamp(0, max),
                  min: 0,
                  max: max,
                  onChanged: onChanged,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
