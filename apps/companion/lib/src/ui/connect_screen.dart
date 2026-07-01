import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/connection.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'glass.dart';

/// First-run onboarding and the Settings page for the connection profile.
///
/// Two modes: connect to a Talon on *this computer* (desktop can also launch
/// it), or to a *remote bridge* by host/IP + token — the path a phone takes to
/// reach a Talon running on your desktop or server.
class ConnectScreen extends StatefulWidget {
  final AppState state;
  final bool firstRun;
  const ConnectScreen({super.key, required this.state, required this.firstRun});

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen> {
  late bool _remote;
  late final TextEditingController _host;
  late final TextEditingController _port;
  late final TextEditingController _token;
  bool _tls = false;

  bool get _isDesktop {
    try {
      return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
    } catch (_) {
      return false;
    }
  }

  @override
  void initState() {
    super.initState();
    final c = widget.state.config;
    _remote = !c.isLoopback || !_isDesktop;
    _tls = c.tls;
    _host = TextEditingController(text: c.isLoopback ? '' : c.host);
    _port = TextEditingController(text: c.port.toString());
    _token = TextEditingController(text: c.token ?? '');
  }

  @override
  void dispose() {
    _host.dispose();
    _port.dispose();
    _token.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    var port = int.tryParse(_port.text.trim()) ?? 19880;
    final token = _token.text.trim();

    // Normalize whatever the user typed into the host box: strip a scheme,
    // path, or stray whitespace, and pull out an embedded `:port` or TLS hint.
    // This is what lets a reachable endpoint actually connect even when the
    // value was pasted as a full URL like https://host:19880/.
    var host = _remote ? _host.text.trim() : '127.0.0.1';
    var tls = _remote && _tls;
    if (_remote) {
      final parsed = ConnectionConfig.parseHostInput(_host.text);
      host = parsed.host;
      if (parsed.port != null) {
        port = parsed.port!;
        _port.text = port.toString();
      }
      if (parsed.tls != null) {
        tls = parsed.tls!;
        if (_tls != tls) setState(() => _tls = tls);
      }
      if (host != _host.text.trim()) _host.text = host;
    } else {
      port = 19880;
    }

    final config = ConnectionConfig(
      host: host,
      port: port,
      token: _remote && token.isNotEmpty ? token : null,
      tls: tls,
      manageLocalDaemon: false,
      localAutoDiscover: !_remote && _isDesktop,
    );
    await widget.state.prefs.setOnboarded(true);
    await widget.state.applyConfig(config);
    if (mounted && !widget.firstRun) Navigator.of(context).maybePop();
  }

  @override
  Widget build(BuildContext context) {
    final body = Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 460),
          child: Glass(
            radius: 26,
            blur: 26,
            padding: const EdgeInsets.all(26),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const BrandMark(size: 44),
                    const SizedBox(width: 14),
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          widget.firstRun ? 'Welcome to Talon' : 'Connection',
                          style: const TextStyle(
                              fontSize: 20, fontWeight: FontWeight.w700),
                        ),
                        const Text(
                          'Connect your companion',
                          style: TextStyle(
                              color: TalonColors.textFaint, fontSize: 12.5),
                        ),
                      ],
                    ),
                  ],
                ),
                const SizedBox(height: 22),
                _modeToggle(),
                const SizedBox(height: 18),
                if (_remote) ..._remoteFields() else ..._localFields(),
                const SizedBox(height: 22),
                _ConnectButton(onTap: _connect),
                if (widget.state.conn == ConnState.error &&
                    widget.state.connError != null) ...[
                  const SizedBox(height: 14),
                  Text(
                    widget.state.connError!,
                    style:
                        const TextStyle(color: TalonColors.bad, fontSize: 12.5),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );

    if (widget.firstRun) return body;
    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        title: const Text('Settings'),
      ),
      body: body,
    );
  }

  Widget _modeToggle() {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: TalonColors.void0.withValues(alpha: 0.6),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: TalonColors.glassStroke),
      ),
      child: Row(
        children: [
          _modeButton(
            label: 'This computer',
            icon: Icons.computer,
            selected: !_remote,
            enabled: _isDesktop,
            onTap: () => setState(() => _remote = false),
          ),
          _modeButton(
            label: 'Remote bridge',
            icon: Icons.lan_outlined,
            selected: _remote,
            enabled: true,
            onTap: () => setState(() => _remote = true),
          ),
        ],
      ),
    );
  }

  Widget _modeButton({
    required String label,
    required IconData icon,
    required bool selected,
    required bool enabled,
    required VoidCallback onTap,
  }) {
    return Expanded(
      child: Opacity(
        opacity: enabled ? 1 : 0.4,
        child: GestureDetector(
          onTap: enabled ? onTap : null,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            padding: const EdgeInsets.symmetric(vertical: 11),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(11),
              gradient: selected ? TalonColors.accentGradient : null,
            ),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon,
                    size: 16,
                    color: selected ? Colors.white : TalonColors.textDim),
                const SizedBox(width: 7),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: selected ? Colors.white : TalonColors.textDim,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _localFields() => [
        const _Hint(
          'Talon must be running on this computer. The app finds and connects '
          'to it automatically — no address or token needed.',
        ),
      ];

  List<Widget> _remoteFields() => [
        const _Hint(
          'Point at a Talon bridge running elsewhere — your desktop or a '
          'server. Set its host to 0.0.0.0 and a token to allow remote access.',
        ),
        const SizedBox(height: 14),
        _field(_host, 'Host or IP', hint: '192.168.1.20'),
        const SizedBox(height: 12),
        _field(_port, 'Port', hint: '19880', number: true),
        const SizedBox(height: 12),
        _field(_token, 'Token', hint: 'shared secret', obscure: true),
        const SizedBox(height: 6),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          value: _tls,
          onChanged: (v) => setState(() => _tls = v),
          thumbColor: WidgetStateProperty.resolveWith((s) =>
              s.contains(WidgetState.selected) ? TalonColors.accent : null),
          title: const Text('Use HTTPS / TLS', style: TextStyle(fontSize: 14)),
          subtitle: const Text(
              'Turn on if the bridge is behind a TLS reverse proxy (Caddy, '
              'nginx, Tailscale Serve). Auto-detected from an https:// host.',
              style: TextStyle(fontSize: 12, color: TalonColors.textFaint)),
        ),
      ];

  Widget _field(
    TextEditingController c,
    String label, {
    String? hint,
    bool number = false,
    bool obscure = false,
    bool mono = false,
  }) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label,
            style: const TextStyle(
                fontSize: 12,
                color: TalonColors.textDim,
                fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        TextField(
          controller: c,
          obscureText: obscure,
          keyboardType: number ? TextInputType.number : null,
          inputFormatters:
              number ? [FilteringTextInputFormatter.digitsOnly] : null,
          style: TextStyle(fontSize: 14, fontFamily: mono ? 'monospace' : null),
          decoration: InputDecoration(
            hintText: hint,
            filled: true,
            fillColor: TalonColors.void0.withValues(alpha: 0.5),
            contentPadding:
                const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: TalonColors.glassStroke),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: TalonColors.glassStroke),
            ),
            focusedBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(12),
              borderSide: const BorderSide(color: TalonColors.accent),
            ),
          ),
        ),
      ],
    );
  }
}

class _Hint extends StatelessWidget {
  final String text;
  const _Hint(this.text);

  @override
  Widget build(BuildContext context) => Text(
        text,
        style: const TextStyle(
            fontSize: 12.5, color: TalonColors.textFaint, height: 1.5),
      );
}

class _ConnectButton extends StatelessWidget {
  final VoidCallback onTap;
  const _ConnectButton({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        decoration: const BoxDecoration(
          borderRadius: TalonRadius.rMd,
          gradient: TalonColors.accentGradient,
        ),
        child: const Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.bolt, color: Colors.white, size: 19),
            SizedBox(width: 8),
            Text(
              'Connect',
              style: TextStyle(
                color: Colors.white,
                fontWeight: FontWeight.w700,
                fontSize: 15,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
