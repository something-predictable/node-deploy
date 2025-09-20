import type { Reflection } from '@riddance/host/reflect'
import { localAwsEnv } from './lite.js'
import { getApi, syncGateway } from './services/api-gateway.js'
import { syncEventBridge } from './services/event-bridge.js'
import { getFunctions, syncLambda } from './services/lambda.js'
import { assignPolicy, getRole, syncRole } from './services/roles.js'
import { syncTopics } from './services/sns.js'
import { syncTriggers } from './services/triggers.js'

export async function getCurrentState(prefix: string, service: string) {
    const env = await localAwsEnv(undefined, prefix)
    const [role, functions, apis] = await Promise.all([
        getRole(env, prefix, service),
        getFunctions(env, prefix, service),
        getApi(env, prefix, service),
    ])
    return { role, functions, apis }
}

export type CurrentState = Awaited<ReturnType<typeof getCurrentState>>

export async function sync(
    prefix: string,
    service: string,
    currentState: CurrentState,
    reflection: Reflection,
    publishTopics: string[],
    corsSites: string[],
    environment: { [key: string]: string },
    code: { [name: string]: string },
    provider: {
        aws?: { policyStatements: { Effect: string; Resource: string; Action: string[] }[] }
    },
) {
    const env = await localAwsEnv(undefined, prefix)
    const role = await syncRole(env, prefix, service, currentState.role)

    const fns = await syncLambda(
        env,
        prefix,
        currentState.functions,
        reflection,
        environment,
        role,
        code,
    )
    const [_arn, _aws, _lambda, region, account, _function, _name] = fns[0]?.id.split(':') ?? []
    if (!region || !account) {
        throw new Error('Weird')
    }

    await assignPolicy(
        env,
        prefix,
        service,
        region,
        account,
        publishTopics,
        provider.aws?.policyStatements ?? [],
    )

    const existingGatewayId = currentState.apis.api?.apiId
    if (existingGatewayId) {
        await syncTriggers(
            env,
            prefix,
            service,
            fns,
            reflection,
            region,
            account,
            existingGatewayId,
        )
    }

    const gatewayId =
        reflection.http.length === 0
            ? undefined
            : await syncGateway(
                  env,
                  region,
                  account,
                  prefix,
                  service,
                  currentState.apis,
                  reflection,
                  corsSites,
              )

    if (!existingGatewayId) {
        await syncTriggers(env, prefix, service, fns, reflection, region, account, gatewayId)
    }

    await syncTopics(env, fns, prefix, service, reflection, region, account)
    await syncEventBridge(env, region, account, prefix, service, reflection)

    return {
        region,
        host: gatewayId && `https://${gatewayId}.execute-api.eu-central-1.amazonaws.com/`,
    }
}
