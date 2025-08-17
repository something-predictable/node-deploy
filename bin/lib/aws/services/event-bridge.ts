import { jsonResponse } from '@riddance/fetch'
import type { Reflection } from '@riddance/host/reflect'
import { awsRequest, type LocalEnv } from '../lite.js'

export async function syncEventBridge(
    env: LocalEnv,
    region: string | undefined,
    account: string | undefined,
    prefix: string,
    service: string,
    reflection: Reflection,
) {
    await Promise.all(
        reflection.timers.map(async fn => {
            const fullName = `${prefix}-${service}-${fn.name}`
            await createRule(env, region, account, prefix, fn.name, service, fullName, fn.schedule)
            await createTarget(env, region, account, fn.name, fullName)
        }),
    )
}

async function createRule(
    env: LocalEnv,
    _region: string | undefined,
    _account: string | undefined,
    prefix: string,
    name: string,
    service: string,
    fullName: string,
    schedule: string,
) {
    console.log(`creating event bridge rule ${name} for ${schedule}`)
    const r = await jsonResponse<{ RuleArn: string }>(
        awsRequest(
            env,
            'POST',
            'events',
            '',
            {
                Name: fullName,
                ScheduleExpression: scheduleExpression(schedule),
                Tags: [
                    { Key: 'framework', Value: 'riddance' },
                    { Key: 'environment', Value: prefix },
                    { Key: 'service', Value: service },
                ],
            },
            'AWSEvents.PutRule',
            'application/x-amz-json-1.1',
        ),
        'Error creating event bridge schedule.',
    )
    if (!r.RuleArn) {
        throw new Error('Unexpected schedule rule response')
    }
}

async function createTarget(
    env: LocalEnv,
    region: string | undefined,
    account: string | undefined,
    name: string,
    fullName: string,
) {
    console.log(`creating event bridge target ${name}`)
    const r = await jsonResponse<{ FailedEntryCount: number }>(
        awsRequest(
            env,
            'POST',
            'events',
            '',
            {
                Rule: fullName,
                Targets: [
                    {
                        Id: fullName,
                        Arn: `arn:aws:lambda:${region}:${account}:function:${fullName}`,
                    },
                ],
            },
            'AWSEvents.PutTargets',
            'application/x-amz-json-1.1',
        ),
        'Error creating event bridge schedule.',
    )
    if (r.FailedEntryCount !== 0) {
        throw new Error('Unexpected schedule rule response')
    }
}

function scheduleExpression(schedule: string) {
    const [min, h, dom, m, dow] = schedule.split(' ')
    return `cron(${min} ${h} ${dom} ${m} ${dow?.replace('*', '?')} *)`
}
