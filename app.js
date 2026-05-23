/**
 * GR · Gerador de Relatório · app.js
 * Arquitetura "Burn After Reading" — Vercel + Upstash Redis
 * Celular: grava → Gemini → /api/save → PIN
 * PC: digita PIN → /api/get (GETDEL) → relatório
 */

'use strict';

// ─── CONSTANTES ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'mechreport_gemini_key';

const GEMINI_PROMPT = `Você é um assistente de documentação técnica para uma oficina mecânica de concessionária. Sua tarefa é analisar o áudio com muita atenção, extrair TODAS as informações faladas e redigir um relatório de forma direta, correta e limpa, organizado nos tópicos abaixo.

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

const SECTION_MAP = {
  'RECLAMACAO DO CLIENTE': { tag: 'tag-reclamacao', label: '🗣 RECLAMACAO DO CLIENTE' },
  'DIAGNOSTICO':           { tag: 'tag-diagnostico', label: '🔍 DIAGNOSTICO'           },
  'SERVICO EXECUTADO':     { tag: 'tag-servico',     label: '🔧 SERVICO EXECUTADO'     },
  'PECAS':                 { tag: 'tag-pecas',       label: '📦 PECAS'                 },
};

// ─── INICIALIZAÇÃO ─────────────────────────────────────────────────────────────
initSettings();
initHome();
initRecord();
initRetrieve();

// ═════════════════════════════════════════════════════════════════════════════
//   NAVEGAÇÃO ENTRE TELAS
// ═════════════════════════════════════════════════════════════════════════════
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  const el = document.getElementById(`view-${name}`);
  if (el) {
    el.classList.remove('hidden');
    window.scrollTo(0, 0);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//   HOME
// ═════════════════════════════════════════════════════════════════════════════
function initHome() {
  showView('home');

  document.getElementById('btn-go-record').addEventListener('click', () => showView('record'));
  document.getElementById('btn-go-retrieve').addEventListener('click', () => showView('retrieve'));
}

// ═════════════════════════════════════════════════════════════════════════════
//   TELA DE GRAVAÇÃO
// ═════════════════════════════════════════════════════════════════════════════
function initRecord() {
  // ── State ──────────────────────────────────────────────
  let mediaRecorder  = null;
  let audioChunks    = [];
  let audioBlob      = null;
  let timerInterval  = null;
  let countdownInterval = null;
  let seconds        = 0;
  let analyser       = null;
  let animFrame      = null;
  let lastReportText = '';

  // ── DOM refs ───────────────────────────────────────────
  const $canvas        = document.getElementById('waveform-canvas');
  const ctx            = $canvas.getContext('2d');
  const $timer         = document.getElementById('record-timer');
  const $recordBtn     = document.getElementById('record-btn');
  const $micIcon       = document.getElementById('record-icon-mic');
  const $stopIcon      = document.getElementById('record-icon-stop');
  const $recordLabel   = document.getElementById('record-label');
  const $audioPreview  = document.getElementById('audio-preview-wrap');
  const $audioPlayback = document.getElementById('audio-playback');
  const $btnProcess    = document.getElementById('btn-process');
  const $recordSection = document.getElementById('record-section');
  const $procSection   = document.getElementById('processing-section');
  const $procLabel     = document.getElementById('proc-label');
  const $streamPreview = document.getElementById('stream-preview');
  const $pinSection    = document.getElementById('pin-section');
  const $pinDigits     = [0,1,2,3].map(i => document.getElementById(`pin-d${i}`));
  const $pinCountdown  = document.getElementById('pin-countdown');
  const $errorSection  = document.getElementById('record-error-section');
  const $errorMsg      = document.getElementById('record-error-msg');
  const $btnRetry      = document.getElementById('btn-retry-record');
  const $btnNewRecord  = document.getElementById('btn-new-record');

  // ── Navegação ──────────────────────────────────────────
  document.getElementById('back-from-record').addEventListener('click', () => {
    resetRecordView();
    showView('home');
  });

  // ── Botão gravar ───────────────────────────────────────
  $recordBtn.addEventListener('click', async () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      stopRecording();
    } else {
      await startRecording();
    }
  });

  // ── Botão processar ────────────────────────────────────
  $btnProcess.addEventListener('click', async () => {
    if (!audioBlob) return;
    const apiKey = localStorage.getItem(STORAGE_KEY);
    if (!apiKey) {
      showToast('Configure a chave Gemini antes de processar ⚙', 'error');
      openSettingsModal();
      return;
    }
    showRecordState('processing');
    await processWithGemini(audioBlob, apiKey);
  });

  // ── Botão novo relatório ───────────────────────────────
  $btnNewRecord.addEventListener('click', () => resetRecordView());

  // ── Botão tentar novamente ─────────────────────────────
  $btnRetry.addEventListener('click', async () => {
    if (!audioBlob) {
      resetRecordView();
      return;
    }
    const apiKey = localStorage.getItem(STORAGE_KEY);
    if (!apiKey) {
      showToast('Configure a chave Gemini ⚙', 'error');
      openSettingsModal();
      return;
    }
    showRecordState('processing');
    await processWithGemini(audioBlob, apiKey);
  });

  // ── Gravação ───────────────────────────────────────────
  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      drawWaveform();

      const mimeType = getSupportedMimeType();
      audioChunks = [];

      mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const finalMime = mimeType || 'audio/webm';
        audioBlob = new Blob(audioChunks, { type: finalMime });
        const url = URL.createObjectURL(audioBlob);
        $audioPlayback.src = url;
        $audioPreview.classList.remove('hidden');
        $recordLabel.textContent = 'Gravação pronta. Revise e processe.';
        stream.getTracks().forEach(t => t.stop());
        cancelAnimationFrame(animFrame);
        clearWaveform();
      };

      mediaRecorder.start(250);
      startTimer();

      $recordBtn.classList.add('recording');
      $micIcon.classList.add('hidden');
      $stopIcon.classList.remove('hidden');
      $audioPreview.classList.add('hidden');
      $recordLabel.textContent = '⏺ Gravando... toque para parar';

    } catch (err) {
      showToast('Permita acesso ao microfone nas configurações do navegador', 'error');
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    stopTimer();
    $recordBtn.classList.remove('recording');
    $micIcon.classList.remove('hidden');
    $stopIcon.classList.add('hidden');
  }

  // ── Gemini API (Streaming no celular) ──────────────────
  async function processWithGemini(blob, apiKey) {
    $procLabel.textContent = 'Transcrevendo áudio com IA...';
    $streamPreview.textContent = '';
    $streamPreview.classList.remove('hidden');

    try {
      const base64 = await blobToBase64(blob);
      const mimeType = blob.type || 'audio/webm';

      const body = {
        contents: [{
          parts: [
            { text: GEMINI_PROMPT },
            { inlineData: { mimeType, data: base64 } }
          ]
        }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
      };

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent?alt=sse&key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData?.error?.message || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

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
            } catch { /* chunk inválido */ }
          }
        }
      }

      if (!fullText) throw new Error('Resposta vazia da API Gemini.');

      const normalizedText = normalizeForNBS(fullText);
      lastReportText = normalizedText;

      // Salvar no Redis e gerar PIN
      $procLabel.textContent = 'Salvando relatório e gerando PIN...';
      $streamPreview.classList.add('hidden');
      await saveAndGetPin(normalizedText);

    } catch (err) {
      showRecordState('error', err.message);
    }
  }

  // ── Salvar no Redis (/api/save) ────────────────────────
  async function saveAndGetPin(reportText) {
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ report: reportText }),
      });

      const data = await res.json();

      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      const pin = data.pin;
      showPin(pin);
    } catch (err) {
      showRecordState('error', `Erro ao salvar relatório: ${err.message}`);
    }
  }

  // ── Exibir PIN ─────────────────────────────────────────
  function showPin(pin) {
    const digits = String(pin).padStart(4, '0').split('');
    $pinDigits.forEach((el, i) => { el.textContent = digits[i] || '—'; });
    showRecordState('pin');

    // Contagem regressiva de 10 minutos
    let remaining = 600;
    clearInterval(countdownInterval);
    countdownInterval = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(countdownInterval);
        $pinCountdown.textContent = '00:00';
        return;
      }
      const m = String(Math.floor(remaining / 60)).padStart(2, '0');
      const s = String(remaining % 60).padStart(2, '0');
      $pinCountdown.textContent = `${m}:${s}`;
    }, 1000);
  }

  // ── Estados da tela de gravação ────────────────────────
  function showRecordState(state, errorMsg = '') {
    $recordSection.classList.add('hidden');
    $procSection.classList.add('hidden');
    $pinSection.classList.add('hidden');
    $errorSection.classList.add('hidden');

    switch (state) {
      case 'recording': $recordSection.classList.remove('hidden'); break;
      case 'processing': $procSection.classList.remove('hidden'); break;
      case 'pin': $pinSection.classList.remove('hidden'); break;
      case 'error':
        $errorMsg.textContent = errorMsg;
        $errorSection.classList.remove('hidden');
        break;
    }
  }

  // ── Reset ──────────────────────────────────────────────
  function resetRecordView() {
    clearInterval(countdownInterval);
    stopTimer();
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    audioBlob = null;
    audioChunks = [];
    lastReportText = '';
    $timer.textContent = '00:00';
    $audioPlayback.src = '';
    $audioPreview.classList.add('hidden');
    $recordLabel.textContent = 'Toque para gravar';
    $recordBtn.classList.remove('recording');
    $micIcon.classList.remove('hidden');
    $stopIcon.classList.add('hidden');
    $streamPreview.textContent = '';
    clearWaveform();
    showRecordState('recording');
  }

  // ── Timer ──────────────────────────────────────────────
  function startTimer() {
    seconds = 0;
    $timer.textContent = '00:00';
    timerInterval = setInterval(() => {
      seconds++;
      const m = String(Math.floor(seconds / 60)).padStart(2, '0');
      const s = String(seconds % 60).padStart(2, '0');
      $timer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() { clearInterval(timerInterval); }

  // ── Waveform ───────────────────────────────────────────
  function drawWaveform() {
    animFrame = requestAnimationFrame(drawWaveform);
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteTimeDomainData(dataArray);

    const W = $canvas.width;
    const H = $canvas.height;
    ctx.fillStyle = 'rgba(248, 249, 250, 0.8)';
    ctx.fillRect(0, 0, W, H);

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#D97706';
    ctx.shadowBlur = 6;
    ctx.shadowColor = '#F59E0B';
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
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(0, 0, $canvas.width, $canvas.height);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#CBD5E1';
    ctx.beginPath();
    ctx.moveTo(0, $canvas.height / 2);
    ctx.lineTo($canvas.width, $canvas.height / 2);
    ctx.stroke();
  }

  clearWaveform();
}

// ═════════════════════════════════════════════════════════════════════════════
//   TELA DE RESGATE
// ═════════════════════════════════════════════════════════════════════════════
function initRetrieve() {
  let lastRawText = '';

  const $inputSection  = document.getElementById('retrieve-input-section');
  const $loadingDiv    = document.getElementById('retrieve-loading');
  const $resultSection = document.getElementById('retrieve-result-section');
  const $pinInput      = document.getElementById('pin-input');
  const $btnFetch      = document.getElementById('btn-fetch');
  const $errorDiv      = document.getElementById('retrieve-error');
  const $reportSections = document.getElementById('report-sections');
  const $copyBtn       = document.getElementById('copy-btn');
  const $btnNewSearch  = document.getElementById('btn-new-search');

  document.getElementById('back-from-retrieve').addEventListener('click', () => {
    resetRetrieve();
    showView('home');
  });

  // Formata o input do PIN (só números, máx 4)
  $pinInput.addEventListener('input', () => {
    $pinInput.value = $pinInput.value.replace(/\D/g, '').slice(0, 4);
    $errorDiv.classList.add('hidden');
    if ($pinInput.value.length === 4) {
      $btnFetch.focus();
    }
  });

  $pinInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && $pinInput.value.length === 4) fetchReport();
  });

  $btnFetch.addEventListener('click', () => fetchReport());

  async function fetchReport() {
    const pin = $pinInput.value.trim();
    if (!/^\d{4}$/.test(pin)) {
      showRetrieveError('Digite exatamente 4 dígitos.');
      $pinInput.focus();
      return;
    }

    showRetrieveState('loading');

    try {
      const res = await fetch(`/api/get?pin=${encodeURIComponent(pin)}`);
      const data = await res.json();

      if (!res.ok) {
        showRetrieveState('input');
        showRetrieveError(data.error || 'PIN não encontrado ou expirado.');
        return;
      }

      lastRawText = data.report || '';
      renderReport(lastRawText);
      showRetrieveState('result');

    } catch (err) {
      showRetrieveState('input');
      showRetrieveError(`Erro de conexão: ${err.message}`);
    }
  }

  // ── Renderizar relatório ────────────────────────────────
  function renderReport(text) {
    $reportSections.innerHTML = '';
    const KEYS = Object.keys(SECTION_MAP);
    const lines = text.split('\n');
    let current = null;
    const sections = {};

    for (const line of lines) {
      const trimmed = line.trim();
      const matchedKey = KEYS.find(k => trimmed.startsWith(`- ${k}:`) || trimmed.startsWith(`${k}:`));
      if (matchedKey) {
        current = matchedKey;
        const val = trimmed.replace(`- ${matchedKey}:`, '').replace(`${matchedKey}:`, '').trim();
        sections[matchedKey] = val;
      } else if (current && trimmed) {
        sections[current] = (sections[current] + '\n' + trimmed).trim();
      }
    }

    // Força "O CLIENTE ALEGA" na reclamação
    if (sections['RECLAMACAO DO CLIENTE']) {
      let content = sections['RECLAMACAO DO CLIENTE'].trim();
      const prefixRegex = /^(O\s+)?CLIENTE\s+(ALEG|RELAT|RECLAM|QUEIX|INFORM)[A-Z]*(\s+QUE)?\s*/i;
      if (prefixRegex.test(content)) content = content.replace(prefixRegex, '');
      sections['RECLAMACAO DO CLIENTE'] = 'O CLIENTE ALEGA ' + content;
    }

    let cleanedText = '';
    let renderedCount = 0;

    if (Object.keys(sections).length === 0) {
      $reportSections.innerHTML = `<div class="report-section"><div class="section-tag">RELATÓRIO</div><div class="section-content">${escapeHTML(text)}</div></div>`;
      cleanedText = text;
    } else {
      KEYS.forEach(key => {
        const content = sections[key] || 'NAO INFORMADO';
        if (isNotMencionando(content)) return;

        cleanedText += `- ${key}:\n${content}\n`;
        renderedCount++;

        const meta = SECTION_MAP[key];
        const el = document.createElement('div');
        el.className = 'report-section';
        el.style.animationDelay = `${renderedCount * 0.08}s`;
        el.innerHTML = `
          <div class="section-tag ${meta.tag}">${meta.label}</div>
          <div class="section-content">${escapeHTML(content)}</div>
        `;
        $reportSections.appendChild(el);
      });

      if (renderedCount === 0) {
        $reportSections.innerHTML = `<div class="report-section"><div class="section-tag tag-reclamacao">AVISO</div><div class="section-content">NENHUMA INFORMAÇÃO ESPECÍFICA DETECTADA NO ÁUDIO.</div></div>`;
      }
    }

    lastRawText = cleanedText.trim() || text;
  }

  // ── Copiar ─────────────────────────────────────────────
  $copyBtn.addEventListener('click', async () => {
    if (!lastRawText) return;
    try {
      await navigator.clipboard.writeText(lastRawText);
      $copyBtn.innerHTML = `✓ Copiado!`;
      $copyBtn.classList.add('copied');
      showToast('Relatório copiado!', 'ok');
      setTimeout(() => {
        $copyBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar para OS`;
        $copyBtn.classList.remove('copied');
      }, 2000);
    } catch {
      showToast('Erro ao copiar. Selecione manualmente.', 'error');
    }
  });

  $btnNewSearch.addEventListener('click', () => resetRetrieve());

  // ── Helpers ─────────────────────────────────────────────
  function showRetrieveState(state) {
    $inputSection.classList.add('hidden');
    $loadingDiv.classList.add('hidden');
    $resultSection.classList.add('hidden');
    if (state === 'input') $inputSection.classList.remove('hidden');
    if (state === 'loading') $loadingDiv.classList.remove('hidden');
    if (state === 'result') $resultSection.classList.remove('hidden');
  }

  function showRetrieveError(msg) {
    $errorDiv.textContent = msg;
    $errorDiv.classList.remove('hidden');
  }

  function resetRetrieve() {
    lastRawText = '';
    $pinInput.value = '';
    $reportSections.innerHTML = '';
    $errorDiv.classList.add('hidden');
    showRetrieveState('input');
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//   SETTINGS MODAL
// ═════════════════════════════════════════════════════════════════════════════
function initSettings() {
  const $modal      = document.getElementById('settings-modal');
  const $apiInput   = document.getElementById('api-key-input');
  const $toggleVis  = document.getElementById('toggle-vis');
  const $saveBtn    = document.getElementById('save-key-btn');
  const $savedMsg   = document.getElementById('key-saved-msg');
  const $closeBtn   = document.getElementById('modal-close');

  // Todos os botões de settings abrem o modal
  ['settings-btn-home', 'settings-btn-record'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', openSettingsModal);
  });

  $closeBtn.addEventListener('click', closeSettingsModal);
  $modal.addEventListener('click', e => { if (e.target === $modal) closeSettingsModal(); });

  $toggleVis.addEventListener('click', () => {
    $apiInput.type = $apiInput.type === 'password' ? 'text' : 'password';
  });

  $saveBtn.addEventListener('click', () => {
    const key = $apiInput.value.trim();
    if (!key) { showToast('Insira uma chave válida', 'error'); return; }
    localStorage.setItem(STORAGE_KEY, key);
    $savedMsg.classList.remove('hidden');
    showToast('Chave API salva!', 'ok');
    setTimeout(() => closeSettingsModal(), 1200);
  });

  function openSettingsModal() {
    $apiInput.value = localStorage.getItem(STORAGE_KEY) || '';
    $savedMsg.classList.add('hidden');
    $modal.classList.remove('hidden');
    $apiInput.focus();
  }

  function closeSettingsModal() {
    $modal.classList.add('hidden');
  }
}

// ── openSettingsModal global (usado no record) ──────────────────────────────
function openSettingsModal() {
  document.getElementById('settings-modal').classList.remove('hidden');
  const $apiInput = document.getElementById('api-key-input');
  $apiInput.value = localStorage.getItem(STORAGE_KEY) || '';
  $apiInput.focus();
}

// ═════════════════════════════════════════════════════════════════════════════
//   UTILITÁRIOS COMPARTILHADOS
// ═════════════════════════════════════════════════════════════════════════════

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
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
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}

function showToast(msg, type = 'info') {
  const $toast = document.getElementById('toast');
  $toast.textContent = msg;
  $toast.className = `toast toast-${type} show`;
  setTimeout(() => { $toast.className = 'toast hidden'; }, 3000);
}

function normalizeForNBS(text) {
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
