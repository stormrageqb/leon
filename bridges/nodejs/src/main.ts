import path from 'node:path'

import { INTENT_OBJECT } from '@bridge/constants'
;(async (): Promise<void> => {
  const {
    domain,
    skill,
    action,
    lang,
    utterance,
    current_entities: currentEntities,
    entities,
    current_resolvers: currentResolvers,
    resolvers,
    slots
  } = INTENT_OBJECT

  const params = {
    lang,
    utterance,
    currentEntities,
    entities,
    currentResolvers,
    resolvers,
    slots
  }

  try {
    const { [action]: actionFunction } = await import(
      path.join(
        process.cwd(),
        'skills',
        domain,
        skill,
        'src',
        'actions',
        `${action}.ts`
      )
    )

    await actionFunction(params)
  } catch (e) {
    console.error(`Error while running "${skill}" skill "${action}" action:`, e)
  }
})()
