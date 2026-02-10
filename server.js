import express from 'express';
import twilio from 'twilio';
import { google } from 'googleapis';
import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIGURATION
// ============================================================
const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  MY_PHONE_NUMBER,
  GOOGLE_SHEETS_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  ANTHROPIC_API_KEY,
  MORNING_CALL_TIME = '07:00',
  BASE_URL, // Your Replit URL, e.g. https://your-app.replit.app
} = process.env;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const VoiceResponse = twilio.twiml.VoiceResponse;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Google Sheets Auth
const auth = new google.auth.JWT(
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  null,
  GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

// Sheet config - adjust if your columns differ
const SHEET_NAME = 'Tasks';
const COLUMNS = {
  TASK: 'A',
  PRIORITY: 'B',
  STATUS: 'C',
  DUE_DATE: 'D',
};

// ============================================================
// GOOGLE SHEETS HELPERS
// ============================================================

/**
 * Read all tasks from the sheet
 */
async function readTasks() {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${SHEET_NAME}!A2:D`,
    });
    const rows = response.data.values || [];
    return rows.map((row, index) => ({
      rowIndex: index + 2,
      task: row[0] || '',
      priority: row[1] || 'Medium',
      status: row[2] || 'Not Started',
      dueDate: row[3] || '',
    }));
  } catch (err) {
    console.error('Error reading tasks:', err.message);
    return [];
  }
}

/**
 * Get tasks due within the next N days that aren't completed
 */
async function getUpcomingTasks(days = 5) {
  const tasks = await readTasks();
  const now = new Date();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + days);

  return tasks.filter((t) => {
    if (t.status.toLowerCase() === 'completed' || t.status.toLowerCase() === 'done') {
      return false;
    }
    if (!t.dueDate) return false;
    const due = new Date(t.dueDate);
    return due >= now && due <= cutoff;
  }).sort((a, b) => {
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    const pA = priorityOrder[a.priority.toLowerCase()] ?? 1;
    const pB = priorityOrder[b.priority.toLowerCase()] ?? 1;
    if (pA !== pB) return pA - pB;
    return new Date(a.dueDate) - new Date(b.dueDate);
  });
}

/**
 * Add a new task to the sheet
 */
async function addTask({ task, priority, status, dueDate }) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${SHEET_NAME}!A:D`,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[task, priority, status, dueDate]],
      },
    });
    console.log(`✅ Task added: "${task}" | ${priority} | ${status} | ${dueDate}`);
    return true;
  } catch (err) {
    console.error('Error adding task:', err.message);
    return false;
  }
}

// ============================================================
// CLAUDE AI - EXTRACT TASK FROM NATURAL LANGUAGE
// ============================================================

async function extractTaskFromSpeech(transcript) {
  const today = new Date().toISOString().split('T')[0];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: `You are a task extraction assistant. Extract task details from the user's spoken input.
Today's date is ${today}.

Return ONLY valid JSON with these fields:
- task: string (the task description)
- priority: "High" | "Medium" | "Low" (default Medium if not mentioned)
- status: "Not Started" (always default to this)
- dueDate: string in YYYY-MM-DD format (interpret relative dates like "next Wednesday", "tomorrow", "in 3 days" etc.)

If you cannot determine a due date, use 7 days from today.
If the input doesn't seem like a task, return: {"error": "Could not understand task"}`,
    messages: [
      {
        role: 'user',
        content: `Extract the task from this spoken input: "${transcript}"`,
      },
    ],
  });

  const text = response.content[0].text.trim();
  // Extract JSON from response (handle markdown code blocks)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]);
  }
  throw new Error('Could not parse AI response');
}

// ============================================================
// OUTBOUND MORNING CALL
// ============================================================

async function makeMorningCall() {
  console.log('☀️ Starting morning call...');

  try {
    const tasks = await getUpcomingTasks(5);

    if (tasks.length === 0) {
      console.log('No upcoming tasks — skipping call.');
      return;
    }

    const call = await twilioClient.calls.create({
      to: MY_PHONE_NUMBER,
      from: TWILIO_PHONE_NUMBER,
      url: `${BASE_URL}/voice/morning-briefing`,
      method: 'POST',
    });

    console.log(`📞 Morning call initiated: ${call.sid}`);
  } catch (err) {
    console.error('Error making morning call:', err.message);
  }
}

// Twilio webhook for morning briefing TwiML
app.post('/voice/morning-briefing', async (req, res) => {
  const twiml = new VoiceResponse();
  const tasks = await getUpcomingTasks(5);

  if (tasks.length === 0) {
    twiml.say(
      { voice: 'Polly.Matthew' },
      'Good morning Jason! You have no tasks due in the next 5 days. Have a great day!'
    );
    twiml.hangup();
  } else {
    let message = `Good morning Jason! You have ${tasks.length} task${tasks.length > 1 ? 's' : ''} coming up in the next 5 days. Here's your rundown. `;

    tasks.forEach((t, i) => {
      const dueDate = new Date(t.dueDate);
      const dayName = dueDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      message += `Task ${i + 1}: ${t.task}. Priority: ${t.priority}. Due: ${dayName}. Status: ${t.status}. `;
    });

    message += 'That\'s your lineup. Go crush it today!';

    twiml.say({ voice: 'Polly.Matthew' }, message);

    // Option to add a task after hearing the briefing
    const gather = twiml.gather({
      numDigits: 1,
      action: `${BASE_URL}/voice/morning-choice`,
      method: 'POST',
      timeout: 5,
    });
    gather.say(
      { voice: 'Polly.Matthew' },
      'Press 1 if you\'d like to add a new task, or just hang up to go about your day.'
    );

    twiml.say({ voice: 'Polly.Matthew' }, 'Alright, have a productive day Jason!');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.post('/voice/morning-choice', (req, res) => {
  const twiml = new VoiceResponse();
  const digit = req.body.Digits;

  if (digit === '1') {
    twiml.say(
      { voice: 'Polly.Matthew' },
      'Tell me about the task you\'d like to add. Include the task name, priority if you have one, and when it\'s due.'
    );
    twiml.record({
      action: `${BASE_URL}/voice/process-task`,
      method: 'POST',
      maxLength: 30,
      transcribe: true,
      transcribeCallback: `${BASE_URL}/voice/transcription-callback`,
      playBeep: true,
      timeout: 3,
    });
  } else {
    twiml.say({ voice: 'Polly.Matthew' }, 'Have a great day!');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// ============================================================
// INBOUND CALL - ADD TASKS
// ============================================================

app.post('/voice/inbound', (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say(
    { voice: 'Polly.Matthew' },
    'Hey Jason! Ready to add a task. Tell me the task, priority, and due date after the beep. For example, say: Finish the Q3 report, high priority, due next Wednesday.'
  );

  twiml.record({
    action: `${BASE_URL}/voice/process-task`,
    method: 'POST',
    maxLength: 30,
    transcribe: false,   // We'll use Twilio's real-time transcription via speech recognition
    playBeep: true,
    timeout: 3,
  });

  // Fallback if no recording
  twiml.say({ voice: 'Polly.Matthew' }, 'I didn\'t catch anything. Let\'s try again.');
  twiml.redirect(`${BASE_URL}/voice/inbound`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Alternative: Use <Gather> with speech recognition for real-time
app.post('/voice/inbound-speech', (req, res) => {
  const twiml = new VoiceResponse();

  twiml.say(
    { voice: 'Polly.Matthew' },
    'Hey Jason! Tell me about the task you want to add.'
  );

  const gather = twiml.gather({
    input: 'speech',
    action: `${BASE_URL}/voice/process-speech`,
    method: 'POST',
    speechTimeout: 'auto',
    language: 'en-US',
  });

  // Timeout fallback
  twiml.say({ voice: 'Polly.Matthew' }, 'I didn\'t catch that. Let\'s try again.');
  twiml.redirect(`${BASE_URL}/voice/inbound-speech`);

  res.type('text/xml');
  res.send(twiml.toString());
});

// Process speech recognition result
app.post('/voice/process-speech', async (req, res) => {
  const twiml = new VoiceResponse();
  const transcript = req.body.SpeechResult;

  console.log(`🎤 Speech transcript: "${transcript}"`);

  if (!transcript) {
    twiml.say({ voice: 'Polly.Matthew' }, 'I didn\'t catch that. Let\'s try again.');
    twiml.redirect(`${BASE_URL}/voice/inbound-speech`);
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  try {
    const taskData = await extractTaskFromSpeech(transcript);

    if (taskData.error) {
      twiml.say(
        { voice: 'Polly.Matthew' },
        `I couldn't understand that as a task. Let's try again.`
      );
      twiml.redirect(`${BASE_URL}/voice/inbound-speech`);
    } else {
      // Read back for confirmation
      const dueDate = new Date(taskData.dueDate);
      const dueDateStr = dueDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });

      twiml.say(
        { voice: 'Polly.Matthew' },
        `Got it. Here's what I heard: ${taskData.task}. Priority: ${taskData.priority}. Due: ${dueDateStr}.`
      );

      const gather = twiml.gather({
        input: 'speech dtmf',
        action: `${BASE_URL}/voice/confirm-task`,
        method: 'POST',
        numDigits: 1,
        speechTimeout: 'auto',
        timeout: 5,
      });
      gather.say(
        { voice: 'Polly.Matthew' },
        'Press 1 or say yes to confirm. Press 2 or say no to try again.'
      );

      // Store task data temporarily in the URL (simple approach)
      // In production, use a session store
      app.locals.pendingTask = taskData;

      twiml.say({ voice: 'Polly.Matthew' }, 'I\'ll save that for you.');
      // Auto-confirm after timeout
      twiml.redirect(`${BASE_URL}/voice/auto-confirm`);
    }
  } catch (err) {
    console.error('Error processing speech:', err.message);
    twiml.say(
      { voice: 'Polly.Matthew' },
      'I had trouble processing that. Let\'s try again.'
    );
    twiml.redirect(`${BASE_URL}/voice/inbound-speech`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Confirm task
app.post('/voice/confirm-task', async (req, res) => {
  const twiml = new VoiceResponse();
  const digit = req.body.Digits;
  const speech = (req.body.SpeechResult || '').toLowerCase();
  const confirmed = digit === '1' || speech.includes('yes') || speech.includes('confirm');
  const denied = digit === '2' || speech.includes('no') || speech.includes('cancel');

  if (confirmed && app.locals.pendingTask) {
    const success = await addTask(app.locals.pendingTask);
    if (success) {
      twiml.say(
        { voice: 'Polly.Matthew' },
        'Task saved! Would you like to add another task?'
      );
      const gather = twiml.gather({
        input: 'speech dtmf',
        action: `${BASE_URL}/voice/add-another`,
        method: 'POST',
        numDigits: 1,
        speechTimeout: 'auto',
        timeout: 5,
      });
      gather.say(
        { voice: 'Polly.Matthew' },
        'Press 1 or say yes to add another. Otherwise, hang up or press 2.'
      );
      twiml.say({ voice: 'Polly.Matthew' }, 'Alright, have a great day Jason!');
      twiml.hangup();
    } else {
      twiml.say({ voice: 'Polly.Matthew' }, 'Sorry, I had trouble saving that. Please try again later.');
      twiml.hangup();
    }
  } else if (denied) {
    twiml.say({ voice: 'Polly.Matthew' }, 'No problem. Let\'s try again.');
    twiml.redirect(`${BASE_URL}/voice/inbound-speech`);
  } else {
    // Default: save the task
    if (app.locals.pendingTask) {
      await addTask(app.locals.pendingTask);
      twiml.say({ voice: 'Polly.Matthew' }, 'Task saved! Have a great day Jason!');
    }
    twiml.hangup();
  }

  app.locals.pendingTask = null;
  res.type('text/xml');
  res.send(twiml.toString());
});

// Auto-confirm (timeout fallback)
app.post('/voice/auto-confirm', async (req, res) => {
  const twiml = new VoiceResponse();
  if (app.locals.pendingTask) {
    await addTask(app.locals.pendingTask);
    twiml.say({ voice: 'Polly.Matthew' }, 'Task saved! Have a great day Jason!');
    app.locals.pendingTask = null;
  }
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// Add another task loop
app.post('/voice/add-another', (req, res) => {
  const twiml = new VoiceResponse();
  const digit = req.body.Digits;
  const speech = (req.body.SpeechResult || '').toLowerCase();

  if (digit === '1' || speech.includes('yes')) {
    twiml.redirect(`${BASE_URL}/voice/inbound-speech`);
  } else {
    twiml.say({ voice: 'Polly.Matthew' }, 'Have a great day Jason!');
    twiml.hangup();
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// Process recording (fallback for record-based flow)
app.post('/voice/process-task', async (req, res) => {
  const twiml = new VoiceResponse();
  twiml.say(
    { voice: 'Polly.Matthew' },
    'Got your recording. I\'ll process it and add the task. You\'ll see it in your sheet shortly. Goodbye!'
  );
  twiml.hangup();
  res.type('text/xml');
  res.send(twiml.toString());
});

// Transcription callback (async from Twilio)
app.post('/voice/transcription-callback', async (req, res) => {
  const transcript = req.body.TranscriptionText;
  console.log(`📝 Transcription received: "${transcript}"`);

  if (transcript) {
    try {
      const taskData = await extractTaskFromSpeech(transcript);
      if (!taskData.error) {
        await addTask(taskData);
      }
    } catch (err) {
      console.error('Error processing transcription:', err.message);
    }
  }
  res.sendStatus(200);
});

// ============================================================
// UTILITY ENDPOINTS
// ============================================================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    app: 'Task Caller',
    endpoints: {
      morningBriefing: '/voice/morning-briefing',
      inbound: '/voice/inbound-speech',
      testCall: 'POST /test/morning-call',
      testTasks: 'GET /test/tasks',
    },
  });
});

// Test: View upcoming tasks
app.get('/test/tasks', async (req, res) => {
  const tasks = await getUpcomingTasks(5);
  res.json({ count: tasks.length, tasks });
});

// Test: Trigger morning call manually
app.post('/test/morning-call', async (req, res) => {
  await makeMorningCall();
  res.json({ status: 'Morning call triggered' });
});

// Test: Add a task via API
app.post('/test/add-task', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Provide "text" field' });

  try {
    const taskData = await extractTaskFromSpeech(text);
    if (taskData.error) return res.status(400).json(taskData);
    const success = await addTask(taskData);
    res.json({ success, taskData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// CRON: Schedule morning call
// ============================================================

const [hour, minute] = MORNING_CALL_TIME.split(':');
const cronExpression = `${minute} ${hour} * * *`;

cron.schedule(cronExpression, () => {
  console.log(`⏰ Cron triggered at ${MORNING_CALL_TIME}`);
  makeMorningCall();
}, {
  timezone: 'America/Denver', // Colorado timezone
});

console.log(`📅 Morning call scheduled for ${MORNING_CALL_TIME} MST`);

// ============================================================
// START SERVER
// ============================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Task Caller running on port ${PORT}`);
  console.log(`   Morning call: ${MORNING_CALL_TIME} MST`);
  console.log(`   Inbound voice: ${BASE_URL}/voice/inbound-speech`);
});
