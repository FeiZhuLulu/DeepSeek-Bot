// Plain helpers for the Create Bot form, kept free of React so tests can load them.

export function freshBotName(roster, base = 'New Bot') {
  const taken = new Set(roster.bots.map(bot => bot.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  let index = 2
  while (taken.has(`${base.toLowerCase()} ${index}`)) index += 1
  return `${base} ${index}`
}

// The form starts on the DSH default model when it is served, else the first one.
export function startModel(roster) {
  const models = roster.models ?? []
  return (models.find(model => model.ref === roster.defaultModel) ?? models[0])?.ref ?? ''
}

// The model is always sent: the host fixes it on the Bot at creation.
export function createPayload({ name, look, image, model, brief }) {
  const payload = { name, color: look.color, avatar: image ? { shape: look.shape, image } : { shape: look.shape } }
  if (model) payload.model = model
  if (brief) payload.brief = brief
  return payload
}
