/// <reference types="./scheduler_core.d.mts" />
import { CustomType as $CustomType, divideInt } from "./gleam.mjs";

export class Closed extends $CustomType {
  constructor(failures) {
    super();
    this.failures = failures;
  }
}
export const Breaker$Closed = (failures) => new Closed(failures);
export const Breaker$isClosed = (value) => value instanceof Closed;
export const Breaker$Closed$failures = (value) => value.failures;
export const Breaker$Closed$0 = (value) => value.failures;

export class Open extends $CustomType {
  constructor(since_ms) {
    super();
    this.since_ms = since_ms;
  }
}
export const Breaker$Open = (since_ms) => new Open(since_ms);
export const Breaker$isOpen = (value) => value instanceof Open;
export const Breaker$Open$since_ms = (value) => value.since_ms;
export const Breaker$Open$0 = (value) => value.since_ms;

export class HalfOpen extends $CustomType {}
export const Breaker$HalfOpen = () => new HalfOpen();
export const Breaker$isHalfOpen = (value) => value instanceof HalfOpen;

export class Success extends $CustomType {}
export const Outcome$Success = () => new Success();
export const Outcome$isSuccess = (value) => value instanceof Success;

export class Failure extends $CustomType {}
export const Outcome$Failure = () => new Failure();
export const Outcome$isFailure = (value) => value instanceof Failure;

export class Tick extends $CustomType {}
export const Outcome$Tick = () => new Tick();
export const Outcome$isTick = (value) => value instanceof Tick;

function clamp(n, low, high) {
  let $ = n < low;
  if ($) {
    return low;
  } else {
    let $1 = n > high;
    if ($1) {
      return high;
    } else {
      return n;
    }
  }
}

function absolute(n) {
  let $ = n < 0;
  if ($) {
    return 0 - n;
  } else {
    return n;
  }
}

function pow2(n) {
  let $ = n <= 0;
  if ($) {
    return 1;
  } else {
    return 2 * pow2(n - 1);
  }
}

/**
 * Exponential backoff with deterministic ±25% jitter.
 *
 * attempt is 1-based (attempt 1 → base delay). The jitter seed should
 * vary per job (e.g. a job-id hash + attempt) so retries de-correlate
 * across jobs without the core needing randomness.
 */
export function delay_ms(attempt, base_ms, cap_ms, seed) {
  let exp = pow2(clamp(attempt - 1, 0, 30));
  let raw = clamp(base_ms * exp, base_ms, cap_ms);
  let mixed = absolute((seed * 1_664_525 + 1_013_904_223) % 2_147_483_647);
  let jitter = globalThis.Math.trunc(raw * ((mixed % 51) - 25) / 100);
  return clamp(raw + jitter, base_ms, cap_ms);
}

/**
 * Decode the flat (state, failures, since) triple from the boundary.
 * 
 * @ignore
 */
function decode(state, failures, since_ms) {
  if (state === 1) {
    return new Open(since_ms);
  } else if (state === 2) {
    return new HalfOpen();
  } else {
    return new Closed(failures);
  }
}

function decode_outcome(event) {
  if (event === 0) {
    return new Success();
  } else if (event === 1) {
    return new Failure();
  } else {
    return new Tick();
  }
}

function encode(breaker) {
  if (breaker instanceof Closed) {
    let failures = breaker.failures;
    return [0, failures, 0];
  } else if (breaker instanceof Open) {
    let since_ms = breaker.since_ms;
    return [1, 0, since_ms];
  } else {
    return [2, 0, 0];
  }
}

/**
 * Advance the breaker. Returns the new (state, failures, since_ms).
 */
export function breaker_step(
  state,
  failures,
  since_ms,
  event,
  now_ms,
  threshold,
  cooldown_ms
) {
  let _block;
  let $ = decode(state, failures, since_ms);
  let $1 = decode_outcome(event);
  if ($ instanceof Closed) {
    if ($1 instanceof Success) {
      _block = new Closed(0);
    } else if ($1 instanceof Failure) {
      let n = $.failures;
      let $2 = (n + 1) >= threshold;
      if ($2) {
        _block = new Open(now_ms);
      } else {
        _block = new Closed(n + 1);
      }
    } else {
      _block = $;
    }
  } else if ($ instanceof Open) {
    if ($1 instanceof Success) {
      let since = $.since_ms;
      let $2 = (now_ms - since) >= cooldown_ms;
      if ($2) {
        _block = new HalfOpen();
      } else {
        _block = new Open(since);
      }
    } else if ($1 instanceof Failure) {
      let since = $.since_ms;
      let $2 = (now_ms - since) >= cooldown_ms;
      if ($2) {
        _block = new HalfOpen();
      } else {
        _block = new Open(since);
      }
    } else {
      let since = $.since_ms;
      let $2 = (now_ms - since) >= cooldown_ms;
      if ($2) {
        _block = new HalfOpen();
      } else {
        _block = new Open(since);
      }
    }
  } else if ($1 instanceof Success) {
    _block = new Closed(0);
  } else if ($1 instanceof Failure) {
    _block = new Open(now_ms);
  } else {
    _block = $;
  }
  let next = _block;
  return encode(next);
}

/**
 * 1 when a run may be attempted in this state, else 0. Open never
 * runs (ticks promote it to HalfOpen once cooled down); HalfOpen
 * allows the single probe; Closed always runs.
 */
export function breaker_allows_run(state) {
  if (state === 1) {
    return 0;
  } else {
    return 1;
  }
}

/**
 * Number of complete intervals elapsed since last_run beyond the
 * first due point — i.e. fire times in (last_run, now].
 */
export function missed_count(last_run_ms, every_ms, now_ms) {
  let $ = (every_ms <= 0) || (now_ms <= last_run_ms);
  if ($) {
    return 0;
  } else {
    return divideInt((now_ms - last_run_ms), every_ms);
  }
}

/**
 * The next due time strictly after now.
 */
export function next_due_ms(last_run_ms, every_ms, now_ms) {
  let $ = every_ms <= 0;
  if ($) {
    return now_ms;
  } else {
    let $1 = now_ms <= last_run_ms;
    if ($1) {
      return last_run_ms + every_ms;
    } else {
      return last_run_ms + ((divideInt((now_ms - last_run_ms), every_ms)) + 1) * every_ms;
    }
  }
}

/**
 * How many runs to fire immediately given `missed` occurrences under
 * `policy` (0=skip, 1=once, 2=all capped at `max`).
 */
export function catchup_runs(missed, policy, max) {
  if (policy === 1) {
    let $ = missed > 0;
    if ($) {
      return 1;
    } else {
      return 0;
    }
  } else if (policy === 2) {
    return clamp(missed, 0, max);
  } else {
    return 0;
  }
}
