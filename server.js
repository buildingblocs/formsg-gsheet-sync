const express = require('express')
const { google } = require('googleapis')
const path = require('path')
const formConfig = require('./config')

const app = express()

const formsg = require('@opengovsg/formsg-sdk')({
  mode: 'development', // change to 'production' if using gov-hosted formsg
})

const auth = new google.auth.GoogleAuth({
  keyFile: path.join(__dirname, 'account.json'), // your service account JSON filename
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
})

const sheets = google.sheets({ version: 'v4', auth })

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


app.post(
  '/:formId',
  (req, res, next) => {
    const { formId } = req.params
    const config = formConfig[formId]

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

      console.error(decrypted)

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
