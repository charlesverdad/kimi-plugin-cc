# kimi-plugin-cc

Use Kimi CLI from inside Claude Code for code reviews or to delegate tasks to Kimi.

This plugin is for Claude Code users who want an easy way to start using Kimi from the workflow
they already have.

## What You Get

- `/kimi:review` for a normal read-only Kimi review
- `/kimi:adversarial-review` for a steerable challenge review
- `/kimi:rescue`, `/kimi:status`, `/kimi:result`, and `/kimi:cancel` to delegate work and manage background jobs

## Requirements

- **Kimi CLI installed and authenticated.**
  - See https://moonshotai.github.io/kimi-cli/ for installation instructions.
- **Node.js 18.18 or later**

## Install

Add the marketplace in Claude Code:

```
/plugin marketplace add <your-org>/kimi-plugin-cc
```

Install the plugin:

```
/plugin install kimi@<your-org>-kimi
```

Reload plugins:

```
/reload-plugins
```

Then run:

```
/kimi:setup
```

`/kimi:setup` will tell you whether Kimi is ready. If Kimi is missing, it will tell you how to install it.

If Kimi is installed but not logged in yet, run:

```
!kimi login
```

After install, you should see:

- the slash commands listed below
- the `kimi:kimi-rescue` subagent in `/agents`

One simple first run is:

```
/kimi:review --background
/kimi:status
/kimi:result
```

## Usage

### `/kimi:review`

Runs a normal Kimi review on your current work.

Note: Code review especially for multi-file changes might take a while. It's generally recommended to run it in the background.

Use it when you want:

- a review of your current uncommitted changes
- a review of your branch compared to a base branch like `main`

Use `--base <ref>` for branch review. It also supports `--wait` and `--background`. It is not steerable and does not take custom focus text. Use `/kimi:adversarial-review` when you want to challenge a specific decision or risk area.

Examples:

```
/kimi:review
/kimi:review --base main
/kimi:review --background
```

This command is read-only and will not perform any changes. When run in the background you can use `/kimi:status` to check on the progress and `/kimi:cancel` to cancel the ongoing task.

### `/kimi:adversarial-review`

Runs a **steerable** review that questions the chosen implementation and design.

It can be used to pressure-test assumptions, tradeoffs, failure modes, and whether a different approach would have been safer or simpler.

It uses the same review target selection as `/kimi:review`, including `--base <ref>` for branch review.
It also supports `--wait` and `--background`. Unlike `/kimi:review`, it can take extra focus text after the flags.

Use it when you want:

- a review before shipping that challenges the direction, not just the code details
- review focused on design choices, tradeoffs, hidden assumptions, and alternative approaches
- pressure-testing around specific risk areas like auth, data loss, rollback, race conditions, or reliability

Examples:

```
/kimi:adversarial-review
/kimi:adversarial-review --base main challenge whether this was the right caching and retry design
/kimi:adversarial-review --background look for race conditions and question the chosen approach
```

This command is read-only. It does not fix code.

### `/kimi:rescue`

Hands a task to Kimi through the `kimi:kimi-rescue` subagent.

Use it when you want Kimi to:

- investigate a bug
- try a fix
- continue a previous Kimi task

Note: Depending on the task and the model you choose these tasks might take a long time and it's generally recommended to force the task to be in the background or move the agent to the background.

It supports `--background`, `--wait`, and `--continue`. If you omit `--continue`, the plugin can offer to continue the latest rescue thread for this repo.

Examples:

```
/kimi:rescue investigate why the tests started failing
/kimi:rescue fix the failing test with the smallest safe patch
/kimi:rescue --continue apply the top fix from the last run
/kimi:rescue --model kimi-k2 fix the issue quickly
/kimi:rescue --background investigate the regression
```

You can also just ask for a task to be delegated to Kimi:

```
Ask Kimi to redesign the database connection to be more resilient.
```

**Notes:**

- if you do not pass `--model`, Kimi chooses its own defaults.
- follow-up rescue requests can continue the latest Kimi task in the repo

### `/kimi:status`

Shows running and recent Kimi jobs for the current repository.

Examples:

```
/kimi:status
/kimi:status task-abc123
```

Use it to:

- check progress on background work
- see the latest completed job
- confirm whether a task is still running

### `/kimi:result`

Shows the final stored Kimi output for a finished job.

Examples:

```
/kimi:result
/kimi:result task-abc123
```

### `/kimi:cancel`

Cancels an active background Kimi job.

Examples:

```
/kimi:cancel
/kimi:cancel task-abc123
```

### `/kimi:setup`

Checks whether Kimi is installed and authenticated.

## Typical Flows

### Review Before Shipping

```
/kimi:review
```

### Hand A Problem To Kimi

```
/kimi:rescue investigate why the build is failing in CI
```

### Start Something Long-Running

```
/kimi:adversarial-review --background
/kimi:rescue --background investigate the flaky test
```

Then check in with:

```
/kimi:status
/kimi:result
```

## Kimi Integration

The Kimi plugin wraps the Kimi CLI. It uses the global `kimi` binary installed in your environment and applies the same configuration.

### Common Configurations

If you want to change the default model that gets used by the plugin, you can define that inside your user-level or project-level `config.toml`. For example to always use `kimi-k2` for a specific project you can add the following to a `.kimi/config.toml` file at the root of the directory you started Claude in:

```toml
model = "kimi-k2"
```

Your configuration will be picked up based on:

- user-level config in `~/.kimi/config.toml`
- project-level overrides in `.kimi/config.toml`

Check out the Kimi docs for more configuration options.

## FAQ

### Do I need a separate Kimi account for this plugin?

If you are already signed into Kimi on this machine, that account should work immediately here too. This plugin uses your local Kimi CLI authentication.

If you only use Claude Code today and have not used Kimi yet, you will also need to sign in to Kimi. Run `/kimi:setup` to check whether Kimi is ready, and use `!kimi login` if it is not.

### Does the plugin use a separate Kimi runtime?

No. This plugin delegates through your local Kimi CLI on the same machine.

That means:

- it uses the same Kimi install you would use directly
- it uses the same local authentication state
- it uses the same repository checkout and machine-local environment

### Will it use the same Kimi config I already have?

Yes. If you already use Kimi, the plugin picks up the same configuration.
