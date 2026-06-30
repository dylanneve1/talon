# Changelog

## [1.24.2](https://github.com/dylanneve1/talon/compare/v1.24.1...v1.24.2) (2026-06-30)


### Bug Fixes

* **ci:** broken YAML in companion-scaffold.yml blocked workflow_dispatch ([#407](https://github.com/dylanneve1/talon/issues/407)) ([423e45f](https://github.com/dylanneve1/talon/commit/423e45fa3a4b4f04aa62d462391be7973ca39e43))

## [1.24.1](https://github.com/dylanneve1/talon/compare/v1.24.0...v1.24.1) (2026-06-30)


### Bug Fixes

* **companion:** Windows build, source-build auto-start, UI fixes + npuw plugin ([#397](https://github.com/dylanneve1/talon/issues/397)) ([1977720](https://github.com/dylanneve1/talon/commit/1977720f60d560f28ee5919e628802a637038714))

## [1.24.0](https://github.com/dylanneve1/talon/compare/v1.23.0...v1.24.0) (2026-06-30)


### Features

* **dist:** self-contained standalone binary + multi-platform release ([#358](https://github.com/dylanneve1/talon/issues/358)) ([9d2789f](https://github.com/dylanneve1/talon/commit/9d2789fb301a937d05eddcdcaab0906d5581abe7))
* run multiple frontends concurrently + rename desktop frontend to native ([#396](https://github.com/dylanneve1/talon/issues/396)) ([7d9676a](https://github.com/dylanneve1/talon/commit/7d9676ae020b48f2f3d28ca7c7bd2cba3cb56b6b))

## [1.23.0](https://github.com/dylanneve1/talon/compare/v1.22.0...v1.23.0) (2026-06-30)


### Features

* **companion:** harden bridge pairing, add functional tests + CI + instrumentation ([#394](https://github.com/dylanneve1/talon/issues/394)) ([cd07a26](https://github.com/dylanneve1/talon/commit/cd07a2685be0a5307758b19a11bd100739d8495d))

## [1.22.0](https://github.com/dylanneve1/talon/compare/v1.21.1...v1.22.0) (2026-06-29)


### Features

* **desktop:** client-bridge frontend + Flutter companion app ([#389](https://github.com/dylanneve1/talon/issues/389)) ([44bcb73](https://github.com/dylanneve1/talon/commit/44bcb7312eebcf9cebe4db14fdd73a84ad80ca80))
* **weaver:** unified thread/chat manager (scaffold + dispatcher rewire) ([#388](https://github.com/dylanneve1/talon/issues/388)) ([2e6b5ae](https://github.com/dylanneve1/talon/commit/2e6b5ae785fd3130bfe5ead23a29af439cafc9f5))

## [1.21.1](https://github.com/dylanneve1/talon/compare/v1.21.0...v1.21.1) (2026-06-29)


### Bug Fixes

* **update:** /update force-syncs to remote instead of failing on a dirty tree ([#386](https://github.com/dylanneve1/talon/issues/386)) ([d7a4757](https://github.com/dylanneve1/talon/commit/d7a4757f74c3d8a987d3af614985859fbd2716e8))

## [1.21.0](https://github.com/dylanneve1/talon/compare/v1.20.0...v1.21.0) (2026-06-28)


### Features

* **scheduler:** native catch-up + interval/one-shot/bounded cron jobs ([#356](https://github.com/dylanneve1/talon/issues/356)) ([f660055](https://github.com/dylanneve1/talon/commit/f6600553c7a0d9e59f0d4cea274a6994e986844e))

## [1.20.0](https://github.com/dylanneve1/talon/compare/v1.19.0...v1.20.0) (2026-06-28)


### Features

* **cron:** isolated one-shot cron query jobs + backend-capability guards ([#361](https://github.com/dylanneve1/talon/issues/361)) ([7064734](https://github.com/dylanneve1/talon/commit/706473461ee26061064e2314ec7564efe065161e))
* **models:** list_models reads any registered backend, not just active ones ([#360](https://github.com/dylanneve1/talon/issues/360)) ([b2a9fd1](https://github.com/dylanneve1/talon/commit/b2a9fd16361a450be68e07640ac4950243ee6a41))


### Bug Fixes

* **ci:** merge-queue updates branches via PAT push so CI actually fires ([#384](https://github.com/dylanneve1/talon/issues/384)) ([5f3fc07](https://github.com/dylanneve1/talon/commit/5f3fc070505b9d513feee198bc49c75ed8ca6d50))
* **claude-sdk:** wait for MCP servers to connect after refreshTools ([#380](https://github.com/dylanneve1/talon/issues/380)) ([8d07a9d](https://github.com/dylanneve1/talon/commit/8d07a9d62c55ed56c529f7aa471bac04094df190))
* **mcp:** resolve tsx to an absolute path in the supervisor re-invocation ([c804fa5](https://github.com/dylanneve1/talon/commit/c804fa5ec50990eb446713db3b566e90fde9e40a))
* **mcp:** resolve tsx to an absolute path in the supervisor re-invocation ([922d357](https://github.com/dylanneve1/talon/commit/922d357a3ae3c40afdf89181b05f1d053f1b61ee))
* stop double startup on port retry and end_turn nag in terminal mode ([#381](https://github.com/dylanneve1/talon/issues/381)) ([b5353a2](https://github.com/dylanneve1/talon/commit/b5353a26f7e05c63c952ea387532b4b9957a7e44))
* **tools:** make Discord snowflake IDs string-typed (coerce numbers to string) ([ff254b8](https://github.com/dylanneve1/talon/commit/ff254b88f10f2927866a91080a96106a618fa873))

## [1.19.0](https://github.com/dylanneve1/talon/compare/v1.18.0...v1.19.0) (2026-06-17)


### Features

* **commands:** add /update self-update command for dev git checkouts ([#345](https://github.com/dylanneve1/talon/issues/345)) ([343a69f](https://github.com/dylanneve1/talon/commit/343a69f384cd975be0f1a0262642a2e3afef01d3))
* **jobs:** per-trigger/per-cron custom model (same backend) + model discovery tools ([#355](https://github.com/dylanneve1/talon/issues/355)) ([c3b887f](https://github.com/dylanneve1/talon/commit/c3b887fcdece00f2b68efdd22b51c30a4a5df812))
* **soul:** live signal taps — reactions, directives, corrections ([#353](https://github.com/dylanneve1/talon/issues/353)) ([78ec9bf](https://github.com/dylanneve1/talon/commit/78ec9bf344753d361d6ec1390c97fd4d827992be))
* **soul:** the Soul Kernel — a model-free, self-organizing identity substrate ([#349](https://github.com/dylanneve1/talon/issues/349)) ([fa503c4](https://github.com/dylanneve1/talon/commit/fa503c40ce2b305d19ac0783440ea8c72bad1450))
* **soul:** wire the Soul Kernel into the runtime (gated, off by default) ([#350](https://github.com/dylanneve1/talon/issues/350)) ([71fc3ea](https://github.com/dylanneve1/talon/commit/71fc3ea4cac0089b4eae518c26aa7cfcb77e916f))
* **warden:** supervise trigger trees on Windows via Job Objects ([#348](https://github.com/dylanneve1/talon/issues/348)) ([dbf8852](https://github.com/dylanneve1/talon/commit/dbf8852d38195592f390f4606e7e3e93636a14f3))


### Bug Fixes

* **mcp:** stop double-wrapping plugin MCP servers ([#337](https://github.com/dylanneve1/talon/issues/337)) ([cceee54](https://github.com/dylanneve1/talon/commit/cceee54f512f762afd48c7603e0b232d58f2c03e))

## [1.18.0](https://github.com/dylanneve1/talon/compare/v1.17.0...v1.18.0) (2026-06-14)


### Features

* **native:** blake3-napi — in-process napi-rs addon for media hashing ([#328](https://github.com/dylanneve1/talon/issues/328)) ([ba22e94](https://github.com/dylanneve1/talon/commit/ba22e94fda9dd6b72ba824971b6b8475310daf2a))
* **native:** talon-warden — Rust supervision harness for trigger children ([#326](https://github.com/dylanneve1/talon/issues/326)) ([91cd62f](https://github.com/dylanneve1/talon/commit/91cd62f6957022a377d60f0d33b8840e413f58ab))
* **skills:** SKILL.md skill bundles + rename executable skills→scripts ([#333](https://github.com/dylanneve1/talon/issues/333)) ([9847322](https://github.com/dylanneve1/talon/commit/98473222a88d1d31723b32757b371a53386cc404))
* **stats:** real-time stats for all backends + robust failed-turn accounting ([#327](https://github.com/dylanneve1/talon/issues/327)) ([7796983](https://github.com/dylanneve1/talon/commit/7796983c0593146f0f046f12fd0fffac8723f138))


### Bug Fixes

* **claude-sdk:** always-load frontend tool servers (no defer) ([#329](https://github.com/dylanneve1/talon/issues/329)) ([c4a52e2](https://github.com/dylanneve1/talon/commit/c4a52e287c92f1fb3cefff1b8c9827b6b3f4ffce))
* **codex:** record token usage when terminator aborts before turn.completed ([#324](https://github.com/dylanneve1/talon/issues/324)) ([edc2e1e](https://github.com/dylanneve1/talon/commit/edc2e1e6ede0e072557a2da83d5372c25213cd06))
* stderr readline crash risk and cron non-null assertion ([#335](https://github.com/dylanneve1/talon/issues/335)) ([d5ea5ab](https://github.com/dylanneve1/talon/commit/d5ea5abb3b206359a208f7db14cb1b13446062c5))

## [1.17.0](https://github.com/dylanneve1/talon/compare/v1.16.0...v1.17.0) (2026-06-12)


### Features

* **agency:** persistent goals, goal-driven heartbeat, adaptive effort routing ([#315](https://github.com/dylanneve1/talon/issues/315)) ([fba8f1c](https://github.com/dylanneve1/talon/commit/fba8f1c9b97af6784b277364c7030d7224e73f69))
* **behaviour:** promise-backing rule, heartbeat on by default, encourage proactive outreach ([#318](https://github.com/dylanneve1/talon/issues/318)) ([68d5c72](https://github.com/dylanneve1/talon/commit/68d5c7234510ccaf73f29bf268a0042514c12df4))
* **metrics:** aggregate token + cache usage in unified turn metrics ([#303](https://github.com/dylanneve1/talon/issues/303)) ([ca6f845](https://github.com/dylanneve1/talon/commit/ca6f8455e2362a5daa29e437b37ea68a2b38f2d4))
* **native:** C + C++ modules, shared wasm runtime, native registry ([#319](https://github.com/dylanneve1/talon/issues/319)) ([b84916b](https://github.com/dylanneve1/talon/commit/b84916bea53a3bf32ed94ed4b94594ec6e6ca57d))
* **native:** C sqlguard module — SQL LIKE / FTS5 escaping for model-controlled input ([#323](https://github.com/dylanneve1/talon/issues/323)) ([8201b82](https://github.com/dylanneve1/talon/commit/8201b820361e56428c710f21318bdbabffa462fd))
* **native:** Gleam scheduler decision core — typed policy functions compiled to JS ([#307](https://github.com/dylanneve1/talon/issues/307)) ([e1c4acc](https://github.com/dylanneve1/talon/commit/e1c4accfdcf3625eb57272436fce9cac1b2e08d5))
* **native:** Rust→WASM BLAKE3 hashing module — first brick of the data/indexing plane ([#308](https://github.com/dylanneve1/talon/issues/308)) ([300b869](https://github.com/dylanneve1/talon/commit/300b869bee683a2be0e6513ad9c9d0d7c67aec41))
* **native:** talon-driver — native launcher binary for apt/brew/source ([#322](https://github.com/dylanneve1/talon/issues/322)) ([8d12538](https://github.com/dylanneve1/talon/commit/8d1253857f499a58ed606f9211a692d17b69e802))
* **native:** Zig→WASM message-splitting core; pipe blake3 + Gleam scheduler into runtime ([#312](https://github.com/dylanneve1/talon/issues/312)) ([51005b8](https://github.com/dylanneve1/talon/commit/51005b843f9a8cd36808f8419133375782534fa1))
* **storage:** migrate sessions, chat-settings, media-index to SQLite ([#306](https://github.com/dylanneve1/talon/issues/306)) ([066a0b5](https://github.com/dylanneve1/talon/commit/066a0b54d6d973b5f1ee3304949c00bfcf068075))
* **storage:** SQLite data layer — FTS5 chat history, repository pattern, Node 24 ([#305](https://github.com/dylanneve1/talon/issues/305)) ([27cce68](https://github.com/dylanneve1/talon/commit/27cce68ad423580a52c84ec31c19944eeb56d7e6))
* streaming BLAKE3 + due-driven heartbeat; Node-24 packaging alignment; auto release-please ([#313](https://github.com/dylanneve1/talon/issues/313)) ([3cdb9fd](https://github.com/dylanneve1/talon/commit/3cdb9fdba8b12b1c115a18734d9bac7fa78761f8))
* **telegram:** /doctor command — shared doctor core with native-module report ([#317](https://github.com/dylanneve1/talon/issues/317)) ([97f62e4](https://github.com/dylanneve1/talon/commit/97f62e491b6c65a4ee7d423f478a2fece1643ee8))
* **triggers:** Lua scripting language — WASM-sandboxed via wasmoon ([#309](https://github.com/dylanneve1/talon/issues/309)) ([12fd90f](https://github.com/dylanneve1/talon/commit/12fd90f54dff90ae2a6a9fa5c92fbb1170a51c20))


### Bug Fixes

* **daemon:** prevent duplicate daemons after /restart ([#301](https://github.com/dylanneve1/talon/issues/301)) ([aeba50f](https://github.com/dylanneve1/talon/commit/aeba50f19542187bdf5419099e5aea1006eb633e))
* four correctness bugs — infinite retry loop, FTS corruption, LIKE injection, nested transaction crash ([#310](https://github.com/dylanneve1/talon/issues/310)) ([4cd2a01](https://github.com/dylanneve1/talon/commit/4cd2a01fc9dcf9f3cb5567285a8cec3770981220))
* **metrics:** unify codex tool names, count failed MCP calls, fix count-histogram rendering ([#298](https://github.com/dylanneve1/talon/issues/298)) ([be22f3f](https://github.com/dylanneve1/talon/commit/be22f3f1399345bf9c9f8c49080cb7edd9023c08))

## [1.16.0](https://github.com/dylanneve1/talon/compare/v1.15.1...v1.16.0) (2026-06-11)


### Features

* **agent-runtime:** finish architecture unification plan (Phases 3-7) ([#258](https://github.com/dylanneve1/talon/issues/258)) ([d30d596](https://github.com/dylanneve1/talon/commit/d30d5965eeaf7942957e84ecce3e856afc958526))
* pipe codex api call metrics ([#283](https://github.com/dylanneve1/talon/issues/283)) ([31084c5](https://github.com/dylanneve1/talon/commit/31084c5b1c50215a8d18da57e6cbcdb37d80ef76))


### Bug Fixes

* **claude-sdk:** detect Fable and show both 1M/non-1M variants ([#290](https://github.com/dylanneve1/talon/issues/290)) ([bc8ae9e](https://github.com/dylanneve1/talon/commit/bc8ae9e42c31bca711d8d7658d32b24666e0dadb))
* let Codex retry oversized text-block delivery ([#285](https://github.com/dylanneve1/talon/issues/285)) ([eb95900](https://github.com/dylanneve1/talon/commit/eb959001d7564093a94d835bd9ce2ea203a1d56d))
* recover from codex text-block delivery failures ([#284](https://github.com/dylanneve1/talon/issues/284)) ([ee3b95c](https://github.com/dylanneve1/talon/commit/ee3b95ccb688731f5fcf141dea29f6c510dfc8f4))


### Performance Improvements

* prompt-cache-friendly system prompt (boundary split + per-session freeze) ([#292](https://github.com/dylanneve1/talon/issues/292)) ([60b8bc7](https://github.com/dylanneve1/talon/commit/60b8bc738c7d79090c8bf781ef028de01b8626bb))
* stop statting every workspace file to render the prompt listing ([#293](https://github.com/dylanneve1/talon/issues/293)) ([829ce5f](https://github.com/dylanneve1/talon/commit/829ce5fe8bcba8e90bb7517c6d760b68b0509728))

## [1.15.1](https://github.com/dylanneve1/talon/compare/v1.15.0...v1.15.1) (2026-06-07)


### Bug Fixes

* 19 correctness bugs from deep codebase review ([#268](https://github.com/dylanneve1/talon/issues/268)) ([5686c26](https://github.com/dylanneve1/talon/commit/5686c261c82d881a9df16a4af53e83e5bf9b508e))
* **agent-runtime:** correct three bugs in adapter and legacy-bridge ([#263](https://github.com/dylanneve1/talon/issues/263)) ([c812129](https://github.com/dylanneve1/talon/commit/c8121294494671aa6fb2a4146979fdeb308c8402))
* flag intervening group context before vague replies ([#251](https://github.com/dylanneve1/talon/issues/251)) ([b2a4bcd](https://github.com/dylanneve1/talon/commit/b2a4bcd24a50e85e787079609135a8c734e15f9a))
* four correctness bugs found during deep code review ([#270](https://github.com/dylanneve1/talon/issues/270)) ([5bd97c4](https://github.com/dylanneve1/talon/commit/5bd97c4239f28c7e09b2e9fff757d40fc73af1f6))
* thread fallback model through params instead of setChatModel ([#265](https://github.com/dylanneve1/talon/issues/265)) ([9deda78](https://github.com/dylanneve1/talon/commit/9deda7836242df88a0643f98c38a39bba3bfce50))

## [1.15.0](https://github.com/dylanneve1/talon/compare/v1.14.0...v1.15.0) (2026-06-06)


### Features

* **agent-runtime:** consume ModelRef + Phase 3/5/6/7 prep infra ([#255](https://github.com/dylanneve1/talon/issues/255)) ([4f614b8](https://github.com/dylanneve1/talon/commit/4f614b86c1cab18ef33f24a77abd8697cd9ce863))
* **core:** agent-runtime types — Phase 1 of architecture unification ([#253](https://github.com/dylanneve1/talon/issues/253)) ([b7b7649](https://github.com/dylanneve1/talon/commit/b7b764978e5b124b564ab8ce54455e5ec1d9e854))
* **core:** resolveActiveModelRefForChat — Phase 2.1 (stacked on [#253](https://github.com/dylanneve1/talon/issues/253)) ([#254](https://github.com/dylanneve1/talon/issues/254)) ([373cecd](https://github.com/dylanneve1/talon/commit/373cecde6fcc1c287a4f3a6964c970e0878a7dcf))


### Bug Fixes

* **callbacks:** swallow expired-callback errors from answerCallbackQuery ([#256](https://github.com/dylanneve1/talon/issues/256)) ([f4a1e2d](https://github.com/dylanneve1/talon/commit/f4a1e2dd03a6ab485f0f512632c5b7175a2dc876))
* consolidate open correctness fixes ([#246](https://github.com/dylanneve1/talon/issues/246)) ([e1b95ad](https://github.com/dylanneve1/talon/commit/e1b95ad1303b238f2451a2bb009133bb422cc84d))
* pass resolved chat model into backends ([#248](https://github.com/dylanneve1/talon/issues/248)) ([1b5cb97](https://github.com/dylanneve1/talon/commit/1b5cb97997e8f969b1687eb2a150af133af74adc))
* register per-model reasoning levels ([#247](https://github.com/dylanneve1/talon/issues/247)) ([88fc5e4](https://github.com/dylanneve1/talon/commit/88fc5e4ad317acda5d927f4746879827c1c36614))

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
