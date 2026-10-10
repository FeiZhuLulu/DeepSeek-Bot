// A stand-in for the plugin context that records what apply() registers, in order,
// without starting any service.
export function fakeContext({ services = {} } = {}) {
  const calls = []
  const disposers = []
  const registeredTools = new Map()
  // Listeners by event name, in registration order.
  const listeners = new Map()
  const sections = new Map()
  const ctx = {
    calls,
    registeredTools,
    listeners,
    sections,
    logger: { warn() {}, info() {} },
    get: name => services[name],
    on(name, listener, options) {
      calls.push(`on ${name}${options?.prepend ? ' (prepend)' : ''}`)
      listeners.set(name, [...(listeners.get(name) ?? []), listener])
      return () => {}
    },
    // Calls the plain listeners of an event; middleware (with `next`) is not run.
    emit(name, payload) {
      for (const listener of listeners.get(name) ?? []) {
        if (listener.length < 2) listener(payload)
      }
    },
    effect(execute, label) {
      calls.push(`effect ${label}`)
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose()
    },
    tools: {
      register(tool) {
        calls.push(`tool ${tool.name}`)
        registeredTools.set(tool.name, tool)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        calls.push(`prompt ${section.name} ${section.order}`)
        sections.set(section.name, section)
        return () => {}
      },
    },
    connection: {
      fetch: {
        register(route) {
          calls.push(`route ${route.methods.join(',')} ${route.path}`)
          return () => {}
        },
      },
    },
    llm: { listProviders: () => [] },
  }
  return ctx
}
