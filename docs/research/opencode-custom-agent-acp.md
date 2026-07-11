# opencode custom-primary agent: ACP `mode` configOption visibility

Date: 2026-07-10
opencode version: 1.17.11 (`opencode --version`)

## Setup

Scratch agent file created additively in the user's real config (deleted unconditionally in step 3):

```
~/.config/opencode/agent/nac-spike-probe.md
---
description: NAC spike probe — safe to delete
mode: primary
---
You are a probe agent. Always begin every reply with the exact token AGENTPROBE:.
```

## Command 1: `opencode agent list`

```
$ opencode agent list 2>&1 | grep -i probe
nac-spike-probe (primary)
```

The custom `mode: primary` agent is recognized by the CLI's own agent listing.

## Command 2: ACP probe (`initialize` -> `session/new`, 15s bounded run; no `timeout`/`gtimeout`
on this machine, used a background-process + `sleep 15` + `kill` pattern instead)

`initialize` result (trimmed):

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true},"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"close":{},"fork":{},"list":{},"resume":{}}},"authMethods":[{"description":"Run `opencode auth login` in the terminal","name":"Login with opencode","id":"opencode-login"}],"agentInfo":{"name":"OpenCode","version":"1.17.11"}}}
```

`session/new` result's `mode` configOption (extracted via `grep -o '"id":"mode".*\]'`):

```json
{"id":"mode","name":"Session Mode","category":"mode","type":"select","currentValue":"build","options":[{"value":"build","name":"build","description":"The default agent. Executes tools based on configured permissions."},{"value":"nac-spike-probe","name":"nac-spike-probe","description":"NAC spike probe — safe to delete"},{"value":"plan","name":"plan","description":"Plan mode. Disallows all edit tools."}]}
```

`nac-spike-probe` is present in the `mode` configOption's `options` array, alongside the builtins
`build` and `plan`, with its `description` frontmatter field passed through as the option's
`description`.

## Cleanup

```
$ rm ~/.config/opencode/agent/nac-spike-probe.md
$ opencode agent list 2>&1 | grep -i probe
(no output — confirmed removed)
```

## Verdict

`CUSTOM_PRIMARY_VISIBLE: yes`

A custom `mode: primary` opencode agent IS surfaced as an option in the ACP `session/new` response's
`mode` configOption, indistinguishable in shape from the builtin `build`/`plan` entries (same
`value`/`name`/`description` fields). The earlier probe that saw only builtins there was evidently
filtering something else (or the agent file wasn't yet on disk/registered) — with the scratch file
present, the custom primary agent appeared correctly. NAC can therefore treat opencode as
`support: 'full'` for custom primary agents discovered and driven over ACP mode selection; no
downgrade note or CLI-only caveat is needed for opencode in the agent picker.
