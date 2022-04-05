import { containerBootstrap } from '@nlpjs/core-loader'
import { Nlp } from '@nlpjs/nlp'
import { BuiltinMicrosoft } from '@nlpjs/builtin-microsoft'
import { LangAll } from '@nlpjs/lang-all'
import request from 'superagent'
import fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import kill from 'tree-kill'

import { langs } from '@@/core/langs.json'
import { version } from '@@/package.json'
import Ner from '@/core/ner'
import log from '@/helpers/log'
import string from '@/helpers/string'
import lang from '@/helpers/lang'
import TcpClient from '@/core/tcp-client'
import Conversation from '@/core/conversation'

const defaultNluResultObj = {
  utterance: null,
  entities: [],
  slots: null,
  nluDataFilePath: null,
  answers: [], // For dialog action type
  classification: {
    domain: null,
    skill: null,
    action: null,
    confidence: 0
  }
}

class Nlu {
  constructor (brain) {
    this.brain = brain
    this.request = request
    this.nlp = { }
    this.ner = { }
    this.conv = new Conversation('conv0')
    this.nluResultObj = defaultNluResultObj // TODO

    log.title('NLU')
    log.success('New instance')
  }

  /**
   * Load the NLP model from the latest training
   */
  loadModel (nlpModel) {
    return new Promise(async (resolve, reject) => {
      if (!fs.existsSync(nlpModel)) {
        log.title('NLU')
        reject({ type: 'warning', obj: new Error('The NLP model does not exist, please run: npm run train') })
      } else {
        log.title('NLU')

        try {
          const container = await containerBootstrap()

          container.register('extract-builtin-??', new BuiltinMicrosoft({
            builtins: Ner.getMicrosoftBuiltinEntities()
          }), true)
          container.use(Nlp)
          container.use(LangAll)

          this.nlp = container.get('nlp')
          const nluManager = container.get('nlu-manager')
          nluManager.settings.spellCheck = true

          await this.nlp.load(nlpModel)
          log.success('NLP model loaded')

          this.ner = new Ner(this.nlp.ner)

          resolve()
        } catch (err) {
          this.brain.talk(`${this.brain.wernicke('random_errors')}! ${this.brain.wernicke('errors', 'nlu', { '%error%': err.message })}.`)
          this.brain.socket.emit('is-typing', false)

          reject({ type: 'error', obj: err })
        }
      }
    })
  }

  /**
   * Classify the utterance,
   * pick-up the right classification
   * and extract entities
   * TODO: split this method into several methods
   */
  process (utterance, opts) {
    const processingTimeStart = Date.now()

    return new Promise(async (resolve, reject) => {
      log.title('NLU')
      log.info('Processing...')

      opts = opts || {
        mute: false // Close Leon mouth e.g. over HTTP
      }
      utterance = string.ucfirst(utterance)

      // TODO: method
      if (Object.keys(this.nlp).length === 0) {
        if (!opts.mute) {
          this.brain.talk(`${this.brain.wernicke('random_errors')}!`)
          this.brain.socket.emit('is-typing', false)
        }

        const msg = 'The NLP model is missing, please rebuild the project or if you are in dev run: npm run train'
        log.error(msg)
        return reject(msg)
      }

      // Add spaCy entities
      // TODO: method
      const spacyEntities = await Ner.getSpacyEntities(utterance)
      if (spacyEntities.length > 0) {
        spacyEntities.forEach(({ entity, resolution }) => {
          const spacyEntity = {
            [entity]: {
              options: {
                [resolution.value]: [resolution.value]
              }
            }
          }

          this.nlp.addEntities(spacyEntity, this.brain.lang)
        })
      }

      if (this.conv.hasActiveContext()) {
        const processedData = await this.slotFill(utterance, opts)
        if (processedData) {
          return resolve(processedData)
        }
      }

      const result = await this.nlp.process(utterance)
      // console.log('result', result)
      const {
        locale, domain, intent, score, answers
      } = result
      const [skillName, actionName] = intent.split('.')
      this.nluResultObj = {
        ...this.nluResultObj,
        utterance,
        answers, // For dialog action type
        classification: {
          domain,
          skill: skillName,
          action: actionName,
          confidence: score
        }
      }

      // Language isn't supported
      if (!lang.getShortLangs().includes(locale)) {
        this.brain.talk(`${this.brain.wernicke('random_language_not_supported')}.`, true)
        this.brain.socket.emit('is-typing', false)
        return resolve({ })
      }

      // Trigger language switch
      // TODO: method
      if (this.brain.lang !== locale) {
        const connectedHandler = async () => {
          await this.process(utterance)
        }

        this.brain.lang = locale
        this.brain.talk(`${this.brain.wernicke('random_language_switch')}.`, true)

        // Recreate a new TCP server process and reconnect the TCP client
        kill(global.tcpServerProcess.pid, () => {
          global.tcpServerProcess = spawn(`pipenv run python bridges/python/tcp_server/main.py ${locale}`, { shell: true })

          global.tcpClient = new TcpClient(
            process.env.LEON_PY_TCP_SERVER_HOST,
            process.env.LEON_PY_TCP_SERVER_PORT
          )

          global.tcpClient.ee.removeListener('connected', connectedHandler)
          global.tcpClient.ee.on('connected', connectedHandler)
        })

        // Do not continue the NLU process
        return resolve({ })
      }

      // TODO: method
      /* istanbul ignore next */
      if (process.env.LEON_LOGGER === 'true' && process.env.LEON_NODE_ENV !== 'testing') {
        this.request
          .post('https://logger.getleon.ai/v1/expressions')
          .set('X-Origin', 'leon-core')
          .send({
            version,
            utterance,
            lang: this.brain.lang,
            classification: this.nluResultObj.classification
          })
          .then(() => { /* */ })
          .catch(() => { /* */ })
      }

      if (intent === 'None') {
        // TODO: method
        const fallback = this.fallback(langs[lang.getLongCode(locale)].fallbacks)

        if (fallback === false) {
          if (!opts.mute) {
            this.brain.talk(`${this.brain.wernicke('random_unknown_intents')}.`, true)
            this.brain.socket.emit('is-typing', false)
          }

          log.title('NLU')
          const msg = 'Intent not found'
          log.warning(msg)

          const processingTimeEnd = Date.now()
          const processingTime = processingTimeEnd - processingTimeStart

          return resolve({
            processingTime,
            message: msg
          })
        }

        this.nluResultObj = fallback
      }

      log.title('NLU')
      log.success(`Intent found: ${this.nluResultObj.classification.skill}.${this.nluResultObj.classification.action} (domain: ${this.nluResultObj.classification.domain})`)

      const nluDataFilePath = join(process.cwd(), 'skills', this.nluResultObj.classification.domain, this.nluResultObj.classification.skill, `nlu/${this.brain.lang}.json`)
      this.nluResultObj.nluDataFilePath = nluDataFilePath

      try {
        this.nluResultObj.entities = await this.ner.extractEntities(
          this.brain.lang,
          nluDataFilePath,
          this.nluResultObj
        )
      } catch (e) /* istanbul ignore next */ {
        if (log[e.type]) {
          log[e.type](e.obj.message)
        }

        if (!opts.mute) {
          this.brain.talk(`${this.brain.wernicke(e.code, '', e.data)}!`)
        }
      }

      const shouldLoop = await this.routeSlotFilling(intent)
      if (shouldLoop) {
        return resolve({ })
      }

      // In case all slots have been filled in the first utterance
      if (this.conv.hasActiveContext()) {
        const processedData = await this.slotFill(utterance, opts)
        if (processedData) {
          return resolve(processedData)
        }
      }

      const newContextName = `${this.nluResultObj.classification.domain}.${skillName}`
      if (this.conv.activeContext.name !== newContextName) {
        this.conv.cleanActiveContext()
      }
      this.conv.activeContext = {
        lang: this.brain.lang,
        slots: { },
        originalUtterance: this.nluResultObj.utterance,
        nluDataFilePath: this.nluResultObj.nluDataFilePath,
        actionName: this.nluResultObj.classification.action,
        domain: this.nluResultObj.classification.domain,
        intent,
        entities: this.nluResultObj.entities
      }
      // Pass context entities to the NLU result object
      this.nluResultObj.entities = this.conv.activeContext.entities

      // console.log('this.conv.activeContext', this.conv.activeContext)

      try {
        const data = await this.brain.execute(this.nluResultObj, { mute: opts.mute })
        const processingTimeEnd = Date.now()
        const processingTime = processingTimeEnd - processingTimeStart

        return resolve({
          processingTime, // In ms, total time
          ...data,
          nluProcessingTime:
            processingTime - data?.executionTime // In ms, NLU processing time only
        })
      } catch (e) /* istanbul ignore next */ {
        log[e.type](e.obj.message)

        if (!opts.mute) {
          this.brain.socket.emit('is-typing', false)
        }

        return reject(e.obj)
      }
    })
  }

  /**
   * Build NLU data result object based on slots
   * and ask for more entities if necessary
   */
  async slotFill (utterance, opts) {
    if (!this.conv.activeContext.nextAction) {
      return null
    }

    const { domain, intent } = this.conv.activeContext
    const [skillName, actionName] = intent.split('.')
    const nluDataFilePath = join(process.cwd(), 'skills', domain, skillName, `nlu/${this.brain.lang}.json`)

    this.nluResultObj = {
      ...this.nluResultObj,
      utterance,
      classification: {
        domain,
        skill: skillName,
        action: actionName
      }
    }
    const entities = await this.ner.extractEntities(
      this.brain.lang,
      nluDataFilePath,
      this.nluResultObj
    )

    // Continue to loop for questions if a slot has been filled correctly
    let notFilledSlot = this.conv.getNotFilledSlot()
    if (notFilledSlot && entities.length > 0) {
      const hasMatch = entities.some(({ entity }) => entity === notFilledSlot.expectedEntity)

      if (hasMatch) {
        this.conv.setSlots(this.brain.lang, entities)

        notFilledSlot = this.conv.getNotFilledSlot()
        if (notFilledSlot && entities.length > 0) {
          this.brain.talk(notFilledSlot.pickedQuestion)
          this.brain.socket.emit('is-typing', false)

          return { }
        }
      }
    }

    if (!this.conv.areSlotsAllFilled()) {
      this.brain.talk(`${this.brain.wernicke('random_context_out_of_topic')}.`)
    } else {
      /**
       * TODO:
       * 1. [OK] Extract entities from utterance
       * 2. [OK] If none of them match any slot in the active context, then continue
       * 3. [OK] If an entity match slot in active context, then fill it
       * 4. [OK] Move skill type to action type
       * 5.1 [OK] In Conversation, need to chain output/input contexts to each other
       * to understand what action should be next
       * 5.2 [OK] Execute next action (based on input_context?)
       * 5.3 [OK] Need to handle the case if a context is filled in one shot
       * e.g. I wanna play with 2 players and louis.grenard@gmail.com
       * Need to refactor now (nluResultObj method to build it, etc.)
       * 6. What's next once the next action has been executed?
       * 7. Handle a "loop" feature from action (guess the number)
       * No need "loop" in the NLU skill config. Just add option in util output
       * 8. Split this process() method into several ones + clean nlu.js and brain.js
       * 9. Add logs in terminal about context switching, active context, etc.
       */

      this.nluResultObj = {
        ...this.nluResultObj,
        // Assign slots only if there is a next action
        slots: this.conv.activeContext.nextAction ? this.conv.activeContext.slots : { },
        utterance: this.conv.activeContext.originalUtterance,
        nluDataFilePath,
        classification: {
          domain,
          skill: skillName,
          /**
           * Use the next action if it is defined via the skill NLU config
           * or take the classified action
           */
          action: this.conv.activeContext.nextAction,
          confidence: 1
        }
      }

      this.conv.cleanActiveContext()

      const data = await this.brain.execute(this.nluResultObj, { mute: opts.mute })
      // If it is a loop action

      // TODO: remove this
      data.loop = true
      return data
    }

    this.conv.cleanActiveContext()
    return null
  }

  /**
   * Decide what to do with slot filling.
   * 1. Activate context
   * 2. If the context is expecting slots, then loop over questions to slot fill
   * 3. Or go to the brain executor if all slots have been filled in one shot
   */
  async routeSlotFilling (intent) {
    const slots = await this.nlp.slotManager.getMandatorySlots(intent)
    const hasMandatorySlots = Object.keys(slots)?.length > 0

    if (hasMandatorySlots) {
      this.conv.activeContext = {
        lang: this.brain.lang,
        slots,
        originalUtterance: this.nluResultObj.utterance,
        nluDataFilePath: this.nluResultObj.nluDataFilePath,
        actionName: this.nluResultObj.classification.action,
        domain: this.nluResultObj.classification.domain,
        intent,
        entities: this.nluResultObj.entities
      }

      const notFilledSlot = this.conv.getNotFilledSlot()
      // Loop for questions if a slot hasn't been filled
      if (notFilledSlot) {
        this.brain.talk(notFilledSlot.pickedQuestion)
        this.brain.socket.emit('is-typing', false)

        return true
      }
    }

    return false
  }

  /**
   * Pickup and compare the right fallback
   * according to the wished skill action
   */
  fallback (fallbacks) {
    const words = this.nluResultObj.utterance.toLowerCase().split(' ')

    if (fallbacks.length > 0) {
      log.info('Looking for fallbacks...')
      const tmpWords = []

      for (let i = 0; i < fallbacks.length; i += 1) {
        for (let j = 0; j < fallbacks[i].words.length; j += 1) {
          if (words.includes(fallbacks[i].words[j]) === true) {
            tmpWords.push(fallbacks[i].words[j])
          }
        }

        if (JSON.stringify(tmpWords) === JSON.stringify(fallbacks[i].words)) {
          this.nluResultObj.entities = []
          this.nluResultObj.classification.domain = fallbacks[i].domain
          this.nluResultObj.classification.skill = fallbacks[i].skill
          this.nluResultObj.classification.action = fallbacks[i].action
          this.nluResultObj.classification.confidence = 1

          log.success('Fallback found')
          return this.nluResultObj
        }
      }
    }

    return false
  }
}

export default Nlu
