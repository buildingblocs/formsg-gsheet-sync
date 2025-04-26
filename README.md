# formsg-gsheet-sync
Sync your FormSG responses with Google Sheets

This is a Express.js app which you can deploy on FLy.io, Render, etc. May be able to get it running on Netlify FUnctions/Lambda with a bit of work

You'll need to create a new project in Google Cloud, create a service account and grab the json, and enable the Google Sheet API. Share the google sheet with your service account with edit access. Then, import your json in line 13

We are using development keys since we are running FormSG self-hosted, but if you're using the government-hosted FormSG, you should change it to production in line 9 of server.js

Once you're done, set up your config.js file by providing the secret key, sheet id, and the sheet name. Then, get it hosted somewhere and get the domain. The webhook link is https://<your-domain>/1 for the first entry, /2 for second entry, etc. Sheet ID can be grabbed from the URL between d/ and /edit