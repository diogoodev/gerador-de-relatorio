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

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('Variáveis de ambiente do Upstash não configuradas');
    return res.status(500).json({ error: 'Servidor não configurado corretamente' });
  }

  // Gera PIN de 4 dígitos com zero-padding (ex: "0042")
  const pin = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
  const key = `pin:${pin}`;

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
      console.error('Erro Upstash:', errText);
      return res.status(500).json({ error: 'Falha ao salvar no servidor' });
    }

    return res.status(200).json({ pin });
  } catch (err) {
    console.error('Erro interno:', err.message);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
};
