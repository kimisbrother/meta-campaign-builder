/**
 * ============================================================
 * 캠페인 빌더 앱 로직
 * ============================================================
 */

// ---------------- 전역 상태 ----------------

const STATE = {
  mode: null, // 'new' | 'edit'
  brand: null,
  defaults: {}, // 브랜드 디폴트 값 (헤더명 -> 값)
  campaign: {}, // 캠페인 레벨 필드값
  adsets: [],   // [{ id, fields:{}, ads:[{id, fields:{}, creative:{...}}] }]
  isEditingExisting: false,
};

let adsetSeq = 0;
let adSeq = 0;

// ---------------- API 래퍼 ----------------

const API = {
  base() { return window.APP_CONFIG.APPS_SCRIPT_URL; },

  async get(action, params) {
    const url = new URL(this.base());
    url.searchParams.set('action', action);
    Object.entries(params || {}).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString());
    return res.json();
  },

  async post(action, payload) {
    const res = await fetch(this.base(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script doPost 호환을 위해 text/plain 사용
      body: JSON.stringify({ action, payload }),
    });
    return res.json();
  },
};

// ---------------- 유틸 ----------------

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

function showToast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 3200);
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function uid(prefix) { return prefix + '_' + Math.random().toString(36).slice(2, 9); }

function getVal(obj, key, fallback) {
  if (obj && obj[key] !== undefined && obj[key] !== '') return obj[key];
  return fallback !== undefined ? fallback : '';
}

// AM/PM 시간 선택 <-> "MM/DD/YY HH:MM" 변환
function buildDateTimeInputs(idPrefix, initialValue) {
  let date = '', hour = '12', minute = '00', ampm = 'PM';
  if (initialValue) {
    // 형식: MM/DD/YY HH:MM (24h) 가정, 혹은 ISO 형태 대응
    const m = initialValue.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})/);
    if (m) {
      let [, mm, dd, yy, hh, mi] = m;
      if (yy.length === 2) yy = '20' + yy;
      date = `${yy.padStart(4, '0')}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
      let h = parseInt(hh, 10);
      ampm = h >= 12 ? 'PM' : 'AM';
      h = h % 12; if (h === 0) h = 12;
      hour = String(h).padStart(2, '0');
      minute = mi;
    }
  }
  return `
    <div class="dt-row">
      <input type="date" id="${idPrefix}_date" value="${date}">
      <select id="${idPrefix}_hour">${Array.from({length:12},(_,i)=>i+1).map(h=>`<option value="${String(h).padStart(2,'0')}" ${String(h).padStart(2,'0')===hour?'selected':''}>${h}시</option>`).join('')}</select>
      <select id="${idPrefix}_minute">${['00','15','30','45'].map(m=>`<option value="${m}" ${m===minute?'selected':''}>${m}분</option>`).join('')}</select>
      <select id="${idPrefix}_ampm">
        <option value="AM" ${ampm==='AM'?'selected':''}>오전</option>
        <option value="PM" ${ampm==='PM'?'selected':''}>오후</option>
      </select>
    </div>`;
}

function readDateTimeInputs(idPrefix) {
  const date = $('#' + idPrefix + '_date')?.value;
  if (!date) return '';
  const hour = $('#' + idPrefix + '_hour').value;
  const minute = $('#' + idPrefix + '_minute').value;
  const ampm = $('#' + idPrefix + '_ampm').value;
  let h = parseInt(hour, 10);
  if (ampm === 'PM' && h !== 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  const [yy, mm, dd] = date.split('-');
  const yy2 = yy.slice(2);
  return `${mm}/${dd}/${yy2} ${String(h).padStart(2,'0')}:${minute}`;
}

// ---------------- 연결 상태 체크 ----------------

async function checkConnection() {
  const pill = $('#connStatus');
  const text = $('#connStatusText');
  if (!window.APP_CONFIG.APPS_SCRIPT_URL || window.APP_CONFIG.APPS_SCRIPT_URL.indexOf('PASTE_YOUR') !== -1) {
    pill.className = 'status-pill err';
    text.textContent = '설정 필요: config.js에 Apps Script URL을 입력하세요';
    return false;
  }
  try {
    const res = await API.get('getColumns', {});
    if (res.error) throw new Error(res.error);
    pill.className = 'status-pill ok';
    text.textContent = '스프레드시트 연결됨';
    return true;
  } catch (e) {
    pill.className = 'status-pill err';
    text.textContent = '연결 실패 — Apps Script 배포 상태를 확인하세요';
    return false;
  }
}

// ---------------- 모드 선택 ----------------

function initModeSelect() {
  $('#modeCardNew').addEventListener('click', () => selectMode('new'));
  $('#modeCardEdit').addEventListener('click', () => selectMode('edit'));
}

function selectMode(mode) {
  STATE.mode = mode;
  $('#modeCardNew').classList.toggle('active', mode === 'new');
  $('#modeCardEdit').classList.toggle('active', mode === 'edit');
  $('#newBrandSection').classList.toggle('hidden', mode !== 'new');
  $('#editSearchSection').classList.toggle('hidden', mode !== 'edit');

  if (mode === 'new') {
    renderBrandGrid();
  } else {
    $('#builderRoot').classList.add('hidden');
    $('#actionbar').classList.add('hidden');
  }
}

function renderBrandGrid() {
  const grid = $('#brandGrid');
  grid.innerHTML = window.APP_CONFIG.BRANDS.map(b => `
    <div class="mode-card" data-brand="${b.key}" style="padding:14px;">
      <h3 style="font-size:13.5px;">${b.label}</h3>
      <p class="mono" style="font-size:11px;">${b.key}</p>
    </div>
  `).join('');
  $all('.mode-card', grid).forEach(card => {
    card.addEventListener('click', async () => {
      $all('.mode-card', grid).forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      const brandKey = card.dataset.brand;
      await startNewCampaign(brandKey);
    });
  });
}

// ---------------- 신규 캠페인 시작 ----------------

async function startNewCampaign(brandKey) {
  STATE.brand = brandKey;
  STATE.isEditingExisting = false;
  showToast('브랜드 디폴트 값을 불러오는 중…');
  let defaultsRes;
  try {
    defaultsRes = await API.get('getDefaults', { brand: brandKey });
  } catch (e) {
    defaultsRes = { defaults: {} };
  }
  STATE.defaults = Object.assign({}, window.STATIC_DEFAULTS, defaultsRes.defaults || {});

  STATE.campaign = Object.assign({}, STATE.defaults, { 'Campaign Name': '', 'Campaign ID': '' });
  STATE.adsets = [makeNewAdset()];

  renderBuilder();
  showToast(`${brandKey} 디폴트 값 적용 완료 (샘플 ${defaultsRes.sampleSize || 0}건 기준)`);
}

function makeNewAdset() {
  return {
    _key: uid('adset'),
    fields: Object.assign({}, STATE.defaults, { 'Ad Set Name': '', 'Ad Set ID': '' }),
    ads: [makeNewAd()],
  };
}

function makeNewAd() {
  return {
    _key: uid('ad'),
    fields: Object.assign({}, STATE.defaults, { 'Ad Name': '', 'Ad ID': '', 'Title': '', 'Body': '' }),
    creative: null, // { id, name, path, mimeType, thumbnail }
  };
}

// ---------------- 기존 캠페인 검색 ----------------

function initEditSearch() {
  const input = $('#campaignSearchInput');
  const results = $('#campaignSearchResults');
  let highlightedIdx = -1;
  let currentItems = [];

  const doSearch = debounce(async (q) => {
    try {
      const res = await API.get('searchCampaigns', { q });
      currentItems = res.items || [];
      renderResults();
    } catch (e) {
      results.innerHTML = `<div class="search-empty">검색 실패: ${e.message}</div>`;
      results.classList.add('show');
    }
  }, 250);

  function renderResults() {
    if (currentItems.length === 0) {
      results.innerHTML = `<div class="search-empty">일치하는 캠페인이 없습니다</div>`;
    } else {
      results.innerHTML = currentItems.map((item, i) => `
        <div class="search-item" data-idx="${i}">
          <div>
            <div class="si-main">${escapeHtml(item.campaignName)}</div>
            <div class="si-sub">${item.brand} · ${item.status || '-'}</div>
          </div>
          <div class="si-sub mono">${item.campaignId || 'ID 없음'}</div>
        </div>
      `).join('');
      $all('.search-item', results).forEach(el => {
        el.addEventListener('click', () => {
          const item = currentItems[parseInt(el.dataset.idx, 10)];
          selectExistingCampaign(item);
          results.classList.remove('show');
          input.value = item.campaignName;
        });
      });
    }
    results.classList.add('show');
    highlightedIdx = -1;
  }

  input.addEventListener('input', () => {
    doSearch(input.value.trim());
  });
  input.addEventListener('focus', () => {
    if (input.value.trim()) doSearch(input.value.trim());
    else doSearch('');
  });
  input.addEventListener('keydown', (e) => {
    const items = $all('.search-item', results);
    if (e.key === 'ArrowDown') { e.preventDefault(); highlightedIdx = Math.min(highlightedIdx + 1, items.length - 1); updateHighlight(items); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlightedIdx = Math.max(highlightedIdx - 1, 0); updateHighlight(items); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[highlightedIdx]) items[highlightedIdx].click(); }
    else if (e.key === 'Escape') { results.classList.remove('show'); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) results.classList.remove('show');
  });

  function updateHighlight(items) {
    items.forEach((it, i) => it.classList.toggle('highlighted', i === highlightedIdx));
    if (items[highlightedIdx]) items[highlightedIdx].scrollIntoView({ block: 'nearest' });
  }
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function selectExistingCampaign(item) {
  showToast('캠페인 정보를 불러오는 중…');
  try {
    const res = await API.get('getCampaignTree', { campaignId: item.campaignId, campaignName: item.campaignName });
    if (res.error) { showToast('캠페인을 찾을 수 없습니다', true); return; }

    STATE.mode = 'edit';
    STATE.brand = item.brand;
    STATE.isEditingExisting = true;

    const defaultsRes = await API.get('getDefaults', { brand: item.brand });
    STATE.defaults = Object.assign({}, window.STATIC_DEFAULTS, defaultsRes.defaults || {});

    STATE.campaign = res.campaign;
    STATE.adsets = res.adsets.map(as => ({
      _key: uid('adset'),
      fields: as.fields,
      ads: as.ads.map(ad => ({
        _key: uid('ad'),
        fields: ad,
        creative: ad['Video File Name'] || ad['Image File Name']
          ? { name: ad['Video File Name'] || ad['Image File Name'], path: '', thumbnail: '' }
          : null,
      })),
    }));

    renderBuilder();
    showToast(`"${item.campaignName}" 불러옴 — 광고 세트 ${STATE.adsets.length}개`);
  } catch (e) {
    showToast('불러오기 실패: ' + e.message, true);
  }
}

// ---------------- 빌더 렌더링 ----------------

function renderBuilder() {
  $('#builderRoot').classList.remove('hidden');
  $('#actionbar').classList.remove('hidden');
  const root = $('#builderRoot');
  root.innerHTML = '';
  root.appendChild(renderCampaignSection());
  root.appendChild(renderAdsetsContainer());
  updateActionbarSummary();
}

function renderCampaignSection() {
  const wrap = document.createElement('div');
  wrap.className = 'section';

  const coreFields = window.FIELD_GROUPS.campaign.core;
  const collapsedGroups = window.FIELD_GROUPS.campaign.collapsedGroups;

  wrap.innerHTML = `
    <div class="section-head">
      <h2>① 캠페인 설정 <span class="badge">${STATE.brand || ''}</span></h2>
    </div>
    <div class="section-body">
      <div class="field-grid" id="campaignCoreFields"></div>
    </div>
    <div id="campaignCollapsedGroups"></div>
  `;

  const coreContainer = $('#campaignCoreFields', wrap);
  coreFields.forEach(f => coreContainer.appendChild(renderField(f, STATE.campaign, (key, val) => { STATE.campaign[key] = val; })));

  const collapsedContainer = $('#campaignCollapsedGroups', wrap);
  collapsedGroups.forEach((g, i) => collapsedContainer.appendChild(renderCollapsibleGroup(g, STATE.campaign, (key, val) => { STATE.campaign[key] = val; }, `camp_grp_${i}`)));

  return wrap;
}

function renderCollapsibleGroup(group, dataObj, onChange, idPrefix) {
  const wrap = document.createElement('div');
  wrap.className = 'collapsible';
  wrap.innerHTML = `
    <div class="collapsible-head">
      <div class="ch-title"><span class="chevron">▸</span> ${group.title}</div>
      <span class="ch-count">${group.fields.length}개 항목</span>
    </div>
    <div class="collapsible-body">
      <div class="field-grid" id="${idPrefix}_fields"></div>
    </div>
  `;
  $('.collapsible-head', wrap).addEventListener('click', () => wrap.classList.toggle('open'));
  const fieldsContainer = $('#' + idPrefix + '_fields', wrap);
  group.fields.forEach(f => fieldsContainer.appendChild(renderField(f, dataObj, onChange)));
  return wrap;
}

function renderField(f, dataObj, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'field' + (f.type === 'textarea' || f.type === 'creative_picker' ? ' span2' : '');
  const currentVal = getVal(dataObj, f.key, '');

  const labelHtml = `<label>${f.label}${f.required ? '<span class="req">필수</span>' : ''}</label>`;

  if (f.type === 'select') {
    const opts = f.options.map(o => `<option value="${escapeHtml(o)}" ${o === currentVal ? 'selected' : ''}>${o || '(선택 안함)'}</option>`).join('');
    wrap.innerHTML = `${labelHtml}<select>${opts}</select>`;
    $('select', wrap).addEventListener('change', (e) => onChange(f.key, e.target.value));
  } else if (f.type === 'textarea') {
    wrap.innerHTML = `${labelHtml}<textarea>${escapeHtml(currentVal)}</textarea>${f.maxLength ? `<div class="charcount">0/${f.maxLength}</div>` : ''}`;
    const ta = $('textarea', wrap);
    const cc = $('.charcount', wrap);
    const updateCount = () => {
      if (cc) {
        cc.textContent = `${ta.value.length}/${f.maxLength}`;
        cc.classList.toggle('over', ta.value.length > f.maxLength);
      }
    };
    updateCount();
    ta.addEventListener('input', () => { onChange(f.key, ta.value); updateCount(); });
  } else if (f.type === 'datetime') {
    const idPrefix = uid('dt');
    wrap.innerHTML = `${labelHtml}${buildDateTimeInputs(idPrefix, currentVal)}`;
    $all('input,select', wrap).forEach(el => el.addEventListener('change', () => onChange(f.key, readDateTimeInputs(idPrefix))));
  } else if (f.type === 'creative_picker') {
    wrap.innerHTML = `${labelHtml}<div id="creative_slot"></div>`;
    // creative_picker는 광고 렌더링 시 별도 처리 (renderAdCard에서 직접 호출)
  } else {
    const inputType = f.type === 'url' ? 'url' : (f.type === 'number' ? 'number' : 'text');
    wrap.innerHTML = `${labelHtml}<input type="${inputType}" value="${escapeHtml(currentVal)}" ${f.maxLength ? `maxlength="${f.maxLength}"` : ''}>${f.maxLength ? `<div class="charcount">0/${f.maxLength}</div>` : ''}`;
    const inp = $('input', wrap);
    const cc = $('.charcount', wrap);
    const updateCount = () => {
      if (cc) {
        cc.textContent = `${inp.value.length}/${f.maxLength}`;
        cc.classList.toggle('over', inp.value.length > f.maxLength);
      }
    };
    updateCount();
    inp.addEventListener('input', () => { onChange(f.key, inp.value); updateCount(); });
  }
  return wrap;
}

// ---------------- 광고 세트 / 광고 트리 ----------------

function renderAdsetsContainer() {
  const wrap = document.createElement('div');
  wrap.id = 'adsetsContainer';
  refreshAdsetsContainer(wrap);
  return wrap;
}

function refreshAdsetsContainer(container) {
  container = container || $('#adsetsContainer');
  container.innerHTML = '';

  const headerSection = document.createElement('div');
  headerSection.className = 'section';
  headerSection.innerHTML = `<div class="section-head"><h2>② 광고 세트 &amp; 광고</h2><span class="badge">${STATE.adsets.length}개 세트</span></div>`;
  container.appendChild(headerSection);

  STATE.adsets.forEach((adset, idx) => {
    container.appendChild(renderAdsetCard(adset, idx));
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'add-btn';
  addBtn.textContent = '+ 광고 세트 추가';
  addBtn.style.marginBottom = '16px';
  addBtn.addEventListener('click', () => {
    STATE.adsets.push(makeNewAdset());
    refreshAdsetsContainer();
    updateActionbarSummary();
  });
  container.appendChild(addBtn);
}

function renderAdsetCard(adset, idx) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-adset';

  const head = document.createElement('div');
  head.className = 'tree-adset-head';
  head.innerHTML = `
    <div class="left"><span class="tag">광고세트 ${idx + 1}</span><span class="name-preview">${escapeHtml(adset.fields['Ad Set Name'] || '(이름 미입력)')}</span></div>
  `;
  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn';
  delBtn.innerHTML = '✕';
  delBtn.title = '광고 세트 삭제';
  delBtn.addEventListener('click', () => {
    if (STATE.adsets.length <= 1) { showToast('캠페인에는 최소 1개의 광고 세트가 필요합니다', true); return; }
    if (!confirm('이 광고 세트와 포함된 모든 광고를 삭제할까요?')) return;
    STATE.adsets.splice(idx, 1);
    refreshAdsetsContainer();
    updateActionbarSummary();
  });
  head.appendChild(delBtn);
  wrap.appendChild(head);

  const body = document.createElement('div');
  body.className = 'adset-body';

  const coreGrid = document.createElement('div');
  coreGrid.className = 'field-grid';
  window.FIELD_GROUPS.adset.core.forEach(f => {
    const fieldEl = renderField(f, adset.fields, (key, val) => {
      adset.fields[key] = val;
      if (key === 'Ad Set Name') head.querySelector('.name-preview').textContent = val || '(이름 미입력)';
    });
    coreGrid.appendChild(fieldEl);
  });
  body.appendChild(coreGrid);

  window.FIELD_GROUPS.adset.collapsedGroups.forEach((g, gi) => {
    body.appendChild(renderCollapsibleGroup(g, adset.fields, (key, val) => { adset.fields[key] = val; }, `adset_${adset._key}_grp_${gi}`));
  });

  wrap.appendChild(body);

  adset.ads.forEach((ad, adIdx) => {
    wrap.appendChild(renderAdCard(ad, adIdx, adset, idx));
  });

  const addAdBtn = document.createElement('button');
  addAdBtn.className = 'add-btn';
  addAdBtn.textContent = '+ 광고 추가';
  addAdBtn.style.margin = '0 16px 16px';
  addAdBtn.style.width = 'calc(100% - 32px)';
  addAdBtn.addEventListener('click', () => {
    adset.ads.push(makeNewAd());
    refreshAdsetsContainer();
    updateActionbarSummary();
  });
  wrap.appendChild(addAdBtn);

  return wrap;
}

function renderAdCard(ad, adIdx, adset, adsetIdx) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-ad';

  const head = document.createElement('div');
  head.className = 'tree-ad-head';
  head.innerHTML = `<div class="left"><span class="tag">광고 ${adIdx + 1}</span><span class="name-preview">${escapeHtml(ad.fields['Ad Name'] || '(이름 미입력)')}</span></div>`;
  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn';
  delBtn.innerHTML = '✕';
  delBtn.title = '광고 삭제';
  delBtn.addEventListener('click', () => {
    if (adset.ads.length <= 1) { showToast('광고 세트에는 최소 1개의 광고가 필요합니다', true); return; }
    if (!confirm('이 광고를 삭제할까요?')) return;
    adset.ads.splice(adIdx, 1);
    refreshAdsetsContainer();
    updateActionbarSummary();
  });
  head.appendChild(delBtn);
  wrap.appendChild(head);

  const coreGrid = document.createElement('div');
  coreGrid.className = 'field-grid';

  window.FIELD_GROUPS.ad.core.forEach(f => {
    if (f.type === 'creative_picker') {
      const fieldWrap = document.createElement('div');
      fieldWrap.className = 'field span2';
      fieldWrap.innerHTML = `<label>${f.label}<span class="req">필수</span></label>`;
      const picker = renderCreativePicker(ad, (creative) => {
        ad.creative = creative;
        ad.fields['Video File Name'] = creative.mimeType && creative.mimeType.indexOf('video') !== -1 ? creative.name : '';
        ad.fields['Image File Name'] = creative.mimeType && creative.mimeType.indexOf('image') !== -1 ? creative.name : '';
      });
      fieldWrap.appendChild(picker);
      coreGrid.appendChild(fieldWrap);
    } else {
      const fieldEl = renderField(f, ad.fields, (key, val) => {
        ad.fields[key] = val;
        if (key === 'Ad Name') head.querySelector('.name-preview').textContent = val || '(이름 미입력)';
      });
      coreGrid.appendChild(fieldEl);
    }
  });
  wrap.appendChild(coreGrid);

  window.FIELD_GROUPS.ad.collapsedGroups.forEach((g, gi) => {
    wrap.appendChild(renderCollapsibleGroup(g, ad.fields, (key, val) => { ad.fields[key] = val; }, `ad_${ad._key}_grp_${gi}`));
  });

  return wrap;
}

// ---------------- 소재 선택기 (드라이브 검색) ----------------

function renderCreativePicker(ad, onSelect) {
  const wrap = document.createElement('div');
  wrap.className = 'creative-picker';

  function renderSelectedView() {
    if (ad.creative) {
      wrap.innerHTML = `
        <div class="creative-selected">
          <img class="thumb" src="${ad.creative.thumbnail || ''}" onerror="this.style.visibility='hidden'">
          <div class="info">
            <div class="name">${escapeHtml(ad.creative.name)}</div>
            <div class="path">${escapeHtml(ad.creative.path || '')}</div>
          </div>
          <button class="icon-btn" style="border:none;">↺</button>
        </div>
      `;
      $('.icon-btn', wrap).addEventListener('click', (e) => { e.stopPropagation(); ad.creative = null; renderSelectedView(); });
      $('.creative-selected', wrap).addEventListener('click', () => renderSearchView());
    } else {
      renderSearchView();
    }
  }

  function renderSearchView() {
    wrap.innerHTML = `
      <input type="text" class="search-input" placeholder="소재 이름으로 검색 (드라이브 폴더 연동)" autocomplete="off">
      <div class="creative-results"></div>
    `;
    const input = $('.search-input', wrap);
    const results = $('.creative-results', wrap);
    let items = [];
    let highlightedIdx = -1;

    const doSearch = debounce(async (q) => {
      try {
        const res = await API.get('searchCreatives', { q, brand: STATE.brand || '' });
        items = res.items || [];
        renderItems();
      } catch (e) {
        results.innerHTML = `<div class="search-empty">검색 실패: ${e.message}</div>`;
        results.classList.add('show');
      }
    }, 250);

    function renderItems() {
      if (items.length === 0) {
        results.innerHTML = `<div class="search-empty">일치하는 소재가 없습니다</div>`;
      } else {
        results.innerHTML = items.map((it, i) => `
          <div class="creative-item" data-idx="${i}">
            <img class="thumb" src="${it.thumbnail}" onerror="this.style.visibility='hidden'">
            <div class="meta">
              <div class="name">${escapeHtml(it.name)}</div>
              <div class="path">${escapeHtml(it.path || '')}</div>
            </div>
          </div>
        `).join('');
        $all('.creative-item', results).forEach(el => {
          el.addEventListener('click', () => {
            const item = items[parseInt(el.dataset.idx, 10)];
            onSelect(item);
            renderSelectedView();
          });
        });
      }
      results.classList.add('show');
      highlightedIdx = -1;
    }

    input.addEventListener('input', () => doSearch(input.value.trim()));
    input.addEventListener('focus', () => doSearch(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      const els = $all('.creative-item', results);
      if (e.key === 'ArrowDown') { e.preventDefault(); highlightedIdx = Math.min(highlightedIdx + 1, els.length - 1); updateHi(els); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); highlightedIdx = Math.max(highlightedIdx - 1, 0); updateHi(els); }
      else if (e.key === 'Enter') { e.preventDefault(); if (els[highlightedIdx]) els[highlightedIdx].click(); }
    });
    function updateHi(els) {
      els.forEach((el, i) => el.classList.toggle('highlighted', i === highlightedIdx));
      if (els[highlightedIdx]) els[highlightedIdx].scrollIntoView({ block: 'nearest' });
    }
    setTimeout(() => input.focus(), 0);
  }

  renderSelectedView();
  return wrap;
}

// ---------------- 액션바 / 저장 / export ----------------

function updateActionbarSummary() {
  const totalAds = STATE.adsets.reduce((sum, a) => sum + a.ads.length, 0);
  $('#actionbarSummary').innerHTML = `캠페인 <b>1개</b> · 광고 세트 <b>${STATE.adsets.length}개</b> · 광고 <b>${totalAds}개</b>`;
}

function buildExportRows() {
  const rows = [];
  STATE.adsets.forEach(adset => {
    adset.ads.forEach(ad => {
      const merged = Object.assign({}, STATE.campaign, adset.fields, ad.fields);
      const row = window.FULL_COLUMNS.map(col => merged[col] !== undefined ? merged[col] : '');
      rows.push(row);
    });
  });
  return rows;
}

function validateBeforeSubmit() {
  const errors = [];
  if (!STATE.campaign['Campaign Name']) errors.push('캠페인 이름을 입력하세요');
  STATE.adsets.forEach((adset, i) => {
    if (!adset.fields['Ad Set Name']) errors.push(`광고 세트 ${i+1}: 이름을 입력하세요`);
    if (!adset.fields['Link']) errors.push(`광고 세트 ${i+1}: 랜딩 URL을 입력하세요`);
    adset.ads.forEach((ad, j) => {
      if (!ad.fields['Ad Name']) errors.push(`광고 세트 ${i+1} / 광고 ${j+1}: 이름을 입력하세요`);
      if (!ad.creative && !ad.fields['Video File Name'] && !ad.fields['Image File Name']) errors.push(`광고 세트 ${i+1} / 광고 ${j+1}: 소재를 선택하세요`);
      if (!ad.fields['Title']) errors.push(`광고 세트 ${i+1} / 광고 ${j+1}: 제목을 입력하세요`);
      if (!ad.fields['Body']) errors.push(`광고 세트 ${i+1} / 광고 ${j+1}: 본문을 입력하세요`);
    });
  });
  return errors;
}

function initActionbar() {
  $('#btnReset').addEventListener('click', () => {
    if (!confirm('처음부터 다시 시작할까요? 입력한 내용이 모두 사라집니다.')) return;
    location.reload();
  });

  $('#btnExport').addEventListener('click', () => {
    const errors = validateBeforeSubmit();
    if (errors.length) { showToast(errors[0] + (errors.length > 1 ? ` 외 ${errors.length - 1}건` : ''), true); return; }
    const rows = buildExportRows();
    const ws = XLSX.utils.aoa_to_sheet([window.FULL_COLUMNS, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const campName = (STATE.campaign['Campaign Name'] || 'campaign').replace(/[^\w가-힣\-]/g, '_');
    XLSX.writeFile(wb, `export_${campName}_${Date.now()}.xlsx`);
    showToast('엑셀 파일을 다운로드했습니다');
  });

  $('#btnSaveSheet').addEventListener('click', async () => {
    const errors = validateBeforeSubmit();
    if (errors.length) { showToast(errors[0] + (errors.length > 1 ? ` 외 ${errors.length - 1}건` : ''), true); return; }

    const btn = $('#btnSaveSheet');
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 저장 중…';

    try {
      const payload = {
        campaign: STATE.campaign,
        adsets: STATE.adsets.map(a => ({ fields: a.fields, ads: a.ads.map(ad => ad.fields) })),
      };
      const res = await API.post('saveCampaign', payload);
      if (res.error) throw new Error(res.error);
      showToast(`저장 완료 — 신규 ${res.inserted}건, 수정 ${res.updated}건`);
    } catch (e) {
      showToast('저장 실패: ' + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  });
}

// ---------------- 초기화 ----------------

document.addEventListener('DOMContentLoaded', () => {
  checkConnection();
  initModeSelect();
  initEditSearch();
  initActionbar();
});
