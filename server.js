const express = require('express')
const { google } = require('googleapis')
const path = require('path')
const fs = require('fs')

const app = express()
const ADMIN_SECRET = process.env.ADMIN_SECRET

app.use(express.json({ limit: '2mb' }))

const CONFIG_PATH = path.join(__dirname, 'config.js')
const CONFIG_TMP_PATH = path.join(__dirname, 'config.tmp.js')

const formsg = require('@opengovsg/formsg-sdk')({
  mode: 'development', // change to 'prod' if using gov-hosted formsg
})

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'form.json'), // your service account JSON filename
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
})

const sheets = google.sheets({ version: 'v4', auth })

if (!ADMIN_SECRET) {
    console.warn('[WARN] ADMIN_SECRET is not set. /add will reject all requests until it is set.')
}

function ensureConfigFile() {
    if (!fs.existsSync(CONFIG_PATH)) {
        const bootstrap = 'module.exports = {\n}\n'
        fs.writeFileSync(CONFIG_PATH, bootstrap, 'utf8')
        console.log('[INIT] Created empty config.js')
    }
}

function loadConfig() {
    ensureConfigFile()
    try {
        delete require.cache[require.resolve('./config')]
    } catch (_) { }
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const obj = require('./config')
    if (!obj || typeof obj !== 'object') return {}
    return obj
}

function serializeConfig(obj) {
    const sortedEntries = Object.entries(obj).sort((a, b) => {
        const na = Number(a[0]); const nb = Number(b[0])
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
        return String(a[0]).localeCompare(String(b[0]))
    })
    const sorted = Object.fromEntries(sortedEntries)
    const body = JSON.stringify(sorted, null, 2)
    return `module.exports = ${body}\n`
}

async function saveConfig(obj) {
    const data = serializeConfig(obj)
    await fs.promises.writeFile(CONFIG_TMP_PATH, data, 'utf8')
    await fs.promises.rename(CONFIG_TMP_PATH, CONFIG_PATH)
}

async function appendToSheet(sheetId, sheetName, submission) {
  const row = [
    submission._id,
    submission.created,
    ...submission.responses.map((resp) => {
      if (Array.isArray(resp.answerArray)) {
        return resp.answerArray.join(', ')
      }
      return resp.answer ?? ''
    }),
  ]

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: `${sheetName}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [row],
    },
  })
}

let configStore = loadConfig()

app.post('/add', async (req, res) => {
    try {
        const provided = req.get('x-admin-secret') || req.body?.secret
        if (!ADMIN_SECRET || provided !== ADMIN_SECRET) {
            return res.status(401).json({ message: 'Unauthorized' })
        }

        const { formSecretKey, sheetId, sheetName } = req.body || {}
        let { id } = req.body || {}

        if (!formSecretKey || !sheetId || !sheetName) {
            return res.status(400).json({
                message: 'Missing required fields: formSecretKey, sheetId, sheetName',
            })
        }

        if (!id) {
            const numericKeys = Object.keys(configStore)
                .map((k) => Number(k))
                .filter((n) => !Number.isNaN(n))
            const next = numericKeys.length ? Math.max(...numericKeys) + 1 : 1
            id = String(next)
        } else {
            id = String(id)
            if (configStore[id]) {
                return res.status(409).json({ message: `ID ${id} already exists`, webhook: `/${id}` })
            }
        }

        const item = { formSecretKey: String(formSecretKey), sheetId: String(sheetId), sheetName: String(sheetName) }

        configStore[id] = item

        try {
            await saveConfig(configStore)
        } catch (e) {
            console.error('[CONFIG] Failed to persist config.js:', e)
            delete configStore[id]
            return res.status(500).json({ message: 'Failed to persist config' })
        }

        return res.status(201).json({ webhook: `/${id}` })
    } catch (err) {
        console.error('Add error:', err)
        return res.status(500).json({ message: 'Server error' })
    }
})

app.get('/:sheetId', (req, res) => {
    const { sheetId } = req.params

    const entry = Object.entries(configStore).find(([, cfg]) => cfg && String(cfg.sheetId) === String(sheetId))

    if (!entry) {
        return res.status(404).send({ message: 'Sheet ID not configured' })
    }

    const [id] = entry
    const idResponse = /^\d+$/.test(id) ? Number(id) : id

    return res.status(200).json({ id: idResponse })
})

app.post(
  '/:formId',
  (req, res, next) => {
    const { formId } = req.params
    const config = configStore[formId]

    if (!config) {
      return res.status(404).send({ message: 'Form ID not configured' })
    }

    try {
      const fullUri = `https://${req.get('host')}${req.originalUrl}`
      console.log('Full webhook URL:', fullUri)

      formsg.webhooks.authenticate(req.get('X-FormSG-Signature'), fullUri)
      req.formConfig = config
      return next()
    } catch (e) {
      console.error('Authentication error:', {
        message: e.message,
        stack: e.stack,
        name: e.name,
      })
      return res.status(401).send({ message: 'Unauthorized' })
    }
  },
  express.json(),
  async (req, res) => {
    const { formSecretKey, sheetId, sheetName } = req.formConfig

    try {
      const raw = req.body.data
      const decrypted = formsg.crypto.decrypt(formSecretKey, raw)

      if (!decrypted) {
        console.error('Decryption failed: No decrypted payload returned')
        return res.status(400).send({ message: 'Decryption failed' })
      }

      const submission = {
        _id: raw.submissionId,
        created: raw.created,
        ...decrypted,
      }

      // console.error(decrypted)

      await appendToSheet(sheetId, sheetName, submission)

      return res.status(200).send({ message: 'OK' })
    } catch (err) {
      console.error('Form submission error:', {
        message: err.message,
        stack: err.stack,
        name: err.name,
      })
      return res.status(500).send({ message: 'Server error' })
    }
  }
)

app.listen(8080, () => console.log('Server running on port 8080'))
