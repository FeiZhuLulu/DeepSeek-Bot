# Changelog

All notable changes to DS Bot are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions follow [Semantic Versioning](https://semver.org/). Before 1.0, a minor version can contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-10-10

The first public preview. Tested with DeepSeek Harness `0.2.1-alpha.1` (DSH Desktop and DSH Web).

### Added

- A team of long-lived Bots. Each Bot is a DSH Session with its own name, role label, instructions, model and character. Every Bot runs on one model of its own, chosen from the models configured in DSH (the `list_models` tool lists them). Creating a Bot opens a form: pick its look, its model (the DSH default model comes first) and its name.
- Main Bots that create, change and remove other Bots. You can have more than one Main Bot, change the Main Bot in one step on Settings → Bots, and move one to the front; there is always at least one. A Main Bot wears a large star on its avatar.
- Messages between Bots, questions to you that do not stop the other Bots, and a view of what each Bot is doing.
- Group chats in which members speak in turn, can be called with `@name` and stay silent when they have nothing new to add. A new group chat starts with its admin, who wears a small star and manages the group. Every group chat has its own settings page: name, notice, who answers, members and admin, pin and hide, and delete.
- The DSH Agent: one plain DSH entry in the sidebar beside the Bots, with its own Sessions on the native DSH conversation page and none of the team tools.
- Long conversations that stay inside the model's window. The context lines follow the model's `contextWindow` (500,000 tokens when a model reports none), and the check line is a share of it (`checkRatio`, default 0.8). When a turn ends past the check line, a small separate model call decides once: condense the conversation in place into a checkpoint (a handoff summary plus the user's recent messages word for word) while the work is under way, or let the Bot write a handoff note and continue in a new part when the work has reached a stopping point. Neither leaves a marker in the chat. DSH's own compaction does not run on Bot conversations. Earlier parts and condensed messages stay in a local full-text index that the Bot can search.
- Memory. Each Bot keeps notes across all its conversations (`MEMORY.md` and topic files in the Agent Memory Repo format), and the team shares one more memory that Main Bots and group admins write. Bots use the `remember`, `forget` and `recall` tools, and after each turn the Bot's model reviews what is new and keeps, updates or removes entries itself (`memoryReview: false` turns this off). Each conversation reads the memory once, when it starts, so the prompt cache holds. Sizes are fixed, keys and tokens are refused, and `memory/journal.jsonl` keeps every change. `memory: false` turns memory off.
- The memory panel, opened from the Memory row in a Bot's details panel or settings, or from "Memory updated" in its chat: a summary that the Bot's model writes from the entries, every entry with remove, and "Ask or update" to ask about the memory or change it in plain words.
- Scheduled tasks for Bots and group chats: once, every day, every week on chosen days, or every so many minutes, hours or days. Add them from Settings → Scheduled tasks or from **Scheduled task** in the composer's **+** menu. A task sends its message to the chat when it is due. The tasks run on DSH's Automation tasks.
- A Usage page in Settings: token usage over the last 24 hours, 7 days, 30 days, 12 weeks or 12 months, or over days picked on a calendar, with the change from the period before, a chart by Bot or by model, a ranking of Bots and models, and a year of daily activity. Each Bot and each model opens its own page. The counts are kept in `usage.sqlite`. Tokens only, no cost.
- A Connectors page in Settings, with GitHub as the first connector: paste a GitHub token to use GitHub's tools for repositories, issues and pull requests. The token is kept as the `GITHUB_TOKEN` secret. `github: false` hides it.
- The `auto` web-search provider: the native search of the current model route, with a keyless fallback to public results pages.
- A Bot browser in DSH Desktop: each Bot has its own browser with tabs and its own storage partition, in the same side panel as the Bot's details. The Bot reads the open page as structured Markdown (headings, lists, tables, code blocks, open Shadow DOM, same-origin frames) and never reads password, card or one-time-code values.
- Secret cards: a Bot asks for an API key or token in its own chat, you choose which Bots may use it, and the Bot gets it only as a shell environment variable. Saved values are hidden as `[secret:<NAME>]` in tool results and model requests. Settings → Secrets manages them.
- Text descriptions of images for models that cannot read images, made by a configured model that declares image input.
- Customization of the name, role label, instructions, model, character, theme and accent color. The first Main Bot is a whale in DeepSeek blue.
- Avatar animation in three levels (Settings → Bots → Animation): **Quiet**, **Normal** (the default) and **Lively**. Panels, menus and controls move on springs.
- Settings with pages for General, Bots, Group chats, Connectors, Scheduled tasks, Usage, Secrets and Feedback.
- The interface follows the DSH language (English or Chinese).
- **Classic Agent mode** (Settings → General) gives the window back to the native DSH interface; the **DS Bot** button at the bottom of the sidebar brings the team view back.
- Settings → Feedback: the DS Bot and DSH versions, the system and the recent errors, with **Report on GitHub**, **Copy**, **Download** and **Clear**. Keys, tokens, saved secrets and the home folder are removed from the text. Errors are also written to `<home>/logs/diagnostics.jsonl` (`diagnosticsFile: false` keeps them in memory only), and a failed request shows a short notice with a **Details** link.
- Update checks: DS Bot looks for a newer release where it was installed from (the npm registry, or GitHub for a versioned git install) and shows a cloud button at the sidebar's top right when one exists. One click installs it; the new version runs from the next DSH start. `updateCheck: false` turns the checks off.
- One writer per team: when DSH Web and DSH Desktop share a DSH home, the second one opens the team read-only, says why, and takes over when the first one quits.

If you used the legacy `dsh-bot` package, remove it before you install `ds-bot`. The team data stays in `<DSH_HOME>/bot`, and the theme, Bot colors and browser settings move over the first time DS Bot opens.

### Known limitations

- Tested with DSH `0.2.1-alpha.1`, mainly on Linux and in DSH Web. DSH is an alpha, and a newer DSH can break the plugin.
- The Bot browser is in DSH Desktop only, and Bots can only read pages ([Bot browser](ds-bot/README.md#bot-browser)).
- Secrets are stored without encryption, and only exact copies of a value are hidden ([Secrets](ds-bot/README.md#secrets)).
- Only one DSH can change a team at a time; a second DSH on the same DSH home opens it read-only ([Data and backups](ds-bot/README.md#data-and-backups)).
- Group chats use many tokens: each member reads the group and answers in turn.

[Unreleased]: https://github.com/FeiZhuLulu/DeepSeek-Bot/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/FeiZhuLulu/DeepSeek-Bot/releases/tag/v0.1.0
