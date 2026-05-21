# Changelog

## [1.14.0](https://github.com/dylanneve1/talon/compare/v1.13.0...v1.14.0) (2026-05-21)


### Features

* **status:** hide cache section on backends that don't report it ([#238](https://github.com/dylanneve1/talon/issues/238)) ([7c606bf](https://github.com/dylanneve1/talon/commit/7c606bffc4ee7b683374eda7b1b694e8d4171d88))


### Bug Fixes

* **chat:** restore valid per-chat backend state ([#236](https://github.com/dylanneve1/talon/issues/236)) ([b8b5756](https://github.com/dylanneve1/talon/commit/b8b5756a4113d42f89f33c57f80f683852aa17a4))
* **codex:** detect usage exhaustion, fix misleading log, filter catalog by auth mode ([#239](https://github.com/dylanneve1/talon/issues/239)) ([194cdb3](https://github.com/dylanneve1/talon/commit/194cdb3e978bd11973ec6155c39cbe5945cac102))
* **codex:** read last_token_usage from rollout JSONL for accurate context fill ([#237](https://github.com/dylanneve1/talon/issues/237)) ([1917f85](https://github.com/dylanneve1/talon/commit/1917f858ea7a07c84fdcaa507c61cad0a9c8da9c))

## [1.13.0](https://github.com/dylanneve1/talon/compare/v1.12.0...v1.13.0) (2026-05-21)


### Features

* Antigravity (Python SDK) + agy (local OAuth) backends + MCP supervisor refactor ([#224](https://github.com/dylanneve1/talon/issues/224)) ([b8ba43f](https://github.com/dylanneve1/talon/commit/b8ba43f80dfd7017f2bb789f4b34dde59cc6a6c0))
* **backend:** multi-role BackendPool + per-chat overrides + /model integration + openai-agents MCP fixes ([#211](https://github.com/dylanneve1/talon/issues/211)) ([cb2a661](https://github.com/dylanneve1/talon/commit/cb2a661e9c9fb109d3fd57b8441585d2f9eaafa5))
* **codex:** dynamic model discovery via OpenAI /v1/models ([#228](https://github.com/dylanneve1/talon/issues/228)) ([6f88189](https://github.com/dylanneve1/talon/commit/6f88189f040bf90432cddf81ec2d770058a03b21))


### Bug Fixes

* **claude-sdk:** post-result watchdog for stuck SDK iterator ([#218](https://github.com/dylanneve1/talon/issues/218)) ([a6796d1](https://github.com/dylanneve1/talon/commit/a6796d1fa5f8c1c07b1f6950e2a700281e9eb9ff))
* **claude-sdk:** preserve SDK loop on terminator delivery failure via SDK's native error pipeline ([#159](https://github.com/dylanneve1/talon/issues/159)) ([9fefe59](https://github.com/dylanneve1/talon/commit/9fefe59ec4dcdd50fc05a41dfef162c24122951a))
* **codex:** auto-approve MCP tools + run with full permissions ([#234](https://github.com/dylanneve1/talon/issues/234)) ([14e55f0](https://github.com/dylanneve1/talon/commit/14e55f08e5ee95977058926d1a90971f67b94eeb))
* **codex:** harden ChatGPT-OAuth model compat — silent-exit recovery + runtime learning ([#231](https://github.com/dylanneve1/talon/issues/231)) ([892530a](https://github.com/dylanneve1/talon/commit/892530ad30c9ab380d97480f724d8926cfb8a1d7))
* **codex:** isolate backend auth credentials ([#227](https://github.com/dylanneve1/talon/issues/227)) ([088dd87](https://github.com/dylanneve1/talon/commit/088dd87800b422ffde187db4de6264b22d140b55))
* **codex:** only mark turn terminated on `completed` mcp_tool_call status ([#233](https://github.com/dylanneve1/talon/issues/233)) ([dea6f61](https://github.com/dylanneve1/talon/commit/dea6f614421bfa04d44f0d8dcc9ccc22bf4faeef))
* **daemon+heartbeat:** silent crash on /restart and stuck heartbeat [#376](https://github.com/dylanneve1/talon/issues/376) ([#223](https://github.com/dylanneve1/talon/issues/223)) ([669ab82](https://github.com/dylanneve1/talon/commit/669ab82751a102330605133cb2d835220f382288))
* **openai-agents:** persist turn memory + expand ~/ in send_* actions ([#208](https://github.com/dylanneve1/talon/issues/208)) ([bf2b01b](https://github.com/dylanneve1/talon/commit/bf2b01bbe95bfe1744db7721a62e95612b2bc627))

## [1.12.0](https://github.com/dylanneve1/talon/compare/v1.11.0...v1.12.0) (2026-05-18)


### Features

* **backend:** add Codex as a fourth backend provider ([#174](https://github.com/dylanneve1/talon/issues/174)) ([7d476b9](https://github.com/dylanneve1/talon/commit/7d476b97c654bec047965a96a95fc82118539153))
* **backend:** add Kilo CLI as backend provider ([#161](https://github.com/dylanneve1/talon/issues/161)) ([9263611](https://github.com/dylanneve1/talon/commit/926361165a3d8773a8b3165fea875019dcb503a3))
* **backend:** add OpenAI Agents SDK as fifth backend ([#199](https://github.com/dylanneve1/talon/issues/199)) ([d9a6e90](https://github.com/dylanneve1/talon/commit/d9a6e90f29762e75600dd9557b234431ab47cbe4))
* **backend:** Kilo 1:1 with Claude SDK + shared framework + backend registry ([#169](https://github.com/dylanneve1/talon/issues/169)) ([9ef3689](https://github.com/dylanneve1/talon/commit/9ef368940589c7f1c45382603ec35e35214d7739))
* **claude-sdk:** add Notification and StopFailure hooks for SDK telemetry ([#128](https://github.com/dylanneve1/talon/issues/128)) ([63c9cb8](https://github.com/dylanneve1/talon/commit/63c9cb8afdd0e90167df0eec9fb0f70e131beb6a))
* **cli:** setup wizard prompts for Discord bot token + applicationId ([#185](https://github.com/dylanneve1/talon/issues/185)) ([ed36c04](https://github.com/dylanneve1/talon/commit/ed36c04aafa6b62b00d26f286ce142f9b2978190))
* **cli:** setup wizard supports backend selection + Discord frontend ([#180](https://github.com/dylanneve1/talon/issues/180)) ([8a9fb78](https://github.com/dylanneve1/talon/commit/8a9fb78623542d94af8f453bce18b457b5dafa6c))
* **codex:** factory cleanup hook + expanded conformance + parity log line ([#177](https://github.com/dylanneve1/talon/issues/177)) ([077cf3b](https://github.com/dylanneve1/talon/commit/077cf3b3cd265ad52cd9f69d0ec53ea8bcb985a6))
* **codex:** friendly startup warning when no auth source available ([#182](https://github.com/dylanneve1/talon/issues/182)) ([5842517](https://github.com/dylanneve1/talon/commit/5842517de2d6d8d647a339d0c564b2701ba2cf7b))
* **codex:** runOneShotAgent + full model registry + 4-way registry parity tests ([#175](https://github.com/dylanneve1/talon/issues/175)) ([44ab734](https://github.com/dylanneve1/talon/commit/44ab73404fe96d817185d0905d411e7b8dc34a59))
* **codex:** set sensible ThreadOptions defaults — sandbox / approval / network ([#183](https://github.com/dylanneve1/talon/issues/183)) ([85e0d8c](https://github.com/dylanneve1/talon/commit/85e0d8c076729863e39102ef6dbccfd31ddc9975))
* **discord:** show backend label in /status header ([#191](https://github.com/dylanneve1/talon/issues/191)) ([d10cbea](https://github.com/dylanneve1/talon/commit/d10cbeacbf83cfebc54b25bd91dad2615ebc4f5b))
* **frontend:** add Discord frontend (discord.js v14) ([#160](https://github.com/dylanneve1/talon/issues/160)) ([625148c](https://github.com/dylanneve1/talon/commit/625148cdcc6bdce683a220f178c530742b9f8984))
* **handlers:** surface user-quoted portions from reply context (Bot API 7.0) ([#157](https://github.com/dylanneve1/talon/issues/157)) ([92210ec](https://github.com/dylanneve1/talon/commit/92210ec4b401edabeed0657a9e6c3a90bd872180))
* **heartbeat:** outbound telegram — explicit chat_id routing ([#150](https://github.com/dylanneve1/talon/issues/150)) ([77e7771](https://github.com/dylanneve1/talon/commit/77e7771dca13e157f73f8c2e6dd4b73705b4f9f6))
* **picker:** backend-agnostic model picker — provider groups, persisted free filter, decoupled /settings ([#207](https://github.com/dylanneve1/talon/issues/207)) ([91df6a9](https://github.com/dylanneve1/talon/commit/91df6a92af4da005d35ffedaab0a584cbe0d7d51))
* **telegram:** show backend label in /status header ([#184](https://github.com/dylanneve1/talon/issues/184)) ([9d18672](https://github.com/dylanneve1/talon/commit/9d186729827a4feef79e96b2a7f44571b635f588))
* **tools:** expose Talon MCP tools to the Discord frontend ([#203](https://github.com/dylanneve1/talon/issues/203)) ([a4a1ae3](https://github.com/dylanneve1/talon/commit/a4a1ae3b192fa016d39fa3cb052335bbd2ca7934))
* **triggers:** add persistent triggers that survive Talon restarts ([#201](https://github.com/dylanneve1/talon/issues/201)) ([40f4dd7](https://github.com/dylanneve1/talon/commit/40f4dd7d7b55993f63f02e81cbee5c0462f3c489))
* **triggers:** self-authored watcher scripts that wake the bot ([#96](https://github.com/dylanneve1/talon/issues/96)) ([cafc8d4](https://github.com/dylanneve1/talon/commit/cafc8d4234218abb1e45621dccd36a0a367b01cc))


### Bug Fixes

* **heartbeat:** evict wedged SDK subprocesses, never deadlock the lock ([#144](https://github.com/dylanneve1/talon/issues/144)) ([d17a4eb](https://github.com/dylanneve1/talon/commit/d17a4ebbcb289fda2617ec84903622cdfbd67815))
* **heartbeat:** frontend-agnostic outbound + comprehensive test coverage ([#151](https://github.com/dylanneve1/talon/issues/151)) ([85251d3](https://github.com/dylanneve1/talon/commit/85251d329b31bcebc172568d39d700cd3d55bf08))
* **kilo:** make the chat flow actually work end-to-end ([#170](https://github.com/dylanneve1/talon/issues/170)) ([8286706](https://github.com/dylanneve1/talon/commit/8286706ac83fa346261d24179b722162a53232ff))
* **openai-agents:** isolate config from generic OPENAI_* env vars ([#206](https://github.com/dylanneve1/talon/issues/206)) ([fc16cb2](https://github.com/dylanneve1/talon/commit/fc16cb2ffba6cdcec51c50625ac309e5d5d6a60b))
* six correctness and safety bugs (timer leak, HTML injection, log component, flush consistency, status regex) ([#156](https://github.com/dylanneve1/talon/issues/156)) ([7530244](https://github.com/dylanneve1/talon/commit/753024462705035f57b15cbe82f1a330284a5026))
* **telegram:** escape backend modelDetails so /model and /settings render ([#164](https://github.com/dylanneve1/talon/issues/164)) ([01f59ed](https://github.com/dylanneve1/talon/commit/01f59edc2535dc5de08e57b2dd2b0ce0edc253c6))
* **tools:** chat_id schema accepts negative IDs for groups/channels ([#153](https://github.com/dylanneve1/talon/issues/153)) ([9298246](https://github.com/dylanneve1/talon/commit/92982468613022e2a040d62d1a69acbb9ff426b6))
* **tools:** mark react as a turn terminator (endsTurn: true) ([#148](https://github.com/dylanneve1/talon/issues/148)) ([afb03ef](https://github.com/dylanneve1/talon/commit/afb03ef962014c6f54a30c5c5b1ea1cc188678da))
* **tools:** preserve Discord snowflake IDs in tool input schemas ([#204](https://github.com/dylanneve1/talon/issues/204)) ([f46efce](https://github.com/dylanneve1/talon/commit/f46efce242ceaf008e069f47c6c088fb9b67058b))

## [1.11.0](https://github.com/dylanneve1/talon/compare/v1.10.1...v1.11.0) (2026-05-11)


### Features

* **access:** capture unauthorized message bodies for forensics ([#135](https://github.com/dylanneve1/talon/issues/135)) ([49e1029](https://github.com/dylanneve1/talon/commit/49e10292b05ee1508a8221ac964662b72f415bb5))


### Bug Fixes

* **deps:** bump fast-uri 3.1.0→3.1.2 (Dependabot alerts [#7](https://github.com/dylanneve1/talon/issues/7) + [#11](https://github.com/dylanneve1/talon/issues/11)) ([#134](https://github.com/dylanneve1/talon/issues/134)) ([0709805](https://github.com/dylanneve1/talon/commit/0709805e7258d0306a061b603192e87ea1c2669b))

## [1.10.1](https://github.com/dylanneve1/talon/compare/v1.10.0...v1.10.1) (2026-05-09)


### Bug Fixes

* **claude-sdk:** terminate SDK loop on end_turn (MCP-prefix match + PostToolBatch hook) ([#122](https://github.com/dylanneve1/talon/issues/122)) ([a92452a](https://github.com/dylanneve1/talon/commit/a92452af146ee7f73d6c8771e6e1509d0c71bf3d))
* **deps:** bump ip-address 10.1.0→10.2.0 to close Dependabot alert [#4](https://github.com/dylanneve1/talon/issues/4) ([#120](https://github.com/dylanneve1/talon/issues/120)) ([31b6f9d](https://github.com/dylanneve1/talon/commit/31b6f9d1761a5d2526c748ed15a17e042e4189c0))

## [1.10.0](https://github.com/dylanneve1/talon/compare/v1.9.2...v1.10.0) (2026-05-08)


### Features

* **messaging:** add end_turn tool + flow enforcement ([#108](https://github.com/dylanneve1/talon/issues/108)) ([6a4f8ac](https://github.com/dylanneve1/talon/commit/6a4f8aca8d7ca8d9528ce04bac38bea94a3080a2))

## [1.9.2](https://github.com/dylanneve1/talon/compare/v1.9.1...v1.9.2) (2026-05-07)


### Bug Fixes

* cache hit % shouldn't include cache writes in denominator ([#107](https://github.com/dylanneve1/talon/issues/107)) ([379eace](https://github.com/dylanneve1/talon/commit/379eace4b823bc824eed3f60242c396c1202752a))
* **deps:** bump @anthropic-ai/sdk 0.86.1→0.95.0 to close Dependabot alert [#3](https://github.com/dylanneve1/talon/issues/3) ([#113](https://github.com/dylanneve1/talon/issues/113)) ([054516b](https://github.com/dylanneve1/talon/commit/054516be39e58fff1bac2ba42d0f2060c16ad06d))
* **docker:** make container actually boot Talon end-to-end ([#106](https://github.com/dylanneve1/talon/issues/106)) ([f44d05c](https://github.com/dylanneve1/talon/commit/f44d05c7d688045a72a26cb68639dc6ff9be44c0))
* **gateway:** don't leak error details on unhandled 500 ([#104](https://github.com/dylanneve1/talon/issues/104)) ([5a359db](https://github.com/dylanneve1/talon/commit/5a359db0ea1d09dee4f9017f2790aecf05f8a508))
* **tools:** coerce stringified numeric IDs in tool input schemas ([#103](https://github.com/dylanneve1/talon/issues/103)) ([bd4b103](https://github.com/dylanneve1/talon/commit/bd4b10324419fcb41d35436a6ce8266523398032))

## [1.9.1](https://github.com/dylanneve1/talon/compare/v1.9.0...v1.9.1) (2026-04-27)


### Bug Fixes

* **tools:** disallow ScheduleWakeup outside /loop mode ([#91](https://github.com/dylanneve1/talon/issues/91)) ([75b15f0](https://github.com/dylanneve1/talon/commit/75b15f0f1530fe3d457fc929317f40b649ef0ed2))

## [1.9.0](https://github.com/dylanneve1/talon/compare/v1.8.1...v1.9.0) (2026-04-21)


### Features

* **mempalace:** support 3.3.x multi-language entity detection ([#72](https://github.com/dylanneve1/talon/issues/72)) ([5da6e02](https://github.com/dylanneve1/talon/commit/5da6e02a500f8ce7fe2266160b4d5d5513f1aae5))


### Bug Fixes

* **robustness:** launcher-wrapped MCP spawns + minimal silence watchdog ([#73](https://github.com/dylanneve1/talon/issues/73)) ([37f41de](https://github.com/dylanneve1/talon/commit/37f41de4b5cd0707122eed5f055e5fa47a2b5bf8))

## [1.8.1](https://github.com/dylanneve1/talon/compare/v1.8.0...v1.8.1) (2026-04-17)


### Bug Fixes

* **security:** address CodeQL HTML sanitization findings ([#63](https://github.com/dylanneve1/talon/issues/63)) ([39ac20b](https://github.com/dylanneve1/talon/commit/39ac20b6f7ce7e33a3cfac75d1ac6cb4db93d680))

## [1.8.0](https://github.com/dylanneve1/talon/compare/v1.7.0...v1.8.0) (2026-04-16)


### Features

* move Claude model logic to backend and remove model tiers ([#54](https://github.com/dylanneve1/talon/issues/54)) ([99d6b73](https://github.com/dylanneve1/talon/commit/99d6b73ba3a44bb6e91008a110bc9c3ec72390fc))
* **opencode:** add model catalog and fix delivery/status flows ([#57](https://github.com/dylanneve1/talon/issues/57)) ([bb9a216](https://github.com/dylanneve1/talon/commit/bb9a216721174e946876a5828a545926573d941e))

## [1.7.0](https://github.com/dylanneve1/talon/compare/v1.6.1...v1.7.0) (2026-04-14)


### Features

* add standalone MCP server plugin support ([#52](https://github.com/dylanneve1/talon/issues/52)) ([bf3cdc3](https://github.com/dylanneve1/talon/commit/bf3cdc30d4d157f51433b70ef0968514dcb90c84))

## [1.6.1](https://github.com/dylanneve1/talon/compare/v1.6.0...v1.6.1) (2026-04-13)


### Bug Fixes

* model switch doubling context usage ([#44](https://github.com/dylanneve1/talon/issues/44)) ([032d8cc](https://github.com/dylanneve1/talon/commit/032d8cce53be3cd626559348862b2fdc1ffe86d9))

## [1.6.0](https://github.com/dylanneve1/talon/compare/v1.5.0...v1.6.0) (2026-04-13)


### Features

* add model registry middleware and dynamic model pickers ([#42](https://github.com/dylanneve1/talon/issues/42)) ([6e68b6f](https://github.com/dylanneve1/talon/commit/6e68b6f957dd2c3c24c9a16ff1137aa2ff8962c4))

## [1.5.0](https://github.com/dylanneve1/talon/compare/v1.4.0...v1.5.0) (2026-04-12)


### Features

* add reload_plugins tool for hot-reloading MCP plugins ([#37](https://github.com/dylanneve1/talon/issues/37)) ([ca72c4e](https://github.com/dylanneve1/talon/commit/ca72c4e50507589daf30ad9ade50700487f6586a))
* give heartbeat access to all MCP plugins ([#33](https://github.com/dylanneve1/talon/issues/33)) ([d148b90](https://github.com/dylanneve1/talon/commit/d148b909021fafadb023b87f9b259bd214dbe7c9))
* warm-start sessions on /reset for immediate /status context data ([6956e41](https://github.com/dylanneve1/talon/commit/6956e41599bede2242e6c91ed28b2b688dddfab6))


### Bug Fixes

* /status context bar — use SDK [1m] model suffix for correct context window ([ffa0b61](https://github.com/dylanneve1/talon/commit/ffa0b61fa44b7a0cb53d87a562fba894e5cdf27a))
* await warmSession on /reset so context data is ready for /status ([3ef6c60](https://github.com/dylanneve1/talon/commit/3ef6c60d55e7f2562f58f10bf5a2582f28ab0300))
* drain SDK stream during warm-up so control requests don't stall ([d46ef0d](https://github.com/dylanneve1/talon/commit/d46ef0d40fc8d9a14abfe179babb65577331306d))
* regenerate lockfile with npm 10 for CI Node 22 compat ([0ff5eb7](https://github.com/dylanneve1/talon/commit/0ff5eb783c9499145db4f47af68eb436adfb0534))

## [1.4.0](https://github.com/dylanneve1/talon/compare/v1.3.0...v1.4.0) (2026-04-10)


### Features

* replace custom web search with Brave Search MCP server ([#30](https://github.com/dylanneve1/talon/issues/30)) ([eeb9cf2](https://github.com/dylanneve1/talon/commit/eeb9cf20b885a717baf875bb6a9b933099a57706))

## [1.3.0](https://github.com/dylanneve1/talon/compare/v1.2.0...v1.3.0) (2026-04-10)


### Features

* integrate mempalace for long-term memory ([#27](https://github.com/dylanneve1/talon/issues/27)) ([d68a3f2](https://github.com/dylanneve1/talon/commit/d68a3f22b9076dadf9f35617defa901e7949e2ec))


### Bug Fixes

* **ci:** fix coverage validation, concurrency, format error handling ([d3a75af](https://github.com/dylanneve1/talon/commit/d3a75af90abede3eea5160884c9c8a0ce0d4e821))
* patch SDK vulnerability, optimize CI, remove stryker ([833c791](https://github.com/dylanneve1/talon/commit/833c79190a8d147ca995048a39797889e6b6b1c6))

## [1.2.0](https://github.com/dylanneve1/talon/compare/v1.1.0...v1.2.0) (2026-04-09)


### Features

* **ci:** add mutation testing, coverage thresholds, and optimize pipeline ([32b446a](https://github.com/dylanneve1/talon/commit/32b446a80a286947fbb338744f046141877c5abd))


### Bug Fixes

* **ci:** add manual trigger to release-please workflow ([c081d7f](https://github.com/dylanneve1/talon/commit/c081d7fb61b7e111295be33d9cd750e6a6330cd4))
* **ci:** remove mutation testing job (too slow for CI) ([1573943](https://github.com/dylanneve1/talon/commit/1573943cc120ed9e550ba9d7291a417a6c237e69))
* **ci:** restore PAT for release-please with updated token ([c602ede](https://github.com/dylanneve1/talon/commit/c602ede3c8e5ad5f0563e17ec29c35a42aed656f))
* **ci:** track lockfile, add CodeQL, fix healthcheck, add smoke test ([ea32b5b](https://github.com/dylanneve1/talon/commit/ea32b5bb08664fe4a4a28f50e451b9bfb4c6e053))
* **ci:** use GITHUB_TOKEN for release-please ([9ec44c5](https://github.com/dylanneve1/talon/commit/9ec44c594c285adf030d049c0ccc5d82984d2cdc))
* **ci:** use PAT for release-please to trigger CI on PRs ([bec8e24](https://github.com/dylanneve1/talon/commit/bec8e24dbbb904761d53c1037cadc549ce28e45a))
