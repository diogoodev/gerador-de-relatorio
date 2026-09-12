require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

// Body parser
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Environment config status
app.get('/api/config', (req, res) => {
  res.json({
    hasServerKey: !!process.env.GEMINI_API_KEY,
    hasUpstash: !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN)
  });
});

// API routes
const getHandler = require('./api/get');
const saveHandler = require('./api/save');
const geminiHandler = require('./api/gemini');

app.all('/api/get', (req, res) => getHandler(req, res));
app.all('/api/save', (req, res) => saveHandler(req, res));
app.all('/api/gemini', (req, res) => geminiHandler(req, res));

// Serve static frontend assets
app.use(express.static(path.join(__dirname)));

// SPA Fallback for any unknown route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on http://0.0.0.0:${PORT}`);
});
