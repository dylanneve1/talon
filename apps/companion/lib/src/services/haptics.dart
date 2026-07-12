import 'package:flutter/services.dart';

/// Central gate for UI haptic feedback, so the Settings toggle silences every
/// call site at once. Desktop platforms no-op inside the engine anyway; this
/// exists for people who want a quiet phone.
///
/// Deliberately NOT used for the mesh find-my-phone ring (mesh_service.dart)
/// — that vibration is the feature itself, not feedback.
class Haptics {
  Haptics._();

  /// Flipped from Prefs at startup and by the Settings switch.
  static bool enabled = true;

  static void selection() {
    if (enabled) HapticFeedback.selectionClick();
  }

  static void medium() {
    if (enabled) HapticFeedback.mediumImpact();
  }
}
