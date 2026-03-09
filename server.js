import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// Health check — Render pings this to keep the service alive
app.get('/', (req, res) => res.json({ status: 'ok', service: 'YourDomi API' }));

// Main analyze endpoint
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });
  }

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
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(500).json({ error: { message: `Anthropic returned non-JSON: ${text.slice(0, 200)}` } });
    }

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('API error:', error);
    return res.status(500).json({ error: { message: error.message } });
  }
});

app.listen(PORT, () => {
  console.log(`YourDomi API running on port ${PORT}`);
});
