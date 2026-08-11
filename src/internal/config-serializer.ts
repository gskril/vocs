import type { Config } from './config.js'

export function serialize(config: Config): string {
  return JSON.stringify(serializeFunctions(config))
}

/** Serializes config as a JavaScript expression with callbacks embedded as code. */
export function serializeModule(config: Config): string {
  return toModuleExpression(serializeFunctions(config))
}

// biome-ignore lint/suspicious/noExplicitAny: _
function toModuleExpression(value: any): string {
  if (Array.isArray(value))
    return `[${value.map((item) => (item === undefined ? 'null' : toModuleExpression(item))).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).filter(
      ([, item]) => item !== undefined && typeof item !== 'symbol',
    )
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${toModuleExpression(item)}`)
      .join(',')}}`
  }
  if (typeof value === 'string' && value.startsWith('_vocs-fn_')) return `(${value.slice(9)})`
  return JSON.stringify(value) ?? 'undefined'
}

// biome-ignore lint/suspicious/noExplicitAny: _
export function serializeFunctions(value: any, key?: string): any {
  if (Array.isArray(value)) {
    return value.map((v) => serializeFunctions(v))
  }
  if (typeof value === 'object' && value !== null) {
    return Object.keys(value).reduce((acc, key) => {
      if (key[0] === '_') return acc
      acc[key] = serializeFunctions(value[key], key)
      return acc
      // biome-ignore lint/suspicious/noExplicitAny: _
    }, {} as any)
  }
  if (typeof value === 'function') {
    let serialized = value.toString()
    if (key && (serialized.startsWith(key) || serialized.startsWith(`async ${key}`))) {
      serialized = serialized.replace(key, 'function')
    }
    return `_vocs-fn_${serialized}`
  }
  return value
}

export function deserialize(config: string): Config {
  return deserializeFunctions(JSON.parse(config))
}

// biome-ignore lint/suspicious/noExplicitAny: _
export function deserializeFunctions(value: any): any {
  if (Array.isArray(value)) {
    return value.map(deserializeFunctions)
  }
  if (typeof value === 'object' && value !== null) {
    // biome-ignore lint/suspicious/noExplicitAny: _
    return Object.keys(value).reduce((acc: any, key) => {
      acc[key] = deserializeFunctions(value[key])
      return acc
    }, {})
  }
  if (typeof value === 'string' && value.includes('_vocs-fn_')) {
    return new Function(`return ${value.slice(9)}`)()
  }
  return value
}

export const deserializeFunctionsStringified = `
  function deserializeFunctions(value) {
    if (Array.isArray(value)) {
      return value.map(deserializeFunctions)
    } else if (typeof value === 'object' && value !== null) {
      return Object.keys(value).reduce((acc, key) => {
        acc[key] = deserializeFunctions(value[key])
        return acc
      }, {})
    } else if (typeof value === 'string' && value.includes('_vocs-fn_')) {
      return new Function(\`return \${value.slice(9)}\`)()
    } else {
      return value
    }
  }
`
