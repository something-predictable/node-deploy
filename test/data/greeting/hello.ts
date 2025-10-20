import { get } from '@riddance/service/http'
import hello from './lib/hello.json' with { type: 'json' }

get('', async (context, request) => {
    if (request.url.searchParams.get('error') !== null) {
        await context.emit('status', 'greeting', 'error')
        await Promise.all([
            fetch('https://bd5a51c1f34a4eeb85692965529d437a.xyz'),
            fetch('https://056f480121074f6ab46c6a80ccfd58d9.xyz'),
        ])
    }

    context.log.enrich({ extra: 'stuff' })
    const who = request.url.searchParams.get('who') ?? 'World'
    const whose =
        request.url.searchParams.get('big') === null
            ? who
            : Array.from({ length: 100_000 })
                  .map(() => who)
                  .join(' & ')
    await context.emit('status', 'greeting', 'anonymous', { ...hello, whose })
    return {
        body: {
            message: `Hello from Riddance, ${whose}!`,
            revision: context.meta?.revision,
        },
    }
})
