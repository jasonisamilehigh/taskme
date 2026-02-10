# 📞 Task Caller

An AI-powered voice task manager that:
- **Calls you every morning** with tasks due in the next 5 days from your Google Sheet
- **Lets you call in** to add tasks using natural speech — AI extracts task, priority, status, and due date

## Architecture

```
┌─────────────┐      ┌──────────────┐      ┌───────────────┐
│  Google      │◄────►│  Node.js /   │◄────►│   Twilio      │
│  Sheets      │      │  Express     │      │   Voice API   │
└─────────────┘      └──────┬───────┘      └───────┬───────┘
                            │                       │
                     ┌──────┴───────┐               │
                     │  Claude AI   │          ┌────┴────┐
                     │  (Sonnet)    │          │  Your   │
                     └──────────────┘          │  Phone  │
                                               └─────────┘
```

## Google Sheet Format

Your sheet **must** have a tab named `Tasks` with these columns:

| A (Task) | B (Priority) | C (Status) | D (Due Date) |
|----------|-------------|------------|--------------|
| Finish Q3 report | High | Not Started | 2025-02-10 |
| Review PRs | Medium | In Progress | 2025-02-08 |
| Team sync prep | Low | Not Started | 2025-02-11 |

- **Row 1** = Headers (the app reads from Row 2 onward)
- **Due Date** format: `YYYY-MM-DD` (the app parses this)
- **Status**: Tasks marked `Completed` or `Done` are excluded from morning calls
- **Priority**: `High`, `Medium`, `Low`

## Setup Guide

### 1. Google Sheets API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Enable the **Google Sheets API**
4. Go to **IAM & Admin → Service Accounts** → Create a service account
5. Create a JSON key for the service account — download it
6. From the JSON key, copy:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY`
7. **Share your Google Sheet** with the service account email (give it Editor access)
8. Copy the Sheet ID from the URL: `docs.google.com/spreadsheets/d/{SHEET_ID}/edit`

### 2. Twilio

1. Sign up at [twilio.com](https://www.twilio.com/)
2. Get a phone number with **Voice** capability
3. Copy your Account SID, Auth Token, and Twilio phone number
4. **Configure the Twilio phone number's webhook:**
   - Go to Phone Numbers → Your Number → Voice Configuration
   - Set "A Call Comes In" to: `https://your-app.replit.app/voice/inbound-speech`
   - Method: `POST`

### 3. Anthropic API

1. Get an API key from [console.anthropic.com](https://console.anthropic.com/)

### 4. Deploy on Railway

1. Push your code to a GitHub repo (or use Railway's CLI)
2. Go to [railway.app](https://railway.app/) → **New Project** → **Deploy from GitHub repo**
3. Add all environment variables in the **Variables** tab (see `.env.example`)
4. Make sure `BASE_URL` is set to your Railway app URL (e.g., `https://task-caller-production.up.railway.app`)
5. Railway auto-detects Node.js and runs `npm start` — no Dockerfile needed
6. Go to **Settings → Networking** → **Generate Domain** to get your public URL

### 5. Set the Twilio Webhook

Once your Railway app is deployed, go to your Twilio phone number settings and set the Voice webhook:
```
https://your-app-production.up.railway.app/voice/inbound-speech
```

## How It Works

### Morning Call (Outbound)
1. Cron fires at your configured time (default 7:00 AM MST)
2. App reads Google Sheet for tasks due in the next 5 days
3. Filters out completed tasks, sorts by priority then due date
4. Calls your phone via Twilio and reads the task list
5. After the briefing, you can press 1 to add a new task

### Add Task (Inbound)
1. You call your Twilio number
2. App greets you and asks you to describe the task
3. Twilio transcribes your speech
4. Claude AI extracts: task name, priority, status, due date
5. App reads it back for confirmation
6. On confirmation, writes a new row to Google Sheets
7. Asks if you want to add another task

### Example Voice Input
> "Add a task to review the implementation docs for Acme Bank, high priority, due next Friday"

Claude extracts:
```json
{
  "task": "Review implementation docs for Acme Bank",
  "priority": "High",
  "status": "Not Started",
  "dueDate": "2025-02-14"
}
```

## API Endpoints (for testing)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Health check |
| GET | `/test/tasks` | View upcoming tasks (JSON) |
| POST | `/test/morning-call` | Manually trigger a morning call |
| POST | `/test/add-task` | Add task via text: `{"text": "..."}` |

## Troubleshooting

- **No call received**: Check Twilio logs, verify `MY_PHONE_NUMBER` format (`+1XXXXXXXXXX`)
- **Sheet not reading**: Ensure the service account email has Editor access to your sheet
- **AI extraction wrong**: The AI handles relative dates well but double-check the confirmation readback
- **Railway sleeping**: Railway's Hobby plan keeps apps running 24/7. On the free trial, apps may sleep after inactivity — upgrade to Hobby ($5/mo) for always-on

## Cost Estimates

- **Twilio**: ~$0.013/min for outbound calls, ~$0.0085/min inbound + $1/mo for number
- **Claude API**: ~$0.003 per task extraction (Sonnet)
- **Google Sheets API**: Free
- **Railway**: Hobby plan $5/mo (includes $5 usage credit, always-on, custom domains)
