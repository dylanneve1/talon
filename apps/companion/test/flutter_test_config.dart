import 'dart:async';

import 'package:progressive_blur/progressive_blur.dart';

/// Runs before every test file in this suite. The frost shader
/// (TopEdgeFrost → ProgressiveBlurWidget) must be precached before any
/// widget that uses it builds — testWidgets bodies run under FakeAsync,
/// where the real asset load could never complete. Deliberately no
/// TestWidgetsFlutterBinding here: initializing it swaps in flutter_test's
/// mock HttpClient and breaks the bridge integration tests that talk to a
/// real local server.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  try {
    await ProgressiveBlurWidget.precache();
  } catch (_) {
    // No shader support in this environment — frost degrades to no blur.
  }
  await testMain();
}
