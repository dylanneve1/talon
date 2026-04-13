# Changelog

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
