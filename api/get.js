/**
 * GET /api/get?pin=4921
 * Returns: { "report": "texto..." }   — 200 OK, dado DELETADO atomicamente
 *      or: { "error": "..." }         — 404 se não encontrado/expirado
 *
 * Usa GETDEL para garantir autodestruição imediata após a leitura (LGPD).
 */
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { pin } = req.query;

  if (!pin || !/^\d{4}$/.test(pin)) {
    return res.status(400).json({ error: 'PIN inválido. Digite exatamente 4 dígitos.' });
  }

  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!REDIS_URL || !REDIS_TOKEN) {
    console.error('Variáveis de ambiente do Upstash não configuradas');
    return res.status(500).json({ error: 'Servidor não configurado corretamente' });
  }

  const key = `pin:${pin}`;

  try {
    // GETDEL: busca e deleta atomicamente — a mensagem se autodestrói no exato momento da leitura
    const response = await fetch(REDIS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(['GETDEL', key]),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Erro Upstash:', errText);
      return res.status(500).json({ error: 'Erro ao buscar no servidor' });
    }

    const data = await response.json();
    const report = data.result; // null se não existir

    if (!report) {
      return res.status(404).json({
        error: 'PIN não encontrado. Pode ter expirado (10 min) ou já foi resgatado.',
      });
    }

    return res.status(200).json({ report });
  } catch (err) {
    console.error('Erro interno:', err.message);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
};
