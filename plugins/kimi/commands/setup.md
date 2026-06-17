---
description: Check whether the local Kimi CLI is ready
argument-hint: '[--json]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/kimi-companion.mjs" setup --json $ARGUMENTS
```

If the result says Kimi is unavailable:
- Tell the user to install Kimi CLI from https://moonshotai.github.io/kimi-cli/

If Kimi is installed but not authenticated:
- Tell the user to run `!kimi login`.

Output rules:
- Present the final setup output to the user.
