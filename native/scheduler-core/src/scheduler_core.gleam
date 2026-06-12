//// Scheduler decision core — pure, deterministic policy functions for
//// talon's durable scheduler (retry backoff, circuit breaking,
//// missed-run catch-up).
////
//// Why Gleam: these are exactly the type-heavy, state-machine-shaped
//// rules where an exhaustively-checked functional language earns its
//// keep — the compiler proves every breaker transition and policy
//// branch is handled. Compiled to plain JavaScript (no BEAM, no
//// runtime dependency; artifacts committed under src/native/), and
//// the SAME source compiles to Erlang unchanged if talon ever grows a
//// multi-node BEAM orchestrator.
////
//// Boundary contract: every exported function takes and returns only
//// Ints and tuples of Ints, so the TS wrapper needs zero marshaling
//// beyond array destructuring. All times are epoch milliseconds. No
//// IO, no clocks, no randomness — jitter derives from a caller seed.

// ── Retry backoff ───────────────────────────────────────────────────────────

/// Exponential backoff with deterministic ±25% jitter.
///
/// attempt is 1-based (attempt 1 → base delay). The jitter seed should
/// vary per job (e.g. a job-id hash + attempt) so retries de-correlate
/// across jobs without the core needing randomness.
pub fn delay_ms(attempt: Int, base_ms: Int, cap_ms: Int, seed: Int) -> Int {
  let exp = pow2(clamp(attempt - 1, 0, 30))
  let raw = clamp(base_ms * exp, base_ms, cap_ms)
  // Linear-congruential step (Numerical Recipes constants), kept in
  // Int range; jitter in [-25%, +25%] of raw.
  let mixed = absolute({ seed * 1_664_525 + 1_013_904_223 } % 2_147_483_647)
  let jitter = { raw * { mixed % 51 - 25 } } / 100
  clamp(raw + jitter, base_ms, cap_ms)
}

// ── Circuit breaker ─────────────────────────────────────────────────────────
//
// State machine over coded Ints so the JS boundary stays flat:
//   state: 0 = Closed, 1 = Open, 2 = HalfOpen
//   event: 0 = success, 1 = failure, 2 = clock tick (no run finished)
//
// Closed counts consecutive failures; at `threshold` it opens. Open
// waits `cooldown_ms` from `since_ms`, then a tick moves it to
// HalfOpen (one probe allowed). HalfOpen: success closes, failure
// re-opens with a fresh cooldown.

pub type Breaker {
  Closed(failures: Int)
  Open(since_ms: Int)
  HalfOpen
}

pub type Outcome {
  Success
  Failure
  Tick
}

/// Decode the flat (state, failures, since) triple from the boundary.
fn decode(state: Int, failures: Int, since_ms: Int) -> Breaker {
  case state {
    1 -> Open(since_ms)
    2 -> HalfOpen
    _ -> Closed(failures)
  }
}

fn decode_outcome(event: Int) -> Outcome {
  case event {
    0 -> Success
    1 -> Failure
    _ -> Tick
  }
}

fn encode(breaker: Breaker) -> #(Int, Int, Int) {
  case breaker {
    Closed(failures) -> #(0, failures, 0)
    Open(since_ms) -> #(1, 0, since_ms)
    HalfOpen -> #(2, 0, 0)
  }
}

/// Advance the breaker. Returns the new (state, failures, since_ms).
pub fn breaker_step(
  state: Int,
  failures: Int,
  since_ms: Int,
  event: Int,
  now_ms: Int,
  threshold: Int,
  cooldown_ms: Int,
) -> #(Int, Int, Int) {
  let next = case decode(state, failures, since_ms), decode_outcome(event) {
    Closed(_), Success -> Closed(0)
    Closed(n), Failure ->
      case n + 1 >= threshold {
        True -> Open(now_ms)
        False -> Closed(n + 1)
      }
    Closed(n), Tick -> Closed(n)
    Open(since), Tick | Open(since), Success | Open(since), Failure ->
      case now_ms - since >= cooldown_ms {
        True -> HalfOpen
        False -> Open(since)
      }
    HalfOpen, Success -> Closed(0)
    HalfOpen, Failure -> Open(now_ms)
    HalfOpen, Tick -> HalfOpen
  }
  encode(next)
}

/// 1 when a run may be attempted in this state, else 0. Open never
/// runs (ticks promote it to HalfOpen once cooled down); HalfOpen
/// allows the single probe; Closed always runs.
pub fn breaker_allows_run(state: Int) -> Int {
  case state {
    1 -> 0
    _ -> 1
  }
}

// ── Missed-run catch-up ─────────────────────────────────────────────────────
//
// For interval jobs (`every_ms`), after downtime: how many fire times
// were missed, and what should actually run now? Policy codes:
//   0 = skip   (drop missed runs; schedule next from now)
//   1 = once   (collapse any number of missed runs into one)
//   2 = all    (run every missed occurrence, capped by `max`)

/// Number of complete intervals elapsed since last_run beyond the
/// first due point — i.e. fire times in (last_run, now].
pub fn missed_count(last_run_ms: Int, every_ms: Int, now_ms: Int) -> Int {
  case every_ms <= 0 || now_ms <= last_run_ms {
    True -> 0
    False -> { now_ms - last_run_ms } / every_ms
  }
}

/// The next due time strictly after now.
pub fn next_due_ms(last_run_ms: Int, every_ms: Int, now_ms: Int) -> Int {
  case every_ms <= 0 {
    True -> now_ms
    False ->
      case now_ms <= last_run_ms {
        True -> last_run_ms + every_ms
        False ->
          last_run_ms
          + { { { now_ms - last_run_ms } / every_ms } + 1 } * every_ms
      }
  }
}

/// How many runs to fire immediately given `missed` occurrences under
/// `policy` (0=skip, 1=once, 2=all capped at `max`).
pub fn catchup_runs(missed: Int, policy: Int, max: Int) -> Int {
  case policy {
    1 ->
      case missed > 0 {
        True -> 1
        False -> 0
      }
    2 -> clamp(missed, 0, max)
    _ -> 0
  }
}

// ── Int helpers (stdlib-free so the emitted JS has no dependencies) ─────────

fn clamp(n: Int, low: Int, high: Int) -> Int {
  case n < low {
    True -> low
    False ->
      case n > high {
        True -> high
        False -> n
      }
  }
}

fn absolute(n: Int) -> Int {
  case n < 0 {
    True -> 0 - n
    False -> n
  }
}

fn pow2(n: Int) -> Int {
  case n <= 0 {
    True -> 1
    False -> 2 * pow2(n - 1)
  }
}
