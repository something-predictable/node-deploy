import { on } from '@riddance/service/event'
import { setTimeout } from 'node:timers/promises'

on('status', 'greeting', async (_, subject) => {
    if (subject === 'error') {
        throw new Error('Bad subject.')
    }
    if (subject === 'slow') {
        await setTimeout(1_000_000)
    }
})
