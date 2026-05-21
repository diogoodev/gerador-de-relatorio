/**
 * GR · Gerador de Relatório · app.js
 * Zero-Backend SPA for mechanic audio reporting
 * PC ↔ Mobile via PeerJS (WebRTC DataChannel)
 * Audio → Gemini API (PC side only)
 */

'use strict';

// ─── ROUTING ─────────────────────────────────────────────────────────────────
const params   = new URLSearchParams(window.location.search);
const targetId = params.get('peer');

if (targetId) {
  initMobile(targetId);
} else {
  initPC();
}

// ═════════════════════════════════════════════════════════════════════════════
//   PC INTERFACE
// ═════════════════════════════════════════════════════════════════════════════
function initPC() {
  document.getElementById('pc-view').classList.remove('hidden');

  // ── State ──────────────────────────────────────────────
  let peer        = null;
  let connection  = null;
  let lastAudio   = null;
  let lastRawText = '';

  // ── DOM refs ───────────────────────────────────────────
  const $peerId      = document.getElementById('pc-peer-id');
  const $qrSkeleton  = document.getElementById('qr-skeleton');
  const $qrCode      = document.getElementById('qr-code');
  const $connDot     = document.getElementById('pc-conn-dot');
  const $connLabel   = document.getElementById('pc-conn-label');
  const $log         = document.getElementById('pc-log');
  const $reportIdle  = document.getElementById('report-idle');
  const $reportProc  = document.getElementById('report-processing');
  const $reportErr   = document.getElementById('report-error');
  const $reportRes   = document.getElementById('report-result');
  const $reportStat  = document.getElementById('report-status');
  const $sections    = document.getElementById('report-sections');
  const $errMsg      = document.getElementById('error-message');
  const $audioCard   = document.getElementById('audio-card');
  const $audioPlayer = document.getElementById('audio-player');
  const $audioMeta   = document.getElementById('audio-meta');
  const $copyBtn     = document.getElementById('copy-btn');
  const $clearBtn    = document.getElementById('clear-btn');
  const $retryBtn    = document.getElementById('retry-btn');

  // ── Settings Modal ─────────────────────────────────────
  const $settingsBtn  = document.getElementById('settings-btn');
  const $modal        = document.getElementById('settings-modal');
  const $modalClose   = document.getElementById('modal-close');
  const $apiInput     = document.getElementById('api-key-input');
  const $toggleVis    = document.getElementById('toggle-vis');
  const $saveKeyBtn   = document.getElementById('save-key-btn');
  const $keySavedMsg  = document.getElementById('key-saved-msg');

  const STORAGE_KEY = 'mechreport_gemini_key';

  $settingsBtn.addEventListener('click', () => {
    $apiInput.value = localStorage.getItem(STORAGE_KEY) || '';
    $keySavedMsg.classList.add('hidden');
    $modal.classList.remove('hidden');
  });
  $modalClose.addEventListener('click', () => $modal.classList.add('hidden'));
  $modal.addEventListener('click', e => { if (e.target === $modal) $modal.classList.add('hidden'); });

  $toggleVis.addEventListener('click', () => {
    $apiInput.type = $apiInput.type === 'password' ? 'text' : 'password';
  });

  $saveKeyBtn.addEventListener('click', () => {
    const key = $apiInput.value.trim();
    if (!key) { showToast('Insira uma chave válida', 'error'); return; }
    localStorage.setItem(STORAGE_KEY, key);
    $keySavedMsg.classList.remove('hidden');
    addLog('Chave API salva no localStorage', 'ok');
    setTimeout(() => $modal.classList.add('hidden'), 1200);
  });

  // ── PeerJS setup ───────────────────────────────────────
  const peerId = 'oficina-' + Math.random().toString(36).substr(2, 6).toUpperCase();

  addLog('Iniciando PeerJS...', 'info');

  peer = new Peer(peerId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', id => {
    $peerId.textContent = id;
    addLog(`ID da baia gerado: ${id}`, 'ok');
    generateQR(id);
  });

  peer.on('connection', conn => {
    connection = conn;
    setConnected(true, conn.peer);
    addLog(`Celular conectado: ${conn.peer}`, 'ok');

    conn.on('data', handleReceivedData);

    conn.on('close', () => {
      setConnected(false);
      connection = null;
      addLog('Celular desconectado', 'warn');
    });

    conn.on('error', err => {
      addLog(`Erro na conexão: ${err.message}`, 'error');
    });
  });

  peer.on('error', err => {
    addLog(`Erro PeerJS: ${err.message}`, 'error');
  });

  // ── QR Code ────────────────────────────────────────────
  function generateQR(id) {
    const url = `${window.location.origin}${window.location.pathname}?peer=${id}`;
    $qrSkeleton.classList.add('hidden');
    $qrCode.classList.remove('hidden');

    new QRCode($qrCode, {
      text: url,
      width: 200,
      height: 200,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });

    addLog(`QR Code gerado → ${url}`, 'info');
  }

  // ── Connection UI ──────────────────────────────────────
  function setConnected(connected, label = '') {
    if (connected) {
      $connDot.className = 'conn-dot connected';
      $connLabel.textContent = `Conectado · ${label}`;
    } else {
      $connDot.className = 'conn-dot';
      $connLabel.textContent = 'Aguardando celular';
    }
  }

  // ── Receive Audio ──────────────────────────────────────
  async function handleReceivedData(data) {
    addLog(`Áudio recebido (${formatBytes(data.size || data.byteLength || 0)})`, 'ok');

    // Build Blob
    let blob;
    if (data instanceof Blob) {
      blob = data;
    } else if (data instanceof ArrayBuffer) {
      blob = new Blob([data], { type: 'audio/webm' });
    } else {
      // If it arrived as a raw buffer-like object
      blob = new Blob([data]);
    }

    lastAudio = blob;

    // Show audio player
    const url = URL.createObjectURL(blob);
    $audioPlayer.src = url;
    $audioMeta.textContent = `Tamanho: ${formatBytes(blob.size)} · Tipo: ${blob.type || 'audio/webm'}`;
    $audioCard.classList.remove('hidden');

    // Start AI processing
    await processWithGemini(blob);
  }

  // ── Gemini API (Streaming) ──────────────────────────────
  async function processWithGemini(blob) {
    const apiKey = localStorage.getItem(STORAGE_KEY);

    if (!apiKey) {
      showState('error', 'Chave da API Gemini não configurada. Clique no ícone ⚙ para inserir a chave.');
      addLog('Erro: Chave API não encontrada', 'error');
      return;
    }

    showState('processing');
    addLog('Enviando áudio para Gemini...', 'info');

    // Stream preview element
    const $streamPreview = document.getElementById('stream-preview');
    $streamPreview.textContent = '';
    $streamPreview.classList.remove('hidden');

    try {
      // Convert Blob → Base64
      const base64 = await blobToBase64(blob);
      const mimeType = blob.type || 'audio/webm';

      const prompt = `Você é um assistente de documentação técnica para uma oficina mecânica de concessionária. Sua tarefa é analisar o áudio com muita atenção, extrair TODAS as informações faladas e redigir um relatório de forma direta, correta e limpa, organizado nos tópicos abaixo.

ESCRITA DIRETA E FIEL AO RELATO:
- Redija o texto de forma clara, correta e profissional, porém MANTENHA o texto CONCISO e o mais próximo possível das palavras e do estilo prático falado pelo mecânico.
- Evite termos excessivamente formais, floreios de escritório ou redações longas e artificiais. Mantenha a essência direta da oficina.
- CRÍTICO: Não resuma a ponto de omitir dados importantes! Mantenha todos os códigos de peças, prazos, sintomas e ações descritas. Apenas escreva de forma limpa, direta e fiel ao áudio.

REGRA CRÍTICA SOBRE NÚMEROS E CÓDIGOS:
- Transcreva códigos de peças, números de OS, valores, medidas e prazos EXATAMENTE como foram falados. NUNCA invente, aproxime ou altere um número. Se ouviu "22003388", escreva exatamente "22003388".

REGRAS DE CONTEÚDO:
- NÃO omita informações técnicas relevantes que foram ditas.
- Não inclua nenhuma introdução ou explicação antes dos tópicos (como "Com base no áudio..."). Comece diretamente com "- RECLAMAÇÃO DO CLIENTE:".

TÓPICOS OBRIGATÓRIOS:
- RECLAMAÇÃO DO CLIENTE: OBRIGATORIAMENTE comece este tópico com a frase exata "O cliente alega" e complete com o problema ou sintoma relatado pelo cliente (ex: "O cliente alega ruído na roda do lado direito").
- DIAGNÓSTICO: Descreva a análise técnica do mecânico, causa identificada, componentes afetados (folgas, avarias, etc.) e códigos das peças associadas.
- SERVIÇO EXECUTADO: Detalhe o que já foi feito (inspeções, diagnósticos realizados, etc.) e ações planejadas/pendentes (aguardando peça, etc.). Só use "Não informado" se nada foi dito.
- PEÇAS: Liste as peças necessárias ou solicitadas com seus códigos exatos.

Se algum tópico realmente não foi mencionado no áudio, escreva "Não informado".`;

      const body = {
        contents: [
          {
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: mimeType,
                  data: base64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 8192
        }
      };

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message || `HTTP ${res.status}`);
      }

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;

            try {
              const chunk = JSON.parse(jsonStr);
              const chunkText = chunk?.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (chunkText) {
                fullText += chunkText;
                $streamPreview.textContent = fullText;
                $streamPreview.scrollTop = $streamPreview.scrollHeight;
              }
            } catch (parseErr) {
              // Skip malformed JSON chunks
            }
          }
        }
      }

      if (!fullText) throw new Error('Resposta vazia da API Gemini.');

      // Normalize for NBS: uppercase + remove accents
      const normalizedText = normalizeForNBS(fullText);
      lastRawText = normalizedText;
      $streamPreview.classList.add('hidden');
      addLog('Relatório gerado com sucesso!', 'ok');
      renderReport(normalizedText);

    } catch (err) {
      $streamPreview.classList.add('hidden');
      addLog(`Erro Gemini: ${err.message}`, 'error');
      showState('error', `Erro ao processar: ${err.message}`);
    }
  }

  // ── Report Rendering ───────────────────────────────────
  const SECTION_MAP = {
    'RECLAMACAO DO CLIENTE': { tag: 'tag-reclamacao', label: '🗣 RECLAMACAO DO CLIENTE' },
    'DIAGNOSTICO':           { tag: 'tag-diagnostico', label: '🔍 DIAGNOSTICO' },
    'SERVICO EXECUTADO':     { tag: 'tag-servico',     label: '🔧 SERVICO EXECUTADO'    },
    'PECAS':                 { tag: 'tag-pecas',       label: '📦 PECAS'                 }
  };

  function renderReport(text) {
    $sections.innerHTML = '';

    // Parse each section from AI output
    const lines = text.split('\n');
    let current = null;
    const sections = {};

    const KEYS = Object.keys(SECTION_MAP);

    for (const line of lines) {
      const trimmed = line.trim();
      const matchedKey = KEYS.find(k => trimmed.startsWith(`- ${k}:`) || trimmed.startsWith(`${k}:`));
      if (matchedKey) {
        current = matchedKey;
        let val = trimmed.replace(`- ${matchedKey}:`, '').replace(`${matchedKey}:`, '').trim();
        sections[matchedKey] = val;
      } else if (current && trimmed) {
        sections[current] = (sections[current] + '\n' + trimmed).trim();
      }
    }

    // Force "O CLIENTE ALEGA" format in RECLAMACAO DO CLIENTE
    if (sections['RECLAMACAO DO CLIENTE']) {
      let content = sections['RECLAMACAO DO CLIENTE'].trim();
      const prefixRegex = /^(O\s+)?CLIENTE\s+(ALEG|RELAT|RECLAM|QUEIX|INFORM)[A-Z]*(\s+QUE)?\s*/i;
      if (prefixRegex.test(content)) {
        content = content.replace(prefixRegex, '');
      }
      sections['RECLAMACAO DO CLIENTE'] = 'O CLIENTE ALEGA ' + content;
    }

    // If parsing failed, show raw text
    if (Object.keys(sections).length === 0) {
      const el = document.createElement('div');
      el.className = 'report-section';
      el.innerHTML = `
        <div class="section-tag">RELATÓRIO</div>
        <div class="section-content">${escapeHTML(text)}</div>
      `;
      $sections.appendChild(el);
    } else {
      let cleanedText = '';
      let renderedCount = 0;
      KEYS.forEach((key, i) => {
        const content = sections[key] || 'NAO INFORMADO';
        
        if (isNotMencionando(content)) {
          return;
        }
        
        cleanedText += `- ${key}:\n${content}\n`;
        renderedCount++;
        
        const meta = SECTION_MAP[key];
        const el = document.createElement('div');
        el.className = 'report-section';
        el.style.animationDelay = `${renderedCount * 0.1}s`;
        el.innerHTML = `
          <div class="section-tag ${meta.tag}">${meta.label}</div>
          <div class="section-content">${escapeHTML(content)}</div>
        `;
        $sections.appendChild(el);
      });
      
      if (renderedCount === 0) {
        const el = document.createElement('div');
        el.className = 'report-section';
        el.innerHTML = `
          <div class="section-tag tag-reclamacao">AVISO</div>
          <div class="section-content">NENHUMA INFORMAÇÃO ESPECÍFICA DETECTADA NO ÁUDIO.</div>
        `;
        $sections.appendChild(el);
      }
      
      lastRawText = cleanedText.trim();
    }

    showState('result');
  }

  // ── UI State Machine ───────────────────────────────────
  function showState(state, msg = '') {
    $reportIdle.classList.add('hidden');
    $reportProc.classList.add('hidden');
    $reportErr.classList.add('hidden');
    $reportRes.classList.add('hidden');

    const statusMap = {
      idle:       '<span class="status-idle">Aguardando áudio do mecânico</span>',
      processing: '<span class="status-busy">⌛ Processando com IA...</span>',
      error:      '<span class="status-error">✕ Erro no processamento</span>',
      result:     '<span class="status-done">✓ Relatório pronto</span>'
    };
    $reportStat.innerHTML = statusMap[state] || '';

    if (state === 'idle')       { $reportIdle.classList.remove('hidden'); }
    if (state === 'processing') { $reportProc.classList.remove('hidden'); }
    if (state === 'error')      { $reportErr.classList.remove('hidden');  $errMsg.textContent = msg; }
    if (state === 'result')     { $reportRes.classList.remove('hidden');  }
  }

  // ── Copy Button ────────────────────────────────────────
  $copyBtn.addEventListener('click', async () => {
    if (!lastRawText) return;
    try {
      await navigator.clipboard.writeText(lastRawText);
      $copyBtn.textContent = '✓ Copiado!';
      $copyBtn.classList.add('copied');
      showToast('Relatório copiado para a área de transferência!', 'ok');
      setTimeout(() => {
        $copyBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar para OS`;
        $copyBtn.classList.remove('copied');
      }, 2000);
    } catch {
      showToast('Erro ao copiar. Selecione o texto manualmente.', 'error');
    }
  });

  // ── Clear Button ───────────────────────────────────────
  $clearBtn.addEventListener('click', () => {
    lastRawText = '';
    lastAudio = null;
    $audioCard.classList.add('hidden');
    $audioPlayer.src = '';
    showState('idle');
    addLog('Relatório limpo', 'info');
  });

  // ── Retry Button ───────────────────────────────────────
  $retryBtn.addEventListener('click', () => {
    if (lastAudio) {
      processWithGemini(lastAudio);
    } else {
      showState('idle');
    }
  });

  // ── Log ────────────────────────────────────────────────
  function addLog(msg, type = 'info') {
    const el = document.createElement('div');
    el.className = `log-entry log-${type}`;
    const ts = new Date().toLocaleTimeString('pt-BR', { hour12: false });
    el.textContent = `[${ts}] ${msg}`;
    $log.appendChild(el);
    $log.scrollTop = $log.scrollHeight;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//   MOBILE INTERFACE
// ═════════════════════════════════════════════════════════════════════════════
function initMobile(targetPeerId) {
  document.getElementById('mobile-view').classList.remove('hidden');

  // ── State ──────────────────────────────────────────────
  let peer        = null;
  let connection  = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let audioBlob   = null;
  let timerInterval = null;
  let seconds     = 0;
  let analyser    = null;
  let animFrame   = null;

  // ── DOM refs ───────────────────────────────────────────
  const $connDot      = document.getElementById('mob-conn-dot');
  const $connLabel    = document.getElementById('mob-conn-label');
  const $targetId     = document.getElementById('mob-target-id');
  const $recordBtn    = document.getElementById('record-btn');
  const $recordIcon   = document.getElementById('record-icon');
  const $stopIcon     = document.getElementById('stop-icon');
  const $recordPulse  = document.getElementById('record-pulse');
  const $recordHint   = document.getElementById('record-hint');
  const $recordTimer  = document.getElementById('record-timer');
  const $statusText   = document.getElementById('mob-status-text');
  const $audioPreview = document.getElementById('mob-audio-preview');
  const $mobPlayback  = document.getElementById('mob-playback');
  const $sendBtn      = document.getElementById('mob-send-btn');
  const $canvas       = document.getElementById('waveform-canvas');
  const ctx           = $canvas.getContext('2d');

  $targetId.textContent = targetPeerId;

  // ── PeerJS ─────────────────────────────────────────────
  peer = new Peer({
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', myId => {
    setStatus('connecting', 'Conectando à baia...');
    $connDot.className = 'conn-dot connecting';

    connection = peer.connect(targetPeerId, { reliable: true });

    connection.on('open', () => {
      setStatus('idle', 'Conectado! Pronto para gravar.');
      $connDot.className = 'conn-dot connected';
      $connLabel.textContent = `Conectado · ${targetPeerId}`;
      $recordBtn.disabled = false;
      $recordHint.textContent = 'Pressione para começar a gravar';
    });

    connection.on('close', () => {
      setStatus('idle', 'Conexão encerrada');
      $connDot.className = 'conn-dot';
      $connLabel.textContent = 'Desconectado';
      $recordBtn.disabled = true;
      $recordHint.textContent = 'Conexão encerrada. Escaneie o QR novamente.';
    });

    connection.on('error', err => {
      $connDot.className = 'conn-dot';
      $connLabel.textContent = 'Erro de conexão';
      $recordHint.textContent = `Erro: ${err.message}`;
    });
  });

  peer.on('error', err => {
    $connDot.className = 'conn-dot';
    $connLabel.textContent = `Erro PeerJS`;
    $recordHint.textContent = `Falha ao conectar: verifique a rede`;
  });

  // ── Record Button ──────────────────────────────────────
  $recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      await startRecording();
    }
  });

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Waveform analyser
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      drawWaveform();

      // Prefer webm/opus, fallback to mp4
      const mimeType = getSupportedMimeType();
      audioChunks = [];

      mediaRecorder = new MediaRecorder(stream, { mimeType });
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        audioBlob = new Blob(audioChunks, { type: mimeType });
        const url = URL.createObjectURL(audioBlob);
        $mobPlayback.src = url;
        $audioPreview.classList.remove('hidden');
        setStatus('idle', 'Gravação pronta — revise e envie');
        stream.getTracks().forEach(t => t.stop());
        cancelAnimationFrame(animFrame);
        clearWaveform();
      };

      mediaRecorder.start(250); // collect every 250ms
      startTimer();

      // UI: recording mode
      $recordBtn.classList.add('recording');
      $recordIcon.classList.add('hidden');
      $stopIcon.classList.remove('hidden');
      $recordHint.textContent = 'Gravando... toque para parar';
      $audioPreview.classList.add('hidden');
      setStatus('recording', '⏺ GRAVANDO');

    } catch (err) {
      $recordHint.textContent = `Microfone negado: ${err.message}`;
      showToast('Permita acesso ao microfone', 'error');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    stopTimer();
    $recordBtn.classList.remove('recording');
    $recordIcon.classList.remove('hidden');
    $stopIcon.classList.add('hidden');
    $recordHint.textContent = 'Revise o áudio e envie para a baia';
  }

  // ── Send Audio ─────────────────────────────────────────
  $sendBtn.addEventListener('click', () => {
    if (!audioBlob) return;
    if (!connection || connection.open === false) {
      showToast('Sem conexão com a baia!', 'error');
      return;
    }

    setStatus('sending', 'Enviando áudio...');
    $sendBtn.disabled = true;
    $sendBtn.textContent = 'Enviando...';

    try {
      connection.send(audioBlob);
      setStatus('sent', '✓ Áudio enviado! O PC está processando...');
      $sendBtn.textContent = '✓ Enviado!';
      showToast('Áudio enviado! Aguarde o relatório no PC.', 'ok');
      seconds = 0;
      $recordTimer.textContent = '00:00';
    } catch (err) {
      setStatus('idle', 'Erro ao enviar');
      $sendBtn.disabled = false;
      $sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Enviar para o PC`;
      showToast(`Erro ao enviar: ${err.message}`, 'error');
    }
  });

  // ── Timer ──────────────────────────────────────────────
  function startTimer() {
    seconds = 0;
    $recordTimer.textContent = '00:00';
    timerInterval = setInterval(() => {
      seconds++;
      const m = String(Math.floor(seconds / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      $recordTimer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
  }

  // ── Waveform ───────────────────────────────────────────
  function drawWaveform() {
    animFrame = requestAnimationFrame(drawWaveform);
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const W = $canvas.width;
    const H = $canvas.height;
    ctx.fillStyle = 'rgba(20, 23, 32, 0.4)';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = 2;
    ctx.strokeStyle = '#f5a623';
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#f5a623';
    ctx.beginPath();

    const sliceWidth = W / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      const v = dataArray[i] / 128.0;
      const y = v * H / 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceWidth;
    }

    ctx.lineTo(W, H / 2);
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  function clearWaveform() {
    ctx.fillStyle = 'rgba(20, 23, 32, 1)';
    ctx.fillRect(0, 0, $canvas.width, $canvas.height);

    // Draw flat line
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#2a2f42';
    ctx.beginPath();
    ctx.moveTo(0, $canvas.height / 2);
    ctx.lineTo($canvas.width, $canvas.height / 2);
    ctx.stroke();
  }

  // ── Status ─────────────────────────────────────────────
  function setStatus(state, msg) {
    $statusText.textContent = msg;
    $statusText.className = '';
    const cls = {
      idle: 'mob-status-idle',
      recording: 'mob-status-recording',
      sending: 'mob-status-sending',
      sent: 'mob-status-sent',
      connecting: 'mob-status-idle'
    };
    $statusText.classList.add(cls[state] || 'mob-status-idle');
  }

  clearWaveform();
}

// ═════════════════════════════════════════════════════════════════════════════
//   SHARED UTILITIES
// ═════════════════════════════════════════════════════════════════════════════

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(msg, type = 'info') {
  const $toast = document.getElementById('toast');
  $toast.textContent = msg;
  $toast.className = `toast toast-${type} show`;
  setTimeout(() => { $toast.className = 'toast hidden'; }, 3000);
}

function normalizeForNBS(text) {
  // Remove accents/diacritics and convert to uppercase
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function isNotMencionando(content) {
  if (!content) return true;
  const normalized = content.trim().toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.\s]/g, '');
  return normalized === 'NAOINFORMADO' || normalized === '';
}

