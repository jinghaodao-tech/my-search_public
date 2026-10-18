// What this instance offers (GET /api/features): hide the AI box without an AI key,
// and show a notice with the sample documents on the public demo.
let appFeatures = { demo: false, ai: false, pdfMaxMb: 30, samples: [] };

async function loadAppFeatures() {
  try { appFeatures = await api.get('/api/features'); } catch { return; }
  // AI buttons (summaries, synonyms) are shown when Chrome's on-device AI can be used
  // (downloaded on first use) or, failing that, when this instance has an AI key.
  const localState = typeof localAi !== 'undefined' ? await localAi.availability('prompt') : 'unavailable';
  appFeatures.localAi = localState;
  document.body.classList.toggle('no-ai', localState === 'unavailable' && !appFeatures.ai);
  const pdfButton = document.querySelector('[onclick="chooseReaderPdf()"]');
  if (pdfButton) pdfButton.title = `手元のPDF（論文・技術書など、DRMの無いもの・${appFeatures.pdfMaxMb}MBまで）を開く`;
  if (appFeatures.demo) {
    renderDemoBanner();
    // Only a few sample documents: show every one that matches at all (instead of moving low scores to the archive).
    if (typeof syncParam === 'function') {
      syncParam('arch', 0.01);
      const input = document.getElementById('p-arch');
      if (input) input.value = '0.01';
    }
  }
}

function renderDemoBanner() {
  const banner = document.getElementById('demo-banner');
  if (!banner) return;
  banner.textContent = '';
  const text = document.createElement('span');
  text.textContent = 'デモ版です。データは全員で共有され、しばらく使われないと見本の状態に戻ります。個人的な内容は入れないでください。見本: ';
  banner.appendChild(text);
  for (const sample of appFeatures.samples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'demo-sample';
    button.textContent = sample.title;
    button.onclick = () => openReader(sample.url);
    banner.appendChild(button);
    if (sample.download) {
      const link = document.createElement('a');
      link.href = sample.download;
      link.download = '';
      link.textContent = '（PDFをダウンロードして「PDFを開く」でも試せます）';
      banner.appendChild(link);
    }
  }
  banner.hidden = false;
}

document.addEventListener('DOMContentLoaded', loadAppFeatures);
