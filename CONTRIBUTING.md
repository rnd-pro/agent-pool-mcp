# Contributing

`agent-pool-mcp` is an MCP server for multi-agent task delegation, CLI orchestration, scheduling, and task lifecycle routing.

Keep changes close to the owning area:

- CLI startup and process lifecycle: `index.js`, `src/cli.js`, and `src/runner/`
- MCP tools and tool schemas: `src/tools/` and `src/tool-definitions.js`
- Scheduling and pipelines: `src/scheduler/`
- Public usage docs: `README.md` and `examples/`

Before opening a change, run:

```sh
npm test
node index.js --version
node index.js --help
```

Do not commit local configs, private coordination files, agent session logs, generated package tarballs, or temporary audits.
