/**
 * POST /api/save
 * Body: { "report": "texto do relatório..." }
 * Returns: { "pin": "4921" }
 *
 * Salva o relatório no Upstash Redis com TTL de 10 minutos.
 */
module.exports = async function handler(req, res) {
  // CORS para o próprio domínio
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { report } = req.body || {};

  if (!report || typeof report !== 'string' || report.trim().length === 0) {
    return res.status(400).json({ error: 'Relatório não pode estar vazio' });
  }

  const store = require('./store');
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Gera PIN de 4 dígitos com zero-padding (ex: "0042")
  const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const key = `pin:${pin}`;

  if (!REDIS_URL || !REDIS_TOKEN) {
    // In-memory fallback
    store.savePin(pin, report.trim(), 600);
    return res.status(200).json({ pin });
  }

  try {
    // Upstash REST API: comando ["SET", key, value, "EX", ttl_em_segundos]
    const response = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['SET', key, report.trim(), 'EX', 600]),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.warn('Erro Upstash, usando armazenamento local:', errText);
      store.savePin(pin, report.trim(), 600);
      return res.status(200).json({ pin });
    }

    return res.status(200).json({ pin });
  } catch (err) {
    console.warn('Erro ao conectar ao Upstash, usando armazenamento local:', err.message);
    store.savePin(pin, report.trim(), 600);
    return res.status(200).json({ pin });
  }
};
