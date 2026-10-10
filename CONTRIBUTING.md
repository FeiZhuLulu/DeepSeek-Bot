# Contributing to DS Bot

Thank you for helping. This file explains how to set up the plugin, how to test a change and which rules a change must follow. For what the plugin does and how users install it, see [README.md](README.md).

## The rules that matter most

1. **DS Bot is a DSH plugin, and only a plugin.** Do not patch DeepSeek Harness, and do not depend on files inside a DSH install. Use the plugin APIs that DSH documents (Cordis services, the plugin client entry, profile patches). When a feature needs something that DSH does not offer, open an issue here first; the fix can belong in DSH.
2. **Every Bot is a DSH Session.** Bot work runs through the normal DSH agent loop, tools and model routes. Do not add a second agent runtime.
3. **No real secrets anywhere.** Do not commit API keys, tokens, cookies, `DSH_HOME` folders, logs or screenshots with personal data. The tests and the test bench use a scripted mock model and need no key.
4. **Only original material.** Do not copy code, text, icons, logos or other graphics from other products or websites. Code under a license compatible with Apache 2.0 is the only exception: say where it comes from in the pull request and add its notice to a `NOTICE` file.
5. **Every change is tested.** Run the unit tests and the client check before you open a pull request (see [Test a change](#test-a-change)).

## Set up

You need:

- Node.js `22.19` or later (or `24` and later), and pnpm `11`.
- Git.
- A checkout of DeepSeek Harness at the DSH version that the plugin is tested with. The unit tests and the test bench load the `@deepseek-ai/*` packages from it.

```sh
git clone https://github.com/FeiZhuLulu/DeepSeek-Bot.git ds-bot-repo
cd ds-bot-repo

# DeepSeek Harness, next to the plugin folder (this folder is ignored by Git).
git clone https://github.com/deepseek-ai/deepseek-harness.git
git -C deepseek-harness checkout dsh-v0.2.1-alpha.1
(cd deepseek-harness && pnpm install)

# The plugin's own build tool (esbuild only).
cd ds-bot
npm ci
```

If your DeepSeek Harness checkout is somewhere else, set `DSH_HARNESS` to its path for the tests and the test bench.

The `@deepseek-ai/*` packages are peer dependencies: in a real install, the DSH profile supplies them. `ds-bot/.npmrc` keeps npm from installing them into the plugin folder.

## Layout

| Path | What it is |
|---|---|
| `ds-bot/index.js`, `ds-bot/src/host/` | The server side: Bot roster and store, tools, turns and delivery, group chats, conversation parts and the search index, images, the Bot browser bridge, the `api/bot` channel |
| `ds-bot/src/client/` | The browser side: sidebar, chat, panels and dialogs, themes, characters, the Bot browser panel |
| `ds-bot/client.js` | Generated from `src/client/` by `scripts/build-client.mjs`. It is committed, so that Git installs need no build step |
| `ds-bot/web-search.js` | The `auto` web-search provider. It does not depend on the Bot team code |
| `ds-bot/cordis.patch.yml` | The profile patch that the plugin brings |
| `ds-bot/test/` | Unit tests and fixtures |
| `ds-bot/dev/` | The mock model, the test bench, the smoke test, the character generator, the Desktop scripts for Linux, and two tools for real models: the steward evaluation and a logging pass-through |

## Test a change

Run these in `ds-bot/`:

```sh
npm run build                          # src/client → client.js
npm test                               # unit tests; they also fail if client.js is stale
node scripts/build-client.mjs --check  # client.js matches src/client
```

For a change to the server side (`index.js`, `src/host/`), also run the smoke test. It starts the mock model and a DSH Web with the plugin linked from your checkout, and walks through the main flows (Bots, group chats, conversation parts, condensing, settings). `CONTEXT_WINDOW` and `CHECK_RATIO` give the mock models a small window, so a few long replies reach the check line:

```sh
CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096
dev/bench.sh smoke 3096 8796 stop
```

To try the plugin by hand, start a bench and open the address that it prints:

```sh
dev/bench.sh dev 3081 8771 reset    # mock model + DSH Web; data in ../.dsh-test-dev
```

The mock model answers a fixed set of commands, so a bench costs no tokens. The commands are listed at the top of `dev/mock-llm.mjs`. Bench data stays in `.dsh-test-<name>/` next to the plugin folder and never touches your own `~/.dsh`.

For a change to the context steward or its prompts (`src/host/steward.js`), also check it on a real model. `dev/steward-eval.mjs` runs its decisions on fixed conversation endings, and `dev/llm-tap.mjs` logs every call a real bench makes. Both cost tokens and explain their use at the top.

For a change to the Bot browser, check it in DSH Desktop. On Linux, the scripts in `dev/desktop-linux/` run DSH Desktop under Xvfb; each script explains its use at the top.

## Write a change

- Keep a pull request to one subject. Explain why the change is needed, how you tested it, and what you did not test.
- Do not edit `client.js` by hand. Change `src/client/`, run `npm run build` and commit both.
- Follow the style of the code around your change. Write a comment only when the reason for the code is not clear from the code itself.
- Write commit messages in English. Use a short subject in the imperative mood ("Keep group replies visible") and explain the reason in the body.
- Add an entry to [CHANGELOG.md](CHANGELOG.md) under "Unreleased" for a change that users can see.

## Report a problem

The easiest way is from DS Bot itself: open **Settings → Feedback**, write what happened and select **Report on GitHub**. It opens a new issue with the DS Bot and DSH versions, your system, the models and the recent errors already filled in. **Copy** puts the same text on the clipboard, and **Download** saves the full error log (`<DSH_HOME>/bot/logs/diagnostics.jsonl`).

If you open an issue by hand, include:

- The DSH version (DSH Desktop or `@deepseek-ai/dsh`), your operating system, and whether you use DSH Desktop or DSH Web.
- How you installed DS Bot (npm, release file, Git address or command line) and its version.
- What you did, what you expected and what happened, with the exact error text.

DS Bot removes API keys, tokens, saved secrets and your home folder from its diagnostics. Read the text before you post it, and remove personal data from screenshots.

For a security problem, do not open a public issue. Use **Report a vulnerability** on the repository's **Security** tab.

## License

DS Bot is licensed under the [Apache License 2.0](LICENSE). When you submit a contribution, you agree that it is licensed under the same license, as section 5 of the license says.
