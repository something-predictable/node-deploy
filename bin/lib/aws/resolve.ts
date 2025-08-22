import { localAwsEnv, type LocalEnv } from './lite.js'
import { getApis } from './services/api-gateway.js'
import { getFunctions } from './services/lambda.js'

export class Resolver {
    readonly #env
    readonly #endpointCache: { [prefix: string]: Promise<{ [apiName: string]: string }> }

    constructor(prefix: string) {
        this.#env = localAwsEnv(undefined, prefix)
        this.#endpointCache = {}
    }

    async getEnvironment(prefix: string, service: string): Promise<{ [key: string]: string }> {
        const functions = await getFunctions(await this.#env, prefix, service)
        return Object.fromEntries(functions.flatMap(fn => Object.entries(fn.env)))
    }

    async getBaseUrl(prefix: string, service: string) {
        const cached = await (this.#endpointCache[prefix] ??= getServiceApis(this.#env, prefix))
        const name = `${prefix}-${service}`
        return cached[name]
    }
}

async function getServiceApis(env: Promise<LocalEnv>, prefix: string) {
    const serviceApis: { [name: string]: string } = {}
    for await (const api of getApis(await env, prefix)) {
        serviceApis[api.name] = `${api.apiEndpoint}/`
    }
    return serviceApis
}
