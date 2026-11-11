# Interactive PiFlow task monitor

PiFlow keeps its original synchronous `run_agent` and `run_workflow` execution
interfaces. The optional task monitor only presents execution observations; it
does not create child agents, schedule tasks, or infer completion from activity.

On Pi 1.5.1, type `/flow-panel` in the interactive prompt to toggle the panel.
It opens at the upper right without taking keyboard focus from Pi's editor.
`/flow-panel open` and `/flow-panel close` are explicit alternatives.
`/flow-panel next` / `/flow-panel prev` select among retained tasks, while
`/flow-panel up` / `/flow-panel down` move through recent activity. Open the
panel before starting a long delegation to watch that delegation continuously.

The panel shows task status, backend, duration, observed tool outcomes,
error summaries, workflow phase, child status, and recent events. Tool failures
are not equivalent to project failure, and `done` does not imply user review or
successful deployment. Events are bounded and may be truncated. Historical
events beyond the runtime's retention window are **not** recoverable through
the panel. Its data is in-memory, cleared when Pi changes or ends sessions.
No full prompt, child result, or workflow result is duplicated in the monitor.

This is a non-capturing Pi overlay, not a true split pane. At smaller terminal
widths it occupies most of the available view; close it to regain space.
Terminal-multiplexer integration (such as Herdr) would be a separate optional
presentation adapter using these same execution snapshots. No extra process,
daemon, or persistent log is started by this monitor.

For local development, validate with `npm run check`. To exercise the code
without changing the installed Git package, launch Pi with
`pi --no-extensions -e /path/to/pi-flow/index.ts`. The default Pi package
installation still uses its Git source and needs a normal, authorized package
update before this local change takes effect. Existing running Pi sessions
do not hot-reload extensions.
