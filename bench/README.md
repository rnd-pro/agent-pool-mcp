# Shturman Bench

Phase-0 benchmark harness for the Shturman guided-reasoning experiment.

The harness compares solo and chain-guided arms with mechanical checks only. It uses OpenRouter through
the OpenAI-compatible chat endpoint, reads `OPENROUTER_API_KEY` from the environment, and writes raw runs
to `~/.agent-portal/bench/shturman/` unless `--out` is supplied.

Run:

```bash
OPENROUTER_API_KEY=<key> npm run bench:shturman -- \
  --config bench/examples/shturman-smoke.config.json
```

Unit tests use a mock transport and do not call OpenRouter.
