const { GoogleGenAI } = require('@google/genai');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  const { audioBase64, mimeType, prompt, apiKey: clientApiKey } = req.body || {};

  if (!audioBase64) {
    return res.status(400).json({ error: 'Áudio não fornecido para transcrição' });
  }

  const apiKey = process.env.GEMINI_API_KEY || clientApiKey || req.headers['x-gemini-key'];

  if (!apiKey) {
    return res.status(400).json({
      error: 'Chave da API Gemini não configurada. Configure GEMINI_API_KEY no arquivo .env ou no modal de Configurações ⚙'
    });
  }

  let ai;
  try {
    ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build'
        }
      }
    });
  } catch (err) {
    console.error('Erro ao inicializar SDK Gemini:', err.message);
    return res.status(500).json({ error: 'Falha ao inicializar cliente Gemini: ' + err.message });
  }

  const promptText = prompt || `Você é um assistente de documentação técnica para uma oficina mecânica de concessionária. Sua tarefa é analisar o áudio com muita atenção, extrair TODAS as informações faladas e redigir um relatório de forma direta, correta e limpa, organizado nos tópicos abaixo.

ESCRITA DIRETA E FIEL AO RELATO:
- Redija o texto de forma clara, correta e profissional, porém MANTENHA o texto CONCISO e o mais próximo possível das palavras e do estilo prático falado pelo mecânico.
- Evite termos excessivamente formais, floreios de escritório ou redações longas e artificiais. Mantenha a essência direta da oficina.
- CRÍTICO: Não resuma a ponto de omitir dados importantes! Mantenha todos os códigos de peças, prazos, sintomas e ações descritas. Apenas escreva de forma limpa, direta e fiel ao áudio.

REGRA CRÍTICA SOBRE NÚMEROS E CÓDIGOS:
- Transcreva códigos de peças, números de OS, valores, medidas e prazos EXATAMENTE como foram falados. NUNCA invente, aproxime ou altere um número. Se ouviu "22003388", escreva exatamente "22003388".

REGRAS DE CONTEÚDO:
- NÃO omita informações técnicas relevantes que foram ditas.
- Não inclua nenhuma introdução ou explicação antes dos tópicos (como "Com base no áudio..."). Comece diretamente com "- RECLAMACAO DO CLIENTE:".

TÓPICOS OBRIGATÓRIOS:
- RECLAMACAO DO CLIENTE: OBRIGATORIAMENTE comece este tópico com a frase exata "O cliente alega" e complete com o problema ou sintoma relatado pelo cliente (ex: "O cliente alega ruído na roda do lado direito").
- DIAGNOSTICO: Descreva a análise técnica do mecânico, causa identificada, componentes afetados (folgas, avarias, etc.) e códigos das peças associadas.
- SERVICO EXECUTADO: Detalhe o que já foi feito (inspeções, diagnósticos realizados, etc.) e ações planejadas/pendentes (aguardando peça, etc.). Só use "Não informado" se nada foi dito.
- PECAS: Liste as peças necessárias ou solicitadas com seus códigos exatos.

Se algum tópico realmente não foi mencionado no áudio, escreva "Não informado".`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const modelsToTry = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  let streamStarted = false;
  let lastError = null;

  for (const model of modelsToTry) {
    try {
      const responseStream = await ai.models.generateContentStream({
        model,
        contents: [
          {
            parts: [
              { text: promptText },
              {
                inlineData: {
                  mimeType: mimeType || 'audio/webm',
                  data: audioBase64
                }
              }
            ]
          }
        ],
        config: {
          temperature: 0.3
        }
      });

      streamStarted = true;
      for await (const chunk of responseStream) {
        const text = chunk.text || '';
        if (text) {
          const payload = JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text }]
                }
              }
            ],
            text
          });
          res.write(`data: ${payload}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      return res.end();
    } catch (err) {
      lastError = err;
      if (streamStarted) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        return res.end();
      }
      console.warn(`Tentativa com modelo ${model} falhou:`, err.message);
    }
  }

  const errMsg = lastError?.message || 'Erro ao comunicar com a API Gemini';
  res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
  res.end();
};
