/// Tool-name formatting shared by every surface that shows a tool call.
///
/// Pure Dart on purpose: the voice session (state layer) needs the same
/// phrasing the timeline (UI layer) uses, and state must not import widgets.
library;

/// De-noise MCP tool names for display:
/// `mcp__email-tools__search_emails` → `email · search_emails`.
/// Non-MCP names (e.g. `Bash`, `Read`) are shown as-is.
String toolDisplayName(String raw) {
  if (!raw.startsWith('mcp__')) return raw;
  final parts = raw.substring(5).split('__');
  if (parts.length < 2) return raw;
  var server = parts.first;
  if (server.endsWith('-tools')) {
    server = server.substring(0, server.length - '-tools'.length);
  }
  final tool = parts.sublist(1).join('__');
  return '$server · $tool';
}

/// The MCP server a tool belongs to (`mcp__email-tools__search_emails` →
/// `email`), or null for a built-in tool.
String? toolServer(String raw) {
  if (!raw.startsWith('mcp__')) return null;
  final parts = raw.substring(5).split('__');
  if (parts.length < 2) return null;
  var server = parts.first;
  if (server.endsWith('-tools')) {
    server = server.substring(0, server.length - '-tools'.length);
  }
  return server;
}

/// A human phrase for a tool, for surfaces that *narrate* rather than tabulate.
///
/// The chat timeline is a table: `email · search_emails` is right there, next
/// to arguments and a duration. Voice mode is a sentence read at a glance
/// while the phone sits on a table, and `mcp__email-tools__search_emails` is
/// unreadable in that position. Built-ins get hand-written phrases; anything
/// else is de-snake-cased into words and sentence-cased —
/// `search_emails` → "Search emails", `getWeather` → "Get weather".
String toolPhrase(String raw) {
  const builtins = <String, String>{
    'bash': 'Run a command',
    'shell': 'Run a command',
    'read': 'Read a file',
    'write': 'Write a file',
    'edit': 'Edit a file',
    'multiedit': 'Edit a file',
    'notebookedit': 'Edit a notebook',
    'glob': 'Find files',
    'grep': 'Search files',
    'websearch': 'Search the web',
    'webfetch': 'Read a page',
    'task': 'Run a subtask',
    'todowrite': 'Update the plan',
    'skill': 'Load a skill',
  };
  final tool = raw.startsWith('mcp__')
      ? (raw.substring(5).split('__')..removeAt(0)).join('__')
      : raw;
  final phrase = builtins[tool.toLowerCase().replaceAll('_', '')];
  if (phrase != null) return phrase;
  final words = tool
      .replaceAll('_', ' ')
      // camelCase / PascalCase → spaced words.
      .replaceAllMapped(RegExp(r'(?<=[a-z0-9])([A-Z])'), (m) => ' ${m[1]}')
      .trim()
      .toLowerCase();
  if (words.isEmpty) return raw;
  return words[0].toUpperCase() + words.substring(1);
}
