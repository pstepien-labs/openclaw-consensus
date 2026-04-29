#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DEFAULT_RUNS_DIR = path.join(REPO_ROOT, 'runs');

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'help';
  const args = command === argv[0] ? argv.slice(1) : argv;

  try {
    switch (command) {
      case 'help':
      case '--help':
      case '-h':
        printHelp();
        return;
      case 'models':
        handleModels(args);
        return;
      case 'run':
        handleRun(args);
        return;
      default:
        fail(`Unknown command: ${command}`);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}

function printHelp() {
  console.log(`openclaw-consensus

Usage:
  node src/cli.mjs models
  node src/cli.mjs run --brief "..." --models model-a,model-b [options]

Commands:
  models                    List configured API-backed models from the active OpenClaw agent config.
  run                       Execute one fixed 2-round deliberation run.

Run options:
  --brief <text>            Brief text to deliberate on.
  --brief-file <path>       Read the brief from a file.
  --models <csv>            Comma-separated model list. Required in MVP.
  --label <text>            Optional human-friendly label.
  --run-root <path>         Optional explicit run directory.
  --orchestrator-model <provider/model>
                            Optional synthesis model. Defaults to the workspace agent primary model.

Notes:
  - The MVP rejects missing model selection and non-configured models.
  - Only API-backed models are accepted; ollama/* is rejected in this repo's MVP.
  - A model call fails if OpenClaw falls back to a different model/provider.`);
}

function handleModels(args) {
  const options = parseFlags(args);
  const config = getAgentConfig();
  const models = getConfiguredApiModels(config);
  const primary = config?.defaults?.model?.primary ?? null;

  if (options.json) {
    console.log(JSON.stringify({ primary, models }, null, 2));
    return;
  }

  console.log('Configured API-backed models:');
  for (const model of models) {
    console.log(`${model === primary ? '* ' : '  '}${model}`);
  }
  if (primary) {
    console.log(`\n* primary workspace agent model: ${primary}`);
  }
}

function handleRun(args) {
  const options = parseFlags(args);
  const brief = loadBrief(options);
  const config = getAgentConfig();
  const configuredModels = getConfiguredApiModels(config);
  const selectedModels = normalizeSelectedModels(options.models);
  const orchestratorModel = options['orchestrator-model'] || config?.defaults?.model?.primary;
  const orchestratorSource = options['orchestrator-model'] ? 'explicit' : 'agent-default-primary';

  if (!brief) {
    throw new Error('Missing required brief. Use --brief or --brief-file.');
  }
  if (selectedModels.length === 0) {
    throw new Error('Missing required model shortlist. Use --models model-a,model-b.');
  }
  if (selectedModels.length < 2) {
    throw new Error('At least 2 explicit models are required for the MVP.');
  }
  if (selectedModels.length > 4) {
    throw new Error('The MVP supports at most 4 explicit models per run.');
  }
  const invalid = selectedModels.filter((model) => !configuredModels.includes(model));
  if (invalid.length) {
    throw new Error(`Selected model(s) are not configured API-backed models in this OpenClaw workspace: ${invalid.join(', ')}`);
  }
  if (!orchestratorModel) {
    throw new Error('Could not determine an orchestrator model. Pass --orchestrator-model explicitly.');
  }
  if (!configuredModels.includes(orchestratorModel)) {
    throw new Error(`Orchestrator model is not configured as an API-backed model in this workspace: ${orchestratorModel}`);
  }

  const runDir = resolveRunDir(options['run-root'], options.label, brief);
  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(path.join(runDir, 'round-1'), { recursive: true });
  fs.mkdirSync(path.join(runDir, 'round-2'), { recursive: true });

  const runMeta = {
    run_id: path.basename(runDir),
    label: options.label ?? null,
    created_at: new Date().toISOString(),
    brief_path: 'brief.md',
    selected_models: selectedModels,
    orchestrator_model: orchestratorModel,
    orchestrator_model_source: orchestratorSource,
    round_count: 2,
    status: 'running',
    stop_reason: null,
    artifacts: {
      round_1_dir: 'round-1',
      round_2_dir: 'round-2',
      final: 'final.md'
    }
  };

  try {
    writeBrief(runDir, brief, options.label);
    writeJson(path.join(runDir, 'run.json'), runMeta);

    const round1Prompt = buildRound1Prompt(brief);
    const round1Outputs = {};
    for (const model of selectedModels) {
      const response = runModel({ model, prompt: round1Prompt, phase: 'round-1' });
      round1Outputs[model] = response;
      fs.writeFileSync(path.join(runDir, 'round-1', `${safeModelName(model)}.md`), renderModelArtifact(model, response.text));
    }

    const round2Prompt = buildRound2Prompt(brief, round1Outputs);
    const round2Outputs = {};
    for (const model of selectedModels) {
      const response = runModel({ model, prompt: round2Prompt, phase: 'round-2' });
      round2Outputs[model] = response;
      fs.writeFileSync(path.join(runDir, 'round-2', `${safeModelName(model)}.md`), renderModelArtifact(model, response.text));
    }

    const finalPrompt = buildFinalPrompt(brief, selectedModels, round1Outputs, round2Outputs);
    const finalResponse = runModel({ model: orchestratorModel, prompt: finalPrompt, phase: 'final-synthesis', allowSameModelAsFallback: false });
    fs.writeFileSync(path.join(runDir, 'final.md'), ensureTrailingNewline(finalResponse.text));

    runMeta.status = 'completed';
    runMeta.stop_reason = 'STOP_AT_ROUND_2';
    runMeta.completed_at = new Date().toISOString();
    writeJson(path.join(runDir, 'run.json'), runMeta);

    console.log(JSON.stringify({ ok: true, run_dir: runDir, run_id: runMeta.run_id }, null, 2));
  } catch (error) {
    runMeta.status = 'failed';
    runMeta.stop_reason = 'ERROR';
    runMeta.failed_at = new Date().toISOString();
    runMeta.error = error instanceof Error ? error.message : String(error);
    writeJson(path.join(runDir, 'run.json'), runMeta);
    throw error;
  }
}

function parseFlags(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (!token.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }
    const key = token.slice(2);
    if (key === 'json') {
      options.json = true;
      continue;
    }
    const value = args[i + 1];
    if (value == null || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    i += 1;
  }
  return options;
}

function loadBrief(options) {
  if (options.brief) {
    return options.brief.trim();
  }
  if (options['brief-file']) {
    return fs.readFileSync(path.resolve(options['brief-file']), 'utf8').trim();
  }
  return '';
}

function normalizeSelectedModels(value) {
  if (!value) return [];
  return [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
}

function getAgentConfig() {
  const result = runCommand(['config', 'get', 'agents'], { allowFailure: false });
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse 'openclaw config get agents' output as JSON.\n${result.stdout}`);
  }
}

function getConfiguredApiModels(config) {
  const models = Object.keys(config?.defaults?.models ?? {});
  return models.filter((model) => !model.startsWith('ollama/')).sort();
}

function resolveRunDir(explicitRunRoot, label, brief) {
  if (explicitRunRoot) {
    return path.resolve(explicitRunRoot);
  }
  const stamp = new Date().toISOString().replace(/[:]/g, '-').replace(/\.\d{3}Z$/, 'Z');
  const slug = slugify(label || brief.slice(0, 60) || 'run');
  return path.join(DEFAULT_RUNS_DIR, `${stamp}-${slug}`);
}

function writeBrief(runDir, brief, label) {
  const lines = ['# Brief', ''];
  if (label) {
    lines.push(`- label: ${label}`, '');
  }
  lines.push(brief, '');
  fs.writeFileSync(path.join(runDir, 'brief.md'), lines.join('\n'));
}

function buildRound1Prompt(brief) {
  return [
    'You are participating in round 1 of a fixed 2-round cross-model deliberation.',
    'Answer the brief directly.',
    'State meaningful assumptions.',
    'Separate facts from inference where useful.',
    'Note important uncertainty clearly.',
    'Do not assume access to other model answers.',
    '',
    'Original brief (verbatim below):',
    '<<<BRIEF',
    brief,
    'BRIEF'
  ].join('\n');
}

function buildRound2Prompt(brief, round1Outputs) {
  return [
    'You are participating in round 2 of a fixed 2-round cross-model deliberation.',
    'Reassess the brief after reading all round-1 answers below.',
    'Preserve disagreement if it still seems real after reconsideration.',
    'Do not collapse into fake consensus.',
    'Call out what changed from round 1 if anything important changed.',
    'Provide one final answer with stronger confidence posture than round 1.',
    '',
    'Original brief (verbatim below):',
    '<<<BRIEF',
    brief,
    'BRIEF',
    '',
    'Merged round-1 answers:',
    '<<<ROUND1_ANSWERS',
    renderMergedOutputs(round1Outputs),
    'ROUND1_ANSWERS'
  ].join('\n');
}

function buildFinalPrompt(brief, selectedModels, round1Outputs, round2Outputs) {
  return [
    'Produce the final synthesis for a fixed 2-round cross-model deliberation run.',
    'Follow this markdown structure exactly:',
    '# OpenClaw Consensus — Final Synthesis',
    '## Brief',
    '## Models Used',
    '## Consensus',
    '## Disagreements',
    '## Uncertainties',
    '## Escalation Points',
    '## Final Synthesis',
    '',
    'Rules:',
    '- Preserve real disagreement.',
    '- Do not treat consensus as proof of correctness.',
    '- Keep escalation points narrow and practical.',
    '- Be concrete and readable.',
    '',
    'Original brief:',
    '<<<BRIEF',
    brief,
    'BRIEF',
    '',
    `Selected models: ${selectedModels.join(', ')}`,
    '',
    'Round 1 outputs:',
    '<<<ROUND1',
    renderMergedOutputs(round1Outputs),
    'ROUND1',
    '',
    'Round 2 outputs:',
    '<<<ROUND2',
    renderMergedOutputs(round2Outputs),
    'ROUND2'
  ].join('\n');
}

function renderMergedOutputs(outputsByModel) {
  return Object.entries(outputsByModel)
    .map(([model, response]) => [`## ${model}`, response.text.trim(), ''].join('\n'))
    .join('\n')
    .trim();
}

function renderModelArtifact(model, text) {
  return ensureTrailingNewline([`# ${model}`, '', text.trim(), ''].join('\n'));
}

function runModel({ model, prompt, phase }) {
  const result = runCommand(['infer', 'model', 'run', '--json', '--model', model, '--prompt', prompt], { allowFailure: true });
  const stderr = result.stderr || '';
  if (result.status !== 0) {
    throw new Error(`${phase}: model call failed for ${model}.\n${stderr || result.stdout}`.trim());
  }
  const fallbackSignals = stderr
    .split('\n')
    .filter((line) => line.includes('[model-fallback/decision]') && line.includes(`requested=${model}`));
  if (fallbackSignals.length > 0) {
    throw new Error(`${phase}: OpenClaw fell back away from requested model ${model}.\n${fallbackSignals.join('\n')}`);
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${phase}: could not parse JSON output for ${model}.\n${result.stdout}`);
  }
  const actualModel = `${payload.provider}/${payload.model}`;
  if (actualModel !== model) {
    throw new Error(`${phase}: requested ${model} but OpenClaw executed ${actualModel}.`);
  }
  const text = (payload.outputs ?? []).map((item) => item?.text ?? '').join('\n\n').trim();
  if (!text) {
    throw new Error(`${phase}: model ${model} returned no text output.`);
  }
  return { text, raw: payload };
}

function runCommand(args, { allowFailure }) {
  const result = spawnSync('openclaw', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw result.error;
  }
  if (!allowFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `openclaw ${args.join(' ')} failed`).trim());
  }
  return result;
}

function safeModelName(model) {
  return model.replace(/[^a-zA-Z0-9._-]+/g, '__');
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'run';
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
