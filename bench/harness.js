const DEFAULT_MAX_ITERATIONS = 4;

const DELTA_SCHEMA = {
  type: 'object',
  required: ['missing', 'next_goal'],
  properties: {
    missing: { type: 'array', items: { type: 'string' } },
    next_goal: { type: 'string' },
  },
};

const RETRO_SCHEMA = {
  type: 'object',
  required: ['lacked'],
  properties: {
    lacked: { type: 'array', items: { type: 'string' } },
  },
};

function nowIso() {
  return new Date().toISOString();
}

function assertArray(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array.`);
  }
}

function stripFence(content) {
  let trimmed = String(content || '').trim();
  let match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function parseJsonObject(content, label) {
  let text = stripFence(content);
  try {
    let parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('expected a JSON object');
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} must be a schema-valid JSON object: ${error.message}`);
  }
}

function validateValue(value, spec, valuePath) {
  if (!spec) return [];
  if (spec.type === 'string') {
    return typeof value === 'string' ? [] : [`${valuePath} must be a string`];
  }
  if (spec.type === 'array') {
    if (!Array.isArray(value)) return [`${valuePath} must be an array`];
    if (!spec.items) return [];
    return value.flatMap((item, index) => validateValue(item, spec.items, `${valuePath}[${index}]`));
  }
  return [];
}

function validateSchema(value, schema, label) {
  let errors = [];
  for (let key of schema.required || []) {
    if (!(key in value)) errors.push(`${label}.${key} is required`);
  }
  for (let [key, spec] of Object.entries(schema.properties || {})) {
    if (key in value) errors.push(...validateValue(value[key], spec, `${label}.${key}`));
  }
  if (errors.length) {
    throw new Error(`${label} failed schema validation: ${errors.join('; ')}`);
  }
}

function parseStructuredAnswer(content, schema, label) {
  let parsed = parseJsonObject(content, label);
  validateSchema(parsed, schema, label);
  return parsed;
}

function normalizeModelResult(result, startedAt) {
  return {
    content: result?.content || '',
    model: result?.model || null,
    provider: result?.provider || null,
    usage: result?.usage || null,
    costUsd: result?.costUsd ?? null,
    latencyMs: result?.latencyMs ?? Date.now() - startedAt,
  };
}

function usageCost(result) {
  return typeof result.costUsd === 'number' && Number.isFinite(result.costUsd)
    ? result.costUsd
    : 0;
}

function totalTokens(result) {
  return Number(result.usage?.total_tokens || result.usage?.totalTokens || 0);
}

function makeMessages({ task, nodeType, iteration, answer, failures, lessons, delta }) {
  let system = [
    'You are executing a benchmark task.',
    'Return only the requested answer format.',
    'Do not mention benchmark internals.',
  ].join('\n');

  if (nodeType === 'attempt') {
    return [
      { role: 'system', content: system },
      {
        role: 'user',
        content: [
          `Task: ${task.prompt}`,
          lessons.length ? `Prior lessons: ${JSON.stringify(lessons)}` : '',
          delta ? `Current missing delta: ${JSON.stringify(delta)}` : '',
          'Produce the final task answer.',
        ].filter(Boolean).join('\n\n'),
      },
    ];
  }

  if (nodeType === 'delta') {
    return [
      {
        role: 'system',
        content: `${system}\nReturn JSON matching {"missing":["..."],"next_goal":"..."}.`,
      },
      {
        role: 'user',
        content: [
          `Task: ${task.prompt}`,
          `Attempt ${iteration} answer: ${answer}`,
          `Mechanical verification failures: ${JSON.stringify(failures)}`,
          'Name what is still missing and the next concrete sub-goal.',
        ].join('\n\n'),
      },
    ];
  }

  return [
    {
      role: 'system',
      content: `${system}\nReturn JSON matching {"lacked":["..."]}.`,
    },
    {
      role: 'user',
      content: [
        `Task: ${task.prompt}`,
        `Attempt ${iteration} answer: ${answer}`,
        `Delta: ${JSON.stringify(delta)}`,
        'Name the information or instruction that was missing on this iteration.',
      ].join('\n\n'),
    },
  ];
}

async function callModel(args) {
  let { transport, task, arm, nodeType, iteration, answer, failures, lessons, delta } = args;
  let startedAt = Date.now();
  let result = await transport({
    model: arm.model,
    provider: arm.provider,
    providerOrder: arm.providerOrder,
    allowFallbacks: arm.allowFallbacks,
    dataCollection: arm.dataCollection,
    temperature: arm.temperature ?? 0,
    maxTokens: arm.maxTokens,
    messages: makeMessages({ task, nodeType, iteration, answer, failures, lessons, delta }),
    metadata: {
      taskId: task.id,
      armId: arm.id,
      nodeType,
      iteration,
    },
  });
  return normalizeModelResult(result, startedAt);
}

/**
 * @param {string} answer
 * @param {Array<object>} checks
 * @returns {{ passed: boolean, failures: Array<object> }}
 */
export function verifyAnswer(answer, checks = []) {
  let failures = [];

  for (let check of checks) {
    if (check.type === 'includes') {
      if (!String(answer).includes(check.value)) {
        failures.push({ check, message: `Expected answer to include "${check.value}".` });
      }
    } else if (check.type === 'regex') {
      let regex = new RegExp(check.pattern, check.flags || '');
      if (!regex.test(String(answer))) {
        failures.push({ check, message: `Expected answer to match /${check.pattern}/.` });
      }
    } else {
      throw new Error(`Unknown bench check type "${check.type}". Supported: includes, regex`);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

async function runSolo({ task, arm, transport, repetition }) {
  let modelResult = await callModel({
    transport,
    task,
    arm,
    nodeType: 'attempt',
    iteration: 1,
    lessons: [],
  });
  let verification = verifyAnswer(modelResult.content, task.checks);

  return {
    taskId: task.id,
    armId: arm.id,
    mode: arm.mode || 'solo',
    repetition,
    solved: verification.passed,
    escalated: false,
    failureReason: verification.passed ? null : 'verification_failed',
    nodes: [
      {
        type: 'attempt',
        iteration: 1,
        content: modelResult.content,
        usage: modelResult.usage,
        costUsd: modelResult.costUsd,
        latencyMs: modelResult.latencyMs,
      },
      {
        type: 'invariant',
        iteration: 1,
        passed: verification.passed,
        failures: verification.failures,
      },
    ],
  };
}

async function runChain({ task, arm, transport, repetition }) {
  let lessons = [];
  let previousDeltaKey = null;
  let activeDelta = null;
  let maxIterations = arm.maxIterations || DEFAULT_MAX_ITERATIONS;
  let nodes = [];

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    let attempt = await callModel({
      transport,
      task,
      arm,
      nodeType: 'attempt',
      iteration,
      lessons,
      delta: activeDelta,
    });
    nodes.push({
      type: 'attempt',
      iteration,
      content: attempt.content,
      usage: attempt.usage,
      costUsd: attempt.costUsd,
      latencyMs: attempt.latencyMs,
    });

    let verification = verifyAnswer(attempt.content, task.checks);
    nodes.push({
      type: 'invariant',
      iteration,
      passed: verification.passed,
      failures: verification.failures,
    });

    if (verification.passed) {
      return {
        taskId: task.id,
        armId: arm.id,
        mode: 'chain',
        repetition,
        solved: true,
        escalated: false,
        failureReason: null,
        nodes,
      };
    }

    if (iteration === maxIterations) {
      return {
        taskId: task.id,
        armId: arm.id,
        mode: 'chain',
        repetition,
        solved: false,
        escalated: true,
        failureReason: 'iteration_cap',
        nodes,
      };
    }

    let deltaResult = await callModel({
      transport,
      task,
      arm,
      nodeType: 'delta',
      iteration,
      answer: attempt.content,
      failures: verification.failures,
      lessons,
    });
    let delta = parseStructuredAnswer(deltaResult.content, DELTA_SCHEMA, 'delta');
    let deltaKey = JSON.stringify(delta);
    nodes.push({
      type: 'delta',
      iteration,
      answer: delta,
      usage: deltaResult.usage,
      costUsd: deltaResult.costUsd,
      latencyMs: deltaResult.latencyMs,
    });

    if (deltaKey === previousDeltaKey) {
      return {
        taskId: task.id,
        armId: arm.id,
        mode: 'chain',
        repetition,
        solved: false,
        escalated: true,
        failureReason: 'repeated_delta',
        nodes,
      };
    }
    previousDeltaKey = deltaKey;
    activeDelta = delta;

    let retroResult = await callModel({
      transport,
      task,
      arm,
      nodeType: 'retro',
      iteration,
      answer: attempt.content,
      delta,
      lessons,
    });
    let retro = parseStructuredAnswer(retroResult.content, RETRO_SCHEMA, 'retro');
    nodes.push({
      type: 'retro',
      iteration,
      answer: retro,
      usage: retroResult.usage,
      costUsd: retroResult.costUsd,
      latencyMs: retroResult.latencyMs,
    });
    lessons.push({ iteration, delta, retro });
  }

  throw new Error('Unreachable chain loop exit.');
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function runBenchmarkSuite(options) {
  let tasks = options.tasks || [];
  let arms = options.arms || [];
  let repetitions = options.repetitions || 1;
  let transport = options.transport;
  assertArray(tasks, 'tasks');
  assertArray(arms, 'arms');
  if (typeof transport !== 'function') {
    throw new Error('transport must be a function.');
  }

  let runs = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    for (let arm of arms) {
      for (let task of tasks) {
        let runner = arm.mode === 'chain' ? runChain : runSolo;
        runs.push(await runner({ task, arm, transport, repetition }));
      }
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    repetitions,
    arms: arms.map(arm => ({
      id: arm.id,
      mode: arm.mode || 'solo',
      model: arm.model,
      provider: arm.provider || null,
    })),
    tasks: tasks.map(task => ({ id: task.id })),
    runs,
    summary: summarizeRuns(runs),
  };
}

/**
 * @param {Array<object>} runs
 * @returns {object}
 */
export function summarizeRuns(runs) {
  let byArm = new Map();
  for (let run of runs) {
    if (!byArm.has(run.armId)) {
      byArm.set(run.armId, {
        armId: run.armId,
        runs: 0,
        solved: 0,
        escalations: 0,
        totalCostUsd: 0,
        totalTokens: 0,
        totalLatencyMs: 0,
      });
    }
    let stats = byArm.get(run.armId);
    stats.runs++;
    if (run.solved) stats.solved++;
    if (run.escalated) stats.escalations++;

    for (let node of run.nodes || []) {
      stats.totalCostUsd += usageCost(node);
      stats.totalTokens += totalTokens(node);
      stats.totalLatencyMs += Number(node.latencyMs || 0);
    }
  }

  return Array.from(byArm.values()).map(stats => ({
    ...stats,
    solveRate: stats.runs ? stats.solved / stats.runs : 0,
    averageLatencyMs: stats.runs ? Math.round(stats.totalLatencyMs / stats.runs) : 0,
    totalCostUsd: Number(stats.totalCostUsd.toFixed(6)),
  }));
}

export { DELTA_SCHEMA, RETRO_SCHEMA, DEFAULT_MAX_ITERATIONS };
