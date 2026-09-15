import 'dart:io';

import 'package:flutter/foundation.dart';

import '../models/bridge_models.dart';

/// Extension → MIME for the files a companion user is likely to attach. The
/// daemon re-derives the type authoritatively on upload; this is what the
/// composer needs locally to decide between a thumbnail and a file chip.
const Map<String, String> _mimeByExtension = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'bmp': 'image/bmp',
  'heic': 'image/heic',
  'heif': 'image/heif',
  'avif': 'image/avif',
  'tif': 'image/tiff',
  'tiff': 'image/tiff',
  'svg': 'image/svg+xml',
  'zip': 'application/zip',
  'gz': 'application/gzip',
  'tgz': 'application/gzip',
  'bz2': 'application/x-bzip2',
  'xz': 'application/x-xz',
  'zst': 'application/zstd',
  'tar': 'application/x-tar',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/vnd.rar',
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx':
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx':
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'epub': 'application/epub+zip',
  'rtf': 'application/rtf',
  'txt': 'text/plain',
  'log': 'text/plain',
  'md': 'text/markdown',
  'csv': 'text/csv',
  'tsv': 'text/tab-separated-values',
  'json': 'application/json',
  'jsonl': 'application/x-ndjson',
  'xml': 'application/xml',
  'yaml': 'application/yaml',
  'yml': 'application/yaml',
  'toml': 'application/toml',
  'html': 'text/html',
  'css': 'text/css',
  'js': 'text/javascript',
  'ts': 'text/x-typescript',
  'dart': 'text/x-dart',
  'py': 'text/x-python',
  'rs': 'text/x-rust',
  'go': 'text/x-go',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'h': 'text/x-c',
  'cpp': 'text/x-c++',
  'sh': 'application/x-sh',
  'sql': 'application/sql',
  'patch': 'text/x-diff',
  'diff': 'text/x-diff',
  'mp3': 'audio/mpeg',
  'm4a': 'audio/mp4',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'opus': 'audio/opus',
  'flac': 'audio/flac',
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'webm': 'video/webm',
  'mkv': 'video/x-matroska',
  'avi': 'video/x-msvideo',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'apk': 'application/vnd.android.package-archive',
  'deb': 'application/vnd.debian.binary-package',
  'exe': 'application/vnd.microsoft.portable-executable',
  'iso': 'application/x-iso9660-image',
};

/// Best-effort MIME type for a file name. `application/octet-stream` when the
/// extension says nothing — which is a correct answer for an upload, and the
/// daemon refines it on arrival.
String mimeTypeFor(String filename) {
  final dot = filename.lastIndexOf('.');
  if (dot < 0 || dot == filename.length - 1) return 'application/octet-stream';
  final ext = filename.substring(dot + 1).toLowerCase();
  return _mimeByExtension[ext] ?? 'application/octet-stream';
}

/// Size as a short human label ("4.2 MB").
String formatBytes(int size) {
  if (size <= 0) return '';
  if (size < 1024) return '$size B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  var value = size / 1024;
  var unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  final rounded = value < 10 ? value.toStringAsFixed(1) : value.round();
  return '$rounded ${units[unit]}';
}

/// A file the user has staged on the composer but not yet sent. Lives as a
/// path on *this* device until the send uploads it to the daemon.
class StagedFile {
  /// Local path on the device running the app.
  final String path;
  final String name;
  final int size;
  final String mimeType;

  /// Bytes uploaded so far, while a send is in flight.
  int sent = 0;

  /// True once this file's upload has started.
  bool uploading = false;

  StagedFile({
    required this.path,
    required this.name,
    required this.size,
    required this.mimeType,
  });

  /// Stage a file already on disk. Returns null when it is missing or empty —
  /// a dropped directory, or a file that vanished between pick and send.
  static StagedFile? fromPath(String path, {String? name, int? size}) {
    final file = File(path);
    final length = size ?? (file.existsSync() ? file.lengthSync() : 0);
    if (length <= 0) return null;
    final label = name ?? path.split(Platform.pathSeparator).last;
    return StagedFile(
      path: path,
      name: label,
      size: length,
      mimeType: mimeTypeFor(label),
    );
  }

  bool get isImage => mimeType.startsWith('image/');

  /// 0–1 upload progress, or null before the upload starts.
  double? get progress =>
      uploading ? (size <= 0 ? 0 : (sent / size).clamp(0.0, 1.0)) : null;

  String get sizeLabel => formatBytes(size);
}

/// The composer's staged attachments. Held outside the composer widget so the
/// desktop drop target — which wraps the whole chat pane — can stage files
/// into the same list the composer renders and sends.
class ComposerAttachments extends ChangeNotifier {
  final List<StagedFile> _files = [];

  /// Files staged for the next send, in the order they were added.
  List<StagedFile> get files => List.unmodifiable(_files);
  bool get isEmpty => _files.isEmpty;
  bool get isNotEmpty => _files.isNotEmpty;
  int get length => _files.length;

  /// True while a send is uploading the staged files.
  bool get uploading => _files.any((f) => f.uploading);

  /// Stage files by path, skipping directories, empty files and any path
  /// already staged. Returns how many were added.
  int addPaths(Iterable<String> paths) {
    var added = 0;
    for (final path in paths) {
      if (_files.any((f) => f.path == path)) continue;
      final staged = StagedFile.fromPath(path);
      if (staged == null) continue;
      _files.add(staged);
      added += 1;
    }
    if (added > 0) notifyListeners();
    return added;
  }

  /// Stage already-described files (the picker hands back name + size).
  int addAll(Iterable<StagedFile> staged) {
    var added = 0;
    for (final file in staged) {
      if (_files.any((f) => f.path == file.path)) continue;
      _files.add(file);
      added += 1;
    }
    if (added > 0) notifyListeners();
    return added;
  }

  void remove(StagedFile file) {
    if (_files.remove(file)) notifyListeners();
  }

  void clear() {
    if (_files.isEmpty) return;
    _files.clear();
    notifyListeners();
  }

  /// Put files back after a failed send so nothing is silently thrown away.
  void restore(List<StagedFile> files) {
    for (final file in files) {
      file.uploading = false;
      file.sent = 0;
    }
    _files
      ..clear()
      ..addAll(files);
    notifyListeners();
  }

  /// Mark progress for one file's in-flight upload.
  void markProgress(StagedFile file, int sent) {
    file.uploading = true;
    file.sent = sent;
    notifyListeners();
  }

  /// Clear every in-flight marker (upload finished, or gave up).
  void clearProgress() {
    for (final file in _files) {
      file.uploading = false;
      file.sent = 0;
    }
    notifyListeners();
  }
}

/// The uploader the composer calls per staged file. Returns null on failure.
typedef UploadFile = Future<Attachment?> Function(
  Stream<List<int>> bytes,
  int length,
  String filename,
  String contentType, {
  void Function(int sent)? onProgress,
});
