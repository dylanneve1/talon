fn main() {
    // Emits the platform linker flags a N-API addon needs (notably
    // `-undefined dynamic_lookup` on macOS, where Node's symbols are
    // resolved at load time rather than link time).
    napi_build::setup();
}
