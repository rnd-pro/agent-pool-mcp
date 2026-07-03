#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpenRouterClient } from './openrouter-client.js';
import { runBenchmarkSuite } from './harness.js';

function usage() {
  return [
    'Usage: npm run bench:shturman -- --config bench/examples/shturman-smoke.config.json',
    '',
    'Options:',
    '  --config <path>       Benchmark config JSON.',
    '  --out <dir>           Output dir. Defaults to ~/.agent-portal/bench/shturman/<timestamp>.',
    '  --repetitions <n>     Override config repetitions.',
    '  --help                Show help.',
  ].join('\n');
}

function parseArgs(argv) {
  let args = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--help') args.help = true;
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--out') args.out = argv[++i];
    else if (arg === '--repetitions') args.repetitions = Number(argv[++i]);
    else throw new Error(`Unknown argument "${arg}".`);
  }
  return args;
}

function timestampSlug() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function defaultOutDir() {
  return path.join(os.homedir(), '.agent-portal', 'bench', 'shturman', timestampSlug());
}

function readConfig(configPath) {
  if (!configPath) {
    throw new Error('Missing --config. Pass an explicit benchmark config JSON file.');
  }
  let fullPath = path.resolve(configPath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeResult(outDir, result) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(result.summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'runs.jsonl'),
    result.runs.map(run => JSON.stringify(run)).join('\n') + '\n',
  );
  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
}

async function main() {
  let args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  let config = readConfig(args.config);
  let client = createOpenRouterClient({
    appTitle: config.appTitle,
    referer: config.referer,
  });
  let result = await runBenchmarkSuite({
    tasks: config.tasks,
    arms: config.arms,
    repetitions: args.repetitions || config.repetitions || 1,
    transport: request => client.complete(request),
  });
  let outDir = path.resolve(args.out || defaultOutDir());
  writeResult(outDir, result);
  console.log(`Shturman bench wrote ${result.runs.length} runs to ${outDir}`);
  console.log(JSON.stringify(result.summary, null, 2));
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
