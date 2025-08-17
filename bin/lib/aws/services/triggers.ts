import { jsonResponse, okResponse } from '@riddance/fetch'
import { Reflection } from '@riddance/host/reflect'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { LocalEnv, awsRequest, isNotFound } from '../lite.js'

export async function syncTriggers(
    env: LocalEnv,
    prefix: string,
    service: string,
    functions: { id: string; name: string }[],
    reflection: Reflection,
    region: string | undefined,
    account: string | undefined,
    apiGatewayId: string | undefined,
) {
    const currentTriggers = await getTriggers(env, prefix, service, functions)
    await Promise.all([
        ...reflection.http.map(async fn => {
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!apiGatewayId) {
                throw new Error('Need API Gateway for http triggers.')
            }
            if (!trigger) {
                const statement = makeApiGatewayStatementData(
                    region,
                    account,
                    apiGatewayId,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    fn,
                )
                await addTrigger(env, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeApiGatewayStatementData(
                region,
                account,
                apiGatewayId,
                trigger.id,
                fn,
            )
            await syncTrigger(trigger, statement, env, prefix, service, fn.name)
        }),
        ...reflection.timers.map(async fn => {
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!trigger) {
                const statement = makeEventBridgeStatementData(
                    region,
                    account,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    prefix,
                    service,
                )
                await addTrigger(env, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeEventBridgeStatementData(
                region,
                account,
                trigger.id,
                prefix,
                service,
            )
            await syncTrigger(trigger, statement, env, prefix, service, fn.name)
        }),
        ...reflection.events.map(async fn => {
            const trigger = currentTriggers.find(t => t.name === fn.name)
            if (!trigger) {
                const statement = makeSnsStatementData(
                    region,
                    account,
                    functions.find(f => f.name === fn.name)?.id ?? '',
                    prefix,
                    fn.topic,
                    fn.type,
                )
                await addTrigger(env, prefix, service, fn.name, randomUUID(), statement)
                return
            }
            const statement = makeSnsStatementData(
                region,
                account,
                trigger.id,
                prefix,
                fn.topic,
                fn.type,
            )
            await syncTrigger(trigger, statement, env, prefix, service, fn.name)
        }),
    ])
}

export type AwsTrigger = {
    id: string
    name: string
    config?: {
        method: string
        pathPattern: string
    }
    statements?: AwsStatement[]
}

type AwsStatement = {
    Sid: string
    Effect: string
    Principal: { Service: string }
    Action: string
    Resource: string
    Condition: unknown
}

async function syncTrigger(
    trigger: AwsTrigger,
    statement: StatementData,
    env: LocalEnv,
    prefix: string,
    service: string,
    name: string,
) {
    let exists = false
    if (trigger.statements) {
        for (const { Sid, ...data } of trigger.statements) {
            if (isDeepStrictEqual(data, statement)) {
                if (exists) {
                    await deleteTrigger(env, prefix, service, name, Sid)
                } else {
                    exists = true
                }
            } else {
                await deleteTrigger(env, prefix, service, name, Sid)
            }
        }
    }
    if (!exists) {
        await addTrigger(env, prefix, service, name, randomUUID(), statement)
    }
}

export async function getTriggers(
    env: LocalEnv,
    prefix: string,
    service: string,
    functions: { id: string; name: string }[],
): Promise<AwsTrigger[]> {
    return await Promise.all(
        functions.map(async fn => {
            try {
                return {
                    id: fn.id,
                    name: fn.name,
                    statements: (
                        JSON.parse(
                            (
                                await jsonResponse<{ Policy: string }>(
                                    awsRequest(
                                        env,
                                        'GET',
                                        'lambda',
                                        `/2015-03-31/functions/${prefix}-${service}-${fn.name}/policy/`,
                                    ),
                                    'Error getting triggers.',
                                )
                            ).Policy,
                        ) as { Statement: AwsStatement[] }
                    ).Statement,
                }
            } catch (e) {
                if (isNotFound(e)) {
                    return {
                        id: fn.id,
                        name: fn.name,
                    }
                }
                throw e
            }
        }),
    )
}

async function addTrigger(
    env: LocalEnv,
    prefix: string,
    service: string,
    name: string,
    id: string,
    statement: StatementData,
) {
    const arn = statement.Condition.ArnLike['AWS:SourceArn']
    console.log(`adding trigger ${id} to lambda ${name}`)
    console.log(`  from ${arn}`)
    await okResponse(
        awsRequest(
            env,
            'POST',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}/policy/`,
            {
                StatementId: id,
                Action: statement.Action,
                Principal: statement.Principal.Service,
                SourceArn: arn,
            },
        ),
        'Error adding triggers.',
    )
}

async function deleteTrigger(
    env: LocalEnv,
    prefix: string,
    service: string,
    name: string,
    id: string,
) {
    console.log(`deleting trigger ${id} from ${name}`)
    await okResponse(
        awsRequest(
            env,
            'DELETE',
            'lambda',
            `/2015-03-31/functions/${prefix}-${service}-${name}/policy/${id}`,
        ),
        'Error deleting triggers.',
    )
}

function makeApiGatewayStatementData(
    region: string | undefined,
    account: string | undefined,
    apiGatewayId: string,
    functionId: string,
    fn: {
        name: string
        method: string
        pathPattern: string
    },
) {
    let p = 0
    return makeStatementData(
        region,
        account,
        functionId,
        'apigateway.amazonaws.com',
        `arn:aws:execute-api:${region}:${account}:${apiGatewayId}/*/*/${trimTrailingSlash(
            fn.pathPattern.replaceAll('*', () => `{p${++p}}`),
        )}`,
    )
}

function makeEventBridgeStatementData(
    region: string | undefined,
    account: string | undefined,
    functionId: string,
    prefix: string,
    service: string,
) {
    return makeStatementData(
        region,
        account,
        functionId,
        'events.amazonaws.com',
        `arn:aws:events:${region}:${account}:rule/${prefix}-${service}-*`,
    )
}

function makeSnsStatementData(
    region: string | undefined,
    account: string | undefined,
    functionId: string,
    prefix: string,
    topic: string,
    type: string,
) {
    return makeStatementData(
        region,
        account,
        functionId,
        'sns.amazonaws.com',
        `arn:aws:sns:${region}:${account}:${prefix}-${topic}-${type}`,
    )
}

type StatementData = ReturnType<typeof makeStatementData>

function makeStatementData(
    region: string | undefined,
    account: string | undefined,
    functionId: string,
    service: string,
    source: string,
) {
    if (!region || !account) {
        throw new Error('Weird')
    }
    return {
        Action: 'lambda:InvokeFunction',
        Effect: 'Allow',
        Principal: {
            Service: service,
        },
        Resource: functionId,
        Condition: {
            ArnLike: {
                'AWS:SourceArn': source,
            },
        },
    }
}

function trimTrailingSlash(pathPattern: string) {
    if (pathPattern.endsWith('/')) {
        return pathPattern.slice(0, -1)
    }
    return pathPattern
}
