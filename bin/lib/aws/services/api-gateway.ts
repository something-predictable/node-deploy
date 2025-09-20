import { jsonResponse, okResponse, throwOnNotOK } from '@riddance/fetch'
import { Reflection } from '@riddance/host/reflect'
import { isDeepStrictEqual } from 'node:util'
import { compare } from '../diff.js'
import { LocalEnv, awsRequest, retryConflict } from '../lite.js'

export async function syncGateway(
    env: LocalEnv,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    currentGateway: AwsGateway,
    reflection: Reflection,
    corsSites: string[],
) {
    if (currentGateway.api) {
        await syncGatewayApi(currentGateway.api, env, prefix, service, corsSites)
        await syncStage(env, prefix, service, currentGateway.api.apiId, currentGateway.stage)
        const { ids, surplus: surplusIntegrations } = await syncIntegrations(
            env,
            region,
            account,
            prefix,
            service,
            currentGateway.api.apiId,
            currentGateway.integrations,
            reflection,
        )
        const integrationIdByName = Object.fromEntries(ids)
        const nameByTarget = Object.fromEntries(
            ids.map(([name, integrationId]) => [`integrations/${integrationId}`, name]),
        )

        const { missing, surplus, existing } = compare(
            reflection.http,
            currentGateway.routes.map(r => ({
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                name: nameByTarget[r.target]!,
                ...r,
            })),
        )
        await Promise.all(surplus.map(i => deleteRoute(env, currentGateway.api.apiId, i)))
        await Promise.all([
            ...missing.map(fn =>
                createRoute(
                    env,
                    currentGateway.api.apiId,
                    asRoute(integrationIdByName[fn.name], fn),
                ),
            ),
            ...existing.map(async ({ name, routeId, ...ex }) => {
                // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                const fn = reflection.http.find(f => f.name === name)!
                const route = asRoute(integrationIdByName[fn.name], fn)
                if (isDeepStrictEqual(ex, route)) {
                    return
                }
                await updateRoute(env, currentGateway.api.apiId, routeId, route)
            }),
        ])
        await Promise.all(
            surplusIntegrations.map(i =>
                deleteIntegration(env, region, account, currentGateway.api.apiId, i.integrationId),
            ),
        )
        return currentGateway.api.apiId
    } else {
        const gateway = await createGateway(env, prefix, service, corsSites)
        const ids = await Promise.all(
            reflection.http.map(fn =>
                createIntegration(
                    env,
                    gateway.apiId,
                    fn.name,
                    asIntegration(region, account, prefix, service, fn),
                ),
            ),
        )
        const integrationIdByName = Object.fromEntries(ids)
        await Promise.all(
            reflection.http.map(fn =>
                createRoute(env, gateway.apiId, asRoute(integrationIdByName[fn.name], fn)),
            ),
        )
        return gateway.apiId
    }
}

async function syncIntegrations(
    env: LocalEnv,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    apiId: string,
    currentIntegrations: (AwsIntegration & { name: string; integrationId: string })[],
    reflection: Reflection,
) {
    const { missing, surplus, existing } = compare(reflection.http, currentIntegrations)
    const ids = await Promise.all([
        ...missing.map(fn =>
            createIntegration(
                env,
                apiId,
                fn.name,
                asIntegration(region, account, prefix, service, fn),
            ),
        ),
        ...existing.map(async ({ name, integrationId, ...ex }) => {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const fn = reflection.http.find(f => f.name === name)!
            const integration = asIntegration(region, account, prefix, service, fn)
            if (isDeepStrictEqual(ex, integration)) {
                return [name, integrationId] as [string, string]
            }
            await updateIntegration(env, apiId, integrationId, integration)
            return [name, integrationId] as [string, string]
        }),
    ])
    return { ids, surplus }
}

type AwsGateway = Awaited<ReturnType<typeof getApi>>

export type AwsGatewayApi = {
    apiId: string
    name: string
    protocolType: 'HTTP' | 'REST'
    apiEndpoint: string
    corsConfiguration: {
        allowOrigins: string[]
        allowCredentials: false
        maxAge: number
        allowMethods: string[]
        allowHeaders: string[]
        exposeHeaders: string[]
    }
}

export async function* getApis(env: LocalEnv, prefix: string) {
    for (let next = ''; ; ) {
        const page = await jsonResponse<{ items: AwsGatewayApi[]; nextToken?: string }>(
            awsRequest(env, 'GET', 'apigateway', `/v2/apis/${next}`),
            'Error getting APIs.',
        )
        for (const item of page.items.filter(a => a.name.startsWith(`${prefix}-`))) {
            yield item
        }
        if (!page.nextToken) {
            break
        }
        next = `?nextToken=${encodeURIComponent(page.nextToken)}`
    }
}

export async function getApi(env: LocalEnv, prefix: string, service: string) {
    const name = `${prefix}-${service}`
    for await (const api of getApis(env, prefix)) {
        if (api.name === name) {
            const [integrations, routes, stage] = await Promise.all([
                getIntegrations(env, api.apiId, name.length + 1),
                getRoutes(env, api.apiId),
                getStage(env, api.apiId),
            ])
            return { api, integrations, routes: routes.items, stage }
        }
    }
    return { integrations: [], routes: [] }
}

export type AwsIntegration = {
    payloadFormatVersion: '2.0'
    integrationType: 'AWS_PROXY'
    integrationMethod: string
    integrationUri: string
    connectionType: 'INTERNET'
    timeoutInMillis: number | undefined
}

async function getIntegrations(env: LocalEnv, apiId: string, prefixLength: number) {
    const { items } = await jsonResponse<{
        items: (AwsIntegration & { integrationId: string })[]
    }>(
        awsRequest(env, 'GET', 'apigateway', `/v2/apis/${apiId}/integrations`),
        'Error getting API integrations.',
    )
    return items.map(i => ({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        name: i.integrationUri.split(':').at(-1)!.slice(prefixLength),
        ...i,
    }))
}

function asIntegration(
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    fn: { name: string; method: string; pathPattern: string; config: { timeout?: number } },
): AwsIntegration {
    if (!region || !account) {
        throw new Error('Weird')
    }
    return {
        payloadFormatVersion: '2.0',
        integrationType: 'AWS_PROXY',
        integrationMethod: fn.method,
        integrationUri: `arn:aws:lambda:${region}:${account}:function:${prefix}-${service}-${fn.name}`,
        connectionType: 'INTERNET',
        timeoutInMillis: Math.min(((fn.config.timeout ?? 15) + 5) * 1000, 30_000),
    }
}

async function createIntegration(
    env: LocalEnv,
    apiId: string,
    name: string,
    integration: AwsIntegration,
) {
    console.log('creating API integration')
    const created = await retryConflict(() =>
        jsonResponse<{ integrationId: string }>(
            awsRequest(env, 'POST', 'apigateway', `/v2/apis/${apiId}/integrations`, integration),
            'Error creating API integration.',
        ),
    )
    console.log(`  from ${apiId} to ${integration.integrationUri} as ${created.integrationId}`)
    return [name, created.integrationId] as [string, string]
}

async function updateIntegration(
    env: LocalEnv,
    apiId: string,
    id: string,
    integration: AwsIntegration,
) {
    console.log('updating API integration ' + id)
    console.log(`  from ${apiId} to ${integration.integrationUri}`)
    await okResponse(
        awsRequest(env, 'PATCH', 'apigateway', `/v2/apis/${apiId}/integrations/${id}`, integration),
        'Error updating API integration',
    )
}

async function deleteIntegration(
    env: LocalEnv,
    region: string | undefined,
    account: string | undefined,
    apiId: string,
    id: string,
) {
    if (!region || !account) {
        throw new Error('Weird')
    }
    console.log('deleting API integration ' + id)
    await okResponse(
        awsRequest(env, 'DELETE', 'apigateway', `/v2/apis/${apiId}/integrations/${id}`),
        'Error deleting API integration.',
    )
}

export type AwsRoute = {
    routeKey: string
    authorizationType: 'NONE'
    apiKeyRequired: false
    target: string
}

function asRoute(
    integrationId: string | undefined,
    fn: { method: 'GET' | 'PATCH' | 'PUT' | 'POST' | 'DELETE'; pathPattern: string },
): AwsRoute {
    if (!integrationId) {
        throw new Error(`Weird: no integration ID for ${fn.method} ${fn.pathPattern}`)
    }
    let p = 0
    return {
        routeKey: `${fn.method} /${trimTrailingSlash(
            fn.pathPattern.replaceAll('*', () => `{p${++p}}`),
        )}`,
        authorizationType: 'NONE',
        apiKeyRequired: false,
        target: `integrations/${integrationId}`,
    }
}

function trimTrailingSlash(pathPattern: string) {
    if (pathPattern.endsWith('/')) {
        return pathPattern.slice(0, Math.max(0, pathPattern.length - 1))
    }
    return pathPattern
}

async function getRoutes(env: LocalEnv, apiId: string) {
    return await jsonResponse<{
        items: (AwsRoute & { routeId: string })[]
    }>(
        awsRequest(env, 'GET', 'apigateway', `/v2/apis/${apiId}/routes`),
        'Error getting API routes.',
    )
}

async function createRoute(env: LocalEnv, apiId: string, route: AwsRoute) {
    console.log(`creating route ${route.routeKey} to ${route.target}`)
    await retryConflict(() =>
        okResponse(
            awsRequest(env, 'POST', 'apigateway', `/v2/apis/${apiId}/routes`, route),
            'Error creating API route.',
        ),
    )
}

async function updateRoute(env: LocalEnv, apiId: string, id: string, route: AwsRoute) {
    console.log(`updating API route ${id} to ${route.target}`)
    await okResponse(
        awsRequest(env, 'PATCH', 'apigateway', `/v2/apis/${apiId}/routes/${id}`, route),
        'Error updating API route.',
    )
}

async function deleteRoute(env: LocalEnv, apiId: string, route: AwsRoute & { routeId: string }) {
    console.log(`deleting API route ${route.routeId} from ${route.target}`)
    await okResponse(
        awsRequest(env, 'DELETE', 'apigateway', `/v2/apis/${apiId}/routes/${route.routeId}`),
        'Error deleting API route.',
    )
}

async function createGateway(env: LocalEnv, prefix: string, service: string, corsSites: string[]) {
    console.log('creating gateway')
    const gateway = await jsonResponse<{ apiId: string }>(
        awsRequest(env, 'POST', 'apigateway', `/v2/apis/`, {
            name: `${prefix}-${service}`,
            protocolType: 'HTTP',
            corsConfiguration: corsSettings(corsSites),
            tags: {
                framework: 'riddance',
                environment: prefix,
                service,
            },
        }),
        'Error creating gateway.',
    )
    await syncStage(env, prefix, service, gateway.apiId, undefined)
    return gateway
}

async function syncGatewayApi(
    gateway: AwsGatewayApi,
    env: LocalEnv,
    prefix: string,
    service: string,
    corsSites: string[],
) {
    const corsConfiguration = corsSettings(corsSites)
    if (isDeepStrictEqual(corsConfiguration, gateway.corsConfiguration)) {
        return
    }
    console.log('updating gateway')
    await okResponse(
        awsRequest(env, 'PATCH', 'apigateway', `/v2/apis/${gateway.apiId}`, {
            name: `${prefix}-${service}`,
            protocolType: 'HTTP',
            corsConfiguration,
            tags: {
                framework: 'riddance',
                environment: prefix,
                service,
            },
        }),
        'Error updating gateway.',
    )
}

function corsSettings(corsSites: string[]) {
    return {
        allowOrigins: corsSites,
        allowCredentials: !isDeepStrictEqual(corsSites, ['*']),
        maxAge: 600,
        allowMethods: ['*'],
        allowHeaders: ['*'],
        exposeHeaders: ['*'],
    }
}

export type ApiStage = {
    stageName: string
    description: string
    deploymentId: string
    clientCertificateId: string
    defaultRouteSettings: {
        detailedMetricsEnabled: boolean
        loggingLevel: 'INFO' | 'ERROR' | 'OFF'
        dataTraceEnabled: boolean
        throttlingBurstLimit: number
        throttlingRateLimit: number
    }
    routeSettings: { [key: string]: string }
    stageVariables: { [key: string]: string }
    accessLogSettings: {
        format: string
        destinationArn: string
    }
    autoDeploy: boolean
    lastDeploymentStatusMessage: string
    createdDate: string
    lastUpdatedDate: string
    tags: { [key: string]: string }
    apiGatewayManaged: boolean
}

async function getStage(env: LocalEnv, apiId: string) {
    const response = await awsRequest(env, 'GET', 'apigateway', `/v2/apis/${apiId}/stages/$default`)
    if (response.status === 404) {
        return undefined
    }
    await throwOnNotOK(response, 'Error getting API stage.')
    return (await response.json()) as ApiStage
}

async function syncStage(
    env: LocalEnv,
    prefix: string,
    service: string,
    apiId: string,
    stage: ApiStage | undefined,
) {
    if (!stage) {
        await okResponse(
            awsRequest(env, 'POST', 'apigateway', `/v2/apis/${apiId}/stages`, {
                stageName: '$default',
                autoDeploy: true,
                tags: {
                    framework: 'riddance',
                    environment: prefix,
                    service,
                },
            }),
            'Error creating stage.',
        )
    }
}
