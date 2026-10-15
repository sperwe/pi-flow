# Automatic background bash for Pi

`pi-flow` ships a second Pi extension that keeps ordinary shell usage simple while avoiding long idle waits.

The extension overrides Pi's built-in `bash` tool in interactive TUI sessions. A normal command starts in the foreground. If it is still running after 10 seconds, the same process is handed back as a background task and the tool call returns immediately, so the current agent can continue reading, editing, or reasoning while the command runs. When the task finishes, Pi receives one completion message and starts a new model turn if the agent is otherwise idle.

Non-interactive Pi modes keep normal foreground execution unless `run_in_background` is explicitly requested. This avoids changing headless harness timing by accident.

This is deliberately not a subagent scheduler. It is one agent, one conversation, and concurrent external work.

## Model-facing tools

The normal `bash` tool keeps `command` and hard `timeout`, and adds optional `run_in_background`. Most calls should omit it; long commands yield automatically.

`task_output` reads a background task and can wait once when a dependent step truly needs the result. `task_stop` stops the task's process tree. `task_list` shows running and recently completed tasks.

The default policy allows four simultaneously running background tasks. Output is kept in a bounded in-memory tail and also written to a temporary log. Completed task metadata is retained for one hour; logs are retained for 24 hours.

## Why this implementation

Evot's interactive agent uses a bounded foreground wait and then yields the still-running process instead of making the model predict which commands will be slow. That is the core behavior copied here.

The completion wake follows the safer pattern used by `fl4p/pi-extensions`: completion is deferred while an agent run, prompt submission, compaction, or blocking extension UI prompt is active. If the model already collected a completed task with `task_output`, the redundant completion wake is cancelled.

A hard `timeout` remains a hard process limit and stops the process tree. Auto-yield does not reinterpret timeout as a detach operation.

## DeepSeek / pi-dsh-minimal

The behavior lives in the Pi host-side `bash` implementation, so it still helps when another extension presents a reduced first-turn tool schema to the model. In particular, `pi-dsh-minimal` can keep its first-request `bash` surface while commands that exceed the foreground window still yield underneath it. After promotion, `task_output`, `task_stop`, and `task_list` are available with the rest of Pi's tools.

Do not install a second background-bash extension at the same time unless you intentionally want two different task systems.
