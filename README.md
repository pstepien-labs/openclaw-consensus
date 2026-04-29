# OpenClaw Consensus

Focused OpenClaw-native skill and repo-local CLI for fixed 2-round cross-model deliberation.

## What it does
OpenClaw Consensus runs one brief through 2-4 explicitly selected API-backed models from the active OpenClaw-configured pool, gives them one shared reconciliation round, and then writes a final synthesis covering consensus, disagreements, uncertainty, and narrow escalation points.

## Locked MVP rules
- exactly 2 rounds
- generic workflow only
- explicit model shortlist required
- selected models must come from the active OpenClaw-configured pool
- no `ollama/*` routing in this MVP
- orchestrator model should be the current OpenClaw session model
- no expert-replacement framing

## Repo shape
- `SKILL.md` — local OpenClaw skill instructions
- `src/cli.mjs` — repo-local runtime and CLI
- `scripts/install-skill.sh` — dev install via workspace copy
- `scripts/uninstall-skill.sh` — dev uninstall flow
- `docs/` — product/runtime/prompt/artifact contracts
- `tasks/` — execution artifacts and validation history
- `validation/` — captured proof from install/run/failure checks

## Quick start
### 1. Install the local skill into this workspace
```bash
./scripts/install-skill.sh
openclaw skills info openclaw-consensus
```

### 2. Inspect the configured API-backed model pool
```bash
node src/cli.mjs models
```

### 3. Run one consensus pass
```bash
node src/cli.mjs run \
  --brief "Compare the tradeoffs of postponing a database migration by one quarter versus doing it now." \
  --models "openai-codex/gpt-5.4,openai-codex/gpt-5.5" \
  --orchestrator-model "openai-codex/gpt-5.4" \
  --label "migration-tradeoff"
```

### 4. Inspect artifacts
```text
runs/<timestamp>-<slug>/
├── brief.md
├── run.json
├── round-1/
├── round-2/
└── final.md
```

### 5. Remove the local skill link when finished
```bash
./scripts/uninstall-skill.sh
```

## Current validation status
This repo now includes captured proof for:
- local install
- local uninstall + reinstall
- model-pool inspection
- one end-to-end happy-path run
- one failure-path run that rejects provider fallback
- tracked-file safety check

See `validation/2026-04-29/` for the recorded outputs.

## Notes on orchestration model
The repo contract says the orchestrator should use the current OpenClaw session model. When the skill is used from chat, the agent should pass that model explicitly to the CLI. For standalone shell use, the CLI falls back to the workspace agent primary model if `--orchestrator-model` is omitted, and records that source in `run.json`.

## Status
This is a real local skill + runtime MVP with validation evidence. It is still intentionally narrow:
- no domain presets
- no web UI
- no local-model routing
- no extra rounds
- no claim that agreement replaces expert judgment
