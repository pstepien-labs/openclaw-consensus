# Commands

## Runtime commands that exist now

### Show help
```bash
node src/cli.mjs help
```

### List configured API-backed models from the active OpenClaw workspace config
```bash
node src/cli.mjs models
```

### Run one 2-round consensus flow
```bash
node src/cli.mjs run \
  --brief "<brief>" \
  --models "openai-codex/gpt-5.4,openai-codex/gpt-5.5" \
  --orchestrator-model "openai-codex/gpt-5.4" \
  --label "optional-label"
```

### Run from a brief file
```bash
node src/cli.mjs run \
  --brief-file ./path/to/brief.md \
  --models "openai-codex/gpt-5.4,openai-codex/gpt-5.5"
```

## Local skill lifecycle commands

### Install the repo as a workspace skill
```bash
./scripts/install-skill.sh
```

### Uninstall the workspace skill link
```bash
./scripts/uninstall-skill.sh
```

### Verify the skill is visible to OpenClaw
```bash
openclaw skills info openclaw-consensus
```

## Validation commands used in this repo

### Happy-path validation
```bash
node src/cli.mjs run \
  --brief-file validation/2026-04-29/brief-happy-path.md \
  --models "openai-codex/gpt-5.4,openai-codex/gpt-5.5" \
  --orchestrator-model "openai-codex/gpt-5.4" \
  --label "validation-happy-path"
```

### Failure-path validation
```bash
node src/cli.mjs run \
  --brief-file validation/2026-04-29/brief-failure-path.md \
  --models "openai-codex/gpt-5.4,anthropic/claude-sonnet-4-6" \
  --orchestrator-model "openai-codex/gpt-5.4" \
  --label "validation-fallback-failure"
```

## Important command-surface rules
- The MVP requires an explicit model shortlist.
- The repo rejects `ollama/*` models.
- The repo rejects configured-model fallback: if OpenClaw runs a different model than requested, the run fails and preserves artifacts.
- `run.json` records whether the orchestrator model was explicit or defaulted from the workspace agent primary model.
- `run` rejects unknown flags (e.g. typos like `--orchestator-model`) instead of silently ignoring them.
- `run` accepts `--model-timeout-ms <ms>` to bound each model call (default 5 minutes).
- `run` rejects `--run-root` paths inside common system directories or pointing at non-empty directories.

## Helper self-checks
```bash
node validation/tests/cli-helpers.test.mjs
```
