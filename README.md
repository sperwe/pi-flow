<div align="center">

# pi-flow

**Give Pi a team.**

Orchestrate subagents and multi-step workflows across **Pi**, **Codex CLI**, and **Claude Code** without leaving your Pi session.

[![CI](https://github.com/kky42/pi-flow/actions/workflows/ci.yml/badge.svg)](https://github.com/kky42/pi-flow/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40kky42%2Fpi-flow)](./LICENSE)

</div>

## One coordinator, focused subagents

Define subagents for **Pi**, **Codex CLI**, and **Claude Code**, then orchestrate them from one Pi session - a few parallel `run_agent` calls or a staged `run_workflow` with live progress.

| Primitive | Use it for |
| --- | --- |
| **`run_agent`** | One focused, resumable subagent or several independent subagents in parallel. |
| **`run_workflow`** | Parallel or staged subagents, branching, structured results, and saved orchestration. |

<p align="center">
  <img src="./assets/pi-flow-subagents.png" alt="Three Pi subagents greet the user in parallel" width="49%">
  <img src="./assets/pi-flow-workflow.png" alt="A two-phase demo workflow runs four subagents" width="49%">
</p>

## Try it

```bash
pi install npm:@kky42/pi-flow
```

Ask Pi naturally:

```text
Use three subagents in parallel to review architecture, tests, and documentation, then synthesize their findings.
```

```text
Use a workflow to classify each changed file by risk, run the matching review, and return structured results.
```

The active Tool row shows queued and running work. Pi receives the final Tool result after the direct subagent or outer workflow finishes.

In an interactive Pi session, starting `run_agent` or `run_workflow` **automatically
opens** a non-focusing, right-aligned task monitor; no manual command is needed.
The panel remains visible after the run to allow reviewing its final state.
`/flow-panel` can still close or reopen it. `/flow-panel next` and `/flow-panel prev` change the
selected task; `/flow-panel up` and `/flow-panel down` browse its recent activity.
This is a Pi 1.5.1 overlay, **not** a terminal multiplexer split pane; it does
not spawn another agent or change the behavior of `run_agent` / `run_workflow`.
See [the monitor guide](docs/flow-panel.md) for limits and verification details.

For Pi-backed children with a configured wall-clock limit of at least ten minutes,
pi-flow now queues **one safe handoff request** before the hard timeout: 10% of
the limit, capped at five minutes (at the default two-hour limit, after 1h55m).
The child is asked to stop new exploration, respect its original permissions,
use existing project handoff files only if authorized, and return verified
outputs, remaining work, and evidence paths. This is a best-effort queued
`steer()` message, delivered only when Pi reaches the next steering point;
it cannot interrupt a stuck tool or guarantee a final answer. The original
hard timeout and failed-result behavior remain in force. Disabling the timeout
with `--subagent-timeout-ms 0` disables the handoff timer as well.

Pi-backed task progress also reports completed/failed tool calls and exact
repeated failed calls (bounded hashed fingerprints, without storing tool
arguments in progress history). These are **tool-execution observations**, not
verified project milestones or a quality score. Codex and Claude CLI backends
still get their existing hard timeout: their one-shot stdin interface does not
support this safe mid-run steering. No new database, background watchdog, or
separate model call is introduced, although a delivered steering message may
consume tokens during the child's normal continuation.

### Add simple subagents

Profiles live at `~/.pi/agent/subagents/<name>.md`. The filename becomes the profile name. Codex and Claude profiles bypass their native permission prompts, so use them only in trusted repositories.

Pi-backed profiles inherit the ambient Skill catalog by default. Set `inheritSkills: false` to give a child no Skills, or set `skills: skill-a, skill-b` to expose only those names from the discovered catalog. An explicit `skills` list takes precedence over `inheritSkills`. These fields affect Pi-backed children only.

**Pi explorer**

```md
---
description: Fast read-only repository explorer.
model: deepseek/deepseek-v4-flash
thinking: high
---
Map the repository and return the important paths.
```

**Codex reviewer**

```md
---
description: Reviews code for correctness and missed edge cases.
backend: codex
model: gpt-5.6-luna
thinking: high
---
Review the current diff and lead with concrete findings.
```

**Claude UI reviewer**

```md
---
description: Reviews UI quality and accessibility.
backend: claude
model: claude-sonnet-4-5
thinking: high
---
Inspect the UI and recommend specific improvements.
```

## License

[MIT](./LICENSE)
