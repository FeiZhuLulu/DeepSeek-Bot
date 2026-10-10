# AGENTS.md

Instructions for AI coding agents that work on this repository. Human contributors: see [CONTRIBUTING.md](CONTRIBUTING.md), which has the same rules with more detail.

## What this project is

DS Bot (`ds-bot/`) is a plugin for DeepSeek Harness (DSH). It turns DSH Desktop and DSH Web into a team of long-lived Bots:

- Every Bot is a DSH Session and runs through the normal DSH agent loop, tools and model routes.
- The team works together: Bots message each other, share group chats and can see what the other Bots are doing. Each Bot still runs on its own and does not disturb the others.
- Bots have clear, different roles. A Main Bot has the highest rights: it creates, changes and removes other Bots. Other Bots do not get these rights. There can be more than one Main Bot.
- Users customize each Bot (name, role label, instructions, model, character).
- Behavior must be reliable: a Bot acts on evidence, stays inside its goal, and its results can be checked.

## Hard rules

1. **Plugin only.** Never patch DeepSeek Harness or depend on files inside a DSH install. Use the documented plugin APIs. If something is missing in DSH, stop and say so; do not work around it with a patch.
2. **No secrets.** Never write, print or commit API keys, tokens, cookies or `DSH_HOME` contents. Use the mock model (`ds-bot/dev/mock-llm.mjs`) for tests; it needs no key.
3. **Only original material.** Do not copy code, text, icons, logos or graphics from other products or websites.
4. **`client.js` is generated.** Change `ds-bot/src/client/`, then run `npm run build` and commit both files. Never edit `client.js` by hand.
5. **Do not touch the user's own DSH data.** The test bench keeps its data in `.dsh-test-<name>/`. Never point a test at `~/.dsh` or at a DSH that the user runs.

## Commands

Run in `ds-bot/`. The tests need a DeepSeek Harness checkout at `../deepseek-harness` (or `DSH_HARNESS`), at the DSH version in the README.

```sh
npm ci                                 # build tool only (esbuild)
npm run build                          # src/client → client.js
npm test                               # unit tests; also fail if client.js is stale
node scripts/build-client.mjs --check  # client.js matches src/client
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096   # smoke test
dev/bench.sh smoke 3096 8796 stop
```

A change is done when `npm test` and the `--check` pass. Run the smoke test as well for changes to `index.js` or `src/host/`. Use a free port for each bench, and stop every bench and process that you started.

## Layout

- `ds-bot/index.js` and `ds-bot/src/host/`: the server side (roster and store, tools, turns and delivery, groups, conversation parts and the search index, images, the browser bridge, the `api/bot` channel).
- `ds-bot/src/client/`: the browser side (sidebar, chat, panels, themes, characters, the Bot browser panel).
- `ds-bot/web-search.js`: the `auto` web-search provider, independent of the Bot team code.
- `ds-bot/test/`: unit tests and fixtures. `ds-bot/dev/`: mock model, test bench, smoke test, character generator, Desktop scripts for Linux.

## Style

- Follow the code around your change. Keep functions small and names plain.
- Write a comment only when the reason is not clear from the code: a hidden constraint, an invariant, a workaround. Do not describe what the code does.
- Commit messages in English, imperative subject, the reason in the body. Keep commits small.
- User-facing text in the plugin is English. Keep the README and README.zh.md in step when you change one of them.
