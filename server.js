import express from 'express';
import cors from 'cors';
import { createMondayLead } from './monday.js';
import { sendReportToLead } from './email.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'YourDomi API' }));

// Main Claude analyze endpoint
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ error: { message: `Anthropic returned non-JSON: ${text.slice(0, 200)}` } }); }

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Analyze error:', error);
    return res.status(500).json({ error: { message: error.message } });
  }
});

// Monday CRM + lead email endpoint
app.post('/api/create-monday-lead', async (req, res) => {
  const mondayKey  = process.env.MONDAY_API_KEY;
  const resendKey  = process.env.RESEND_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Respond immediately so frontend isn't blocked
  res.status(200).json({ ok: true });

  // Run Monday CRM and lead email in parallel (fire and forget)
  const tasks = [];

  if (mondayKey) {
    tasks.push(
      createMondayLead(mondayKey, anthropicKey, req.body)
        .then(id => console.log('Monday lead created:', id))
        .catch(e => console.error('Monday error:', e.message))
    );
  } else {
    console.log('MONDAY_API_KEY not set — skipping CRM');
  }

  tasks.push(
    sendReportToLead(resendKey, req.body)
      .catch(e => console.error('Email error:', e.message))
  );

  await Promise.allSettled(tasks);
});

app.listen(PORT, () => {
  console.log(`YourDomi API running on port ${PORT}`);
});
