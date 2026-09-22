# Changelog

## Unreleased

- Kimi Code CLI 0.38+ compatibility: only pass `--quiet` and `--thinking` when `kimi --help` lists them. If the CLI rejects a flag with a usage error (`unknown option`, or `Cannot combine --prompt with --yolo`), retry without it instead of failing the job about a second after launch. Note that on these CLI versions rescue and review runs then use Kimi's default approval mode, not `--yolo`.
- CLI contract: `info`, `--quiet` and `--thinking` are now optional. Their absence is reported but no longer fails the check.

## 1.0.1

- Added a test suite covering the shared library and runtime integration (fake Kimi CLI).
- Added a version-bump script.
- Added a Kimi CLI version-compatibility check with CI.
- Relicensed under the MIT License, retaining upstream Apache-2.0 attribution for codex-plugin-cc (see NOTICE / LICENSE-APACHE).

## 1.0.0

- Initial version of the Kimi plugin for Claude Code
