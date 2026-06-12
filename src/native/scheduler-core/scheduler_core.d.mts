import type * as _ from "./gleam.d.mts";

export class Closed extends _.CustomType {
  /** @deprecated */
  constructor(failures: number);
  /** @deprecated */
  failures: number;
}
export function Breaker$Closed(failures: number): Breaker$;
export function Breaker$isClosed(value: any): value is Breaker$;
export function Breaker$Closed$0(value: Breaker$): number;
export function Breaker$Closed$failures(value: Breaker$): number;

export class Open extends _.CustomType {
  /** @deprecated */
  constructor(since_ms: number);
  /** @deprecated */
  since_ms: number;
}
export function Breaker$Open(since_ms: number): Breaker$;
export function Breaker$isOpen(value: any): value is Breaker$;
export function Breaker$Open$0(value: Breaker$): number;
export function Breaker$Open$since_ms(value: Breaker$): number;

export class HalfOpen extends _.CustomType {}
export function Breaker$HalfOpen(): Breaker$;
export function Breaker$isHalfOpen(value: any): value is Breaker$;

export type Breaker$ = Closed | Open | HalfOpen;

export class Success extends _.CustomType {}
export function Outcome$Success(): Outcome$;
export function Outcome$isSuccess(value: any): value is Outcome$;

export class Failure extends _.CustomType {}
export function Outcome$Failure(): Outcome$;
export function Outcome$isFailure(value: any): value is Outcome$;

export class Tick extends _.CustomType {}
export function Outcome$Tick(): Outcome$;
export function Outcome$isTick(value: any): value is Outcome$;

export type Outcome$ = Success | Failure | Tick;

export function delay_ms(
  attempt: number,
  base_ms: number,
  cap_ms: number,
  seed: number
): number;

export function breaker_step(
  state: number,
  failures: number,
  since_ms: number,
  event: number,
  now_ms: number,
  threshold: number,
  cooldown_ms: number
): [number, number, number];

export function breaker_allows_run(state: number): number;

export function missed_count(
  last_run_ms: number,
  every_ms: number,
  now_ms: number
): number;

export function next_due_ms(
  last_run_ms: number,
  every_ms: number,
  now_ms: number
): number;

export function catchup_runs(missed: number, policy: number, max: number): number;
