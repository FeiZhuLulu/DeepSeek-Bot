// DS Bot: a team of long-lived Bots on top of ordinary dsh root Sessions.
// Every Bot is one root Session; the roster, rooms, and the bot-to-bot exchange log live
// in one JSON file under DSH_HOME so they survive restarts without new Session event types.
import { homedir } from 'node:os'
import { join } from 'node:path'
import * as diagnostics from './src/host/diagnostics.js'
import * as store from './src/host/store.js'
import * as models from './src/host/models.js'
import * as turns from './src/host/turns.js'
import * as delivery from './src/host/delivery.js'
import * as roster from './src/host/roster.js'
import * as agents from './src/host/agents.js'
import * as prompt from './src/host/prompt.js'
import * as tools from './src/host/tools.js'
import * as chatIndex from './src/host/chat-index.js'
import * as groups from './src/host/groups.js'
import * as memory from './src/host/memory.js'
import * as parts from './src/host/parts.js'
import * as images from './src/host/images.js'
import * as browser from './src/host/browser.js'
import * as secrets from './src/host/secrets.js'
import * as connectors from './src/host/connectors.js'
import * as schedules from './src/host/schedules.js'
import * as usage from './src/host/usage.js'
import * as update from './src/host/update.js'
import * as channel from './src/host/channel.js'

export { COLORS } from './src/host/constants.js'

export const name = 'ds-bot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

// Each module's install(rt) registers its listeners, tools, and effects, and puts on `rt`
// the functions other modules call; they call them through `rt` at run time, never during
// install. Listeners run and tools are listed in registration order, so this order holds:
// usage meters model requests after every listener that rewrites them.
const MODULES = [diagnostics, store, models, turns, delivery, roster, agents, prompt, tools, chatIndex, groups, memory, parts, images, secrets, connectors, schedules, browser, usage, update, channel]

export function apply(ctx, config = {}) {
  const home = config.home ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'bot')
  const rt = {
    ctx,
    config,
    home,
    statePath: join(home, 'state.json'),
    defaults: {
      mainName: config.mainName ?? 'Chief',
      mainRole: config.mainRole ?? 'Chief of Staff',
    },
  }
  for (const module of MODULES) module.install(rt)
}
