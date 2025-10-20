import { fetchJson, missing } from '@riddance/fetch'
import { get, httpRequestHeaders } from '@riddance/service/http'

get('', async context => {
    return {
        body: await fetchJson(
            context.env.GREETING_BASE_URL ?? missing('GREETING_BASE_URL'),
            { headers: httpRequestHeaders(context) },
            'Error fetching greeter',
        ),
    }
})
