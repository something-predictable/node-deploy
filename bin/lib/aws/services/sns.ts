import { jsonResponse } from '@riddance/fetch'
import type { Reflection } from '@riddance/host/reflect'
import { awsFormRequest, type LocalEnv } from '../lite.js'

export async function syncTopics(
    env: LocalEnv,
    functions: { id: string; name: string }[],
    prefix: string,
    service: string,
    reflection: Reflection,
    region: string,
    account: string,
) {
    await Promise.all(
        reflection.events.map(async e => {
            const fullName = `${prefix}-${e.topic}-${e.type}`
            await createTopic(env, prefix, e.topic, e.type, fullName)
            const lambdaArn = functions.find(f => f.name === e.name)?.id ?? ''
            await subscribe(
                env,
                region,
                account,
                prefix,
                service,
                lambdaArn,
                e.topic,
                e.type,
                fullName,
            )
        }),
    )
}

async function createTopic(
    env: LocalEnv,
    prefix: string,
    name: string,
    type: string,
    fullName: string,
) {
    console.log(`creating ${name} topic for ${type}`)
    await jsonResponse(
        awsFormRequest(
            env,
            'POST',
            'sns',
            '',
            new URLSearchParams({
                Action: 'CreateTopic',
                Version: '2010-03-31',
                Name: fullName,
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': prefix,
            }),
        ),
        'Error creating topic.',
    )
}

async function subscribe(
    env: LocalEnv,
    region: string,
    account: string,
    prefix: string,
    service: string,
    lambdaArn: string,
    name: string,
    type: string,
    fullName: string,
) {
    console.log(`subscribing to ${name} ${type}`)
    await jsonResponse(
        awsFormRequest(
            env,
            'POST',
            'sns',
            '',
            new URLSearchParams({
                Action: 'Subscribe',
                Version: '2010-03-31',
                TopicArn: `arn:aws:sns:${region}:${account}:${fullName}`,
                Protocol: 'lambda',
                Endpoint: lambdaArn,
                'Tags.member.1.Key': 'framework',
                'Tags.member.1.Value': 'riddance',
                'Tags.member.2.Key': 'environment',
                'Tags.member.2.Value': prefix,
                'Tags.member.3.Key': 'service',
                'Tags.member.3.Value': service,
            }),
        ),
        'Error creating topic.',
    )
}
