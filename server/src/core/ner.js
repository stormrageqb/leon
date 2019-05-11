'use strict'

import { NerManager } from 'node-nlp'
import fs from 'fs'
import path from 'path'

import log from '@/helpers/log'
import string from '@/helpers/string'

class Ner {
  constructor () {
    this.nerManager = { }
    this.supportedEntityTypes = [
      'regex',
      'trim'
    ]

    log.title('NER')
    log.success('New instance')
  }

  static logExtraction (entities) {
    entities.forEach(ent => log.success(`{ value: ${ent.sourceText}, entity: ${ent.entity} }`))
  }

  /**
   * Grab action entities and match them with the query
   */
  extractActionEntities (lang, obj) {
    return new Promise(async (resolve, reject) => {
      log.title('NER')
      log.info('Searching for entities...')

      // Need to instanciate on the fly to flush entities
      this.nerManager = new NerManager()
      const { query, entities, classification } = obj
      const expressionsFilePath = path.join(__dirname, '../../../packages', classification.package, `data/expressions/${lang}.json`)
      const expressionsObj = JSON.parse(fs.readFileSync(expressionsFilePath, 'utf8'))
      const { module, action } = classification
      const promises = []

      // Verify the action has entities
      if (typeof expressionsObj[module][action].entities !== 'undefined') {
        const actionEntities = expressionsObj[module][action].entities

        /**
         * Browse action entities
         * Dynamic injection of the action entities depending of the entity type
         */
        for (let i = 0; i < actionEntities.length; i += 1) {
          const entity = actionEntities[i]

          if (!this.supportedEntityTypes.includes(entity.type)) {
            reject({ type: 'warning', obj: new Error(`"${entity.type}" action entity type not supported`), code: 'random_ner_type_not_supported', data: { '%entity_type%': entity.type } })
          } else if (entity.type === 'regex') {
            // TODO: regex case
          } else if (entity.type === 'trim') {
            promises.push(this.injectTrimEntity(lang, entity))
          }
        }

        await Promise.all(promises)

        const nerEntities = await this.nerManager.findEntities(query, lang)
        console.log('ner', nerEntities)
        Ner.logExtraction(nerEntities)

        resolve(nerEntities)
      } else {
        if (entities.length > 0) {
          Ner.logExtraction(entities)
        } else {
          log.info('No entity found')
        }

        resolve(entities)
      }
    })
  }

  /**
   * Inject trim type entities
   */
  injectTrimEntity (lang, entity) {
    return new Promise((resolve) => {
      console.log('addnamedentity', entity.name, entity.type)
      const e = this.nerManager.addNamedEntity(entity.name, entity.type)

      for (let j = 0; j < entity.conditions.length; j += 1) {
        const condition = entity.conditions[j]
        const conditionMethod = `add${string.snakeToPascalCase(condition.type)}Condition`

        if (condition.type === 'between') {
          // e.g. list.addBetweenCondition('en', 'create a', 'list')
          e[conditionMethod](lang, condition.from, condition.to)
        } else if (condition.type.indexOf('after') !== -1) {
          e[conditionMethod](lang, condition.from)
        } else if (condition.type.indexOf('before') !== -1) {
          e[conditionMethod](lang, condition.to)
        }
      }

      resolve()
    })
  }
}

export default Ner
