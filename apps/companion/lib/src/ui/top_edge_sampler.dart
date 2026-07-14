// Adapted from flutter_shaders' AnimatedSampler:
// https://github.com/flutter/packages/blob/main/packages/flutter_shaders/lib/src/animated_sampler.dart
//
// Copyright 2013 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import 'dart:ui' as ui;

import 'package:flutter/rendering.dart';
import 'package:flutter/widgets.dart';

typedef TopEdgeSamplerBuilder = void Function(
  ui.Image image,
  Size sampledSize,
  Canvas canvas,
);

/// Paints [child] normally, then lets [builder] paint an effect from a cropped
/// snapshot of only the child's top [sampleHeight] logical pixels.
class TopEdgeSampler extends SingleChildRenderObjectWidget {
  const TopEdgeSampler({
    super.key,
    required this.builder,
    required this.sampleHeight,
    required super.child,
  });

  final TopEdgeSamplerBuilder builder;
  final double sampleHeight;

  @override
  RenderObject createRenderObject(BuildContext context) {
    return RenderTopEdgeSampler(
      builder: builder,
      sampleHeight: sampleHeight,
      devicePixelRatio: MediaQuery.devicePixelRatioOf(context),
    );
  }

  @override
  void updateRenderObject(
    BuildContext context,
    covariant RenderTopEdgeSampler renderObject,
  ) {
    renderObject
      ..builder = builder
      ..sampleHeight = sampleHeight
      ..devicePixelRatio = MediaQuery.devicePixelRatioOf(context);
  }
}

class RenderTopEdgeSampler extends RenderProxyBox {
  RenderTopEdgeSampler({
    required TopEdgeSamplerBuilder builder,
    required double sampleHeight,
    required double devicePixelRatio,
  })  : _builder = builder,
        _sampleHeight = sampleHeight,
        _devicePixelRatio = devicePixelRatio;

  TopEdgeSamplerBuilder _builder;
  set builder(TopEdgeSamplerBuilder value) {
    if (identical(value, _builder)) return;
    _builder = value;
    markNeedsCompositedLayerUpdate();
  }

  double _sampleHeight;
  set sampleHeight(double value) {
    if (value == _sampleHeight) return;
    _sampleHeight = value;
    markNeedsCompositedLayerUpdate();
  }

  double _devicePixelRatio;
  set devicePixelRatio(double value) {
    if (value == _devicePixelRatio) return;
    _devicePixelRatio = value;
    markNeedsCompositedLayerUpdate();
  }

  @override
  bool get alwaysNeedsCompositing => true;

  @override
  bool get isRepaintBoundary => true;

  @override
  OffsetLayer updateCompositedLayer({covariant TopEdgeLayer? oldLayer}) {
    final layer = oldLayer ?? TopEdgeLayer();
    layer
      ..callback = _builder
      ..size = size
      ..sampleHeight = _sampleHeight
      ..devicePixelRatio = _devicePixelRatio;
    return layer;
  }

  @override
  void paint(PaintingContext context, Offset offset) {
    if (size.isEmpty) return;
    assert(offset == Offset.zero);
    super.paint(context, offset);
  }
}

class TopEdgeLayer extends OffsetLayer {
  ui.Picture? _lastPicture;
  TopEdgeSamplerBuilder? callback;
  Size size = Size.zero;
  double sampleHeight = 0;
  double devicePixelRatio = 1;

  ui.Image _snapshot(Size sampledSize) {
    final scene = ui.SceneBuilder();
    final transform = Matrix4.diagonal3Values(
      devicePixelRatio,
      devicePixelRatio,
      1,
    );
    scene.pushTransform(transform.storage);
    addChildrenToScene(scene);
    scene.pop();
    return scene.build().toImageSync(
          (sampledSize.width * devicePixelRatio).ceil(),
          (sampledSize.height * devicePixelRatio).ceil(),
        );
  }

  @override
  void addToScene(ui.SceneBuilder builder) {
    if (size.isEmpty || callback == null) return;
    final sampledSize = Size(size.width, sampleHeight.clamp(0, size.height));
    final image = _snapshot(sampledSize);
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder);
    try {
      callback!(image, sampledSize, canvas);
    } finally {
      image.dispose();
    }
    final picture = recorder.endRecording();
    _lastPicture?.dispose();
    _lastPicture = picture;

    // Keep the real child as the sharp base, then add only the cropped effect.
    addChildrenToScene(builder);
    builder.addPicture(offset, picture);
  }

  @override
  void dispose() {
    _lastPicture?.dispose();
    super.dispose();
  }
}
