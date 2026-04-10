function app() {
  const REQUIRED_COPY_PLATFORMS = 3;
  const CURRENT_APP_VERSION = '1.6.0';
  const LAST_SEEN_VERSION_KEY = 'sheet-to-car:last-seen-version';
  const CHANGELOG = [
    {
      version: '1.6.0',
      notes: [
        '8891 會先做 post-helper 相容驗證，直接顯示可用、警告或阻塞問題。',
        '儀表板會集中列出 8891 待修正車輛，可直接跳到該車處理。',
        '新車分析支援照片判讀與人工確認後回寫車輛資料。',
        '文案生成會明確吃已確認特徵與 VIN decode 輔助資訊。',
      ],
    },
    {
      version: '1.5.0',
      notes: [
        '新增新車基礎特徵分析與待注意提醒。',
        '支援照片分析改裝、特仕線索與可補進介紹的句子。',
        '每份文案會顯示已確認特徵數與未確認欄位數。',
      ],
    },
  ];

  function compareVersions(a, b) {
    const aParts = String(a || '').split('.').map(n => Number(n) || 0);
    const bParts = String(b || '').split('.').map(n => Number(n) || 0);
    const max = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < max; i++) {
      const diff = (aParts[i] || 0) - (bParts[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  return {
    view: 'dashboard',
    loading: false,
    syncing: false,
    cars: [],
    stats: {},
    filter: { search: '', status: '', poStatus: '', copyStatus: '' },
    copySummary: {}, // { item: { count, platforms } }
    sort: { key: 'item', asc: false },
    dark: localStorage.getItem('dark') === 'true',
    lastUpdated: null,
    batchRunning: false,
    batchProgress: null,
    batchLimit: 5,
    maxSelect: 20,
    copyToast: '',
    selectedItems: new Set(),
    pendingAnalyses: [],
    validationBlockers8891: [],
    showUpdateModal: false,
    updateNotes: [],
    currentVersion: CURRENT_APP_VERSION,

    // Pagination
    page: 1,
    pageSize: 50,
    totalCars: 0,
    hasMore: true,
    loadingMore: false,
    _searchDebounce: null,

    // Expanded car row
    expandedItem: null,
    expandedCopies: [],
    expandedAnalysis: null,
    expandedPhotoAnalysis: null,
    lastGenerationInfo: null,
    analysisPhotoFiles: [],
    photoAnalysisRunning: false,
    reviewDrafts: {},
    generating: false,
    generatingItem: '',
    generatingPlatform: '',

    // Chat
    chatMessages: [],
    chatInput: '',
    chatStreaming: false,
    streamingText: '',
    sessionId: crypto.randomUUID(),

    // Settings
    settingsData: {},
    spreadsheetId: '',
    apiKeys: [],
    usageStats: {},
    newApiKey: '',
    batchKeyText: '',
    settingsLoaded: false,
    systemPrompt: '',
    platformPrompts: {},
    showPlatformPrompt: '',
    activePlatformTab: '',
    editingPlatformPrompt: '',
    platformPromptSaved: false,
    platformPromptSavedMsg: '',
    userPrefs: {},
    teamMembers: [],

    async init() {
      this.applyDark();
      this.prepareVersionUpdateNotice();
      await Promise.all([this.loadCars(true), this.loadStats(), this.checkBatchStatus(), this.loadCopySummary(), this.loadPendingAnalyses(), this.load8891ValidationBlockers()]);

      // Watch filters — reload on change
      this.$watch('filter.status', () => this.loadCars(true));
      this.$watch('filter.poStatus', () => this.loadCars(true));
      this.$watch('filter.copyStatus', () => this.loadCars(true));
      this.$watch('filter.search', () => {
        clearTimeout(this._searchDebounce);
        this._searchDebounce = setTimeout(() => this.loadCars(true), 300);
      });

      this.$nextTick(() => this.setupScrollObserver());
    },

    setupScrollObserver() {
      const sentinel = document.getElementById('scroll-sentinel');
      if (!sentinel) return;
      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) {
          this.loadNextPage();
        }
      }, { rootMargin: '200px' });
      observer.observe(sentinel);
    },

    async loadCopySummary() {
      try {
        const resp = await fetch('/api/copies/summary/all');
        this.copySummary = await resp.json();
      } catch {}
    },

    async loadPendingAnalyses() {
      try {
        const resp = await fetch('/api/analysis/pending');
        const data = await resp.json();
        this.pendingAnalyses = data.items || [];
      } catch {}
    },

    async load8891ValidationBlockers() {
      try {
        const resp = await fetch('/api/copies/validation/8891-blockers');
        const data = await resp.json();
        this.validationBlockers8891 = data.items || [];
      } catch {}
    },

    prepareVersionUpdateNotice() {
      const lastSeenVersion = localStorage.getItem(LAST_SEEN_VERSION_KEY) || '0.0.0';
      const unseen = CHANGELOG.filter(entry => compareVersions(entry.version, lastSeenVersion) > 0)
        .sort((a, b) => compareVersions(b.version, a.version));

      if (unseen.length === 0) {
        return;
      }

      this.updateNotes = unseen.flatMap(entry => entry.notes.map(note => ({ version: entry.version, text: note })));
      this.showUpdateModal = true;
    },

    dismissUpdateModal() {
      localStorage.setItem(LAST_SEEN_VERSION_KEY, CURRENT_APP_VERSION);
      this.showUpdateModal = false;
    },

    getCopyStatus(item) {
      const s = this.copySummary[item];
      if (!s) return '未生成';
      return s.platforms >= REQUIRED_COPY_PLATFORMS ? '完整' : '部分';
    },

    async checkBatchStatus() {
      try {
        const resp = await fetch('/api/copies/batch-status');
        const data = await resp.json();
        this.maxSelect = data.maxSelect || 20;
        this.batchLimit = Math.min(this.batchLimit, this.maxSelect);
        if (data.running) {
          this.batchRunning = true;
          this.batchProgress = { done: data.done, total: data.total, current: data.current };
          // Poll until done
          this.pollBatchStatus();
        }
      } catch {}
    },

    async pollBatchStatus() {
      while (this.batchRunning) {
        await new Promise(r => setTimeout(r, 3000));
        try {
          const resp = await fetch('/api/copies/batch-status');
          const data = await resp.json();
          this.batchProgress = { done: data.done, total: data.total, current: data.current };
          if (!data.running) {
            this.batchRunning = false;
            this.batchProgress.current = `完成 (${data.errors?.length || 0} 錯誤)`;
          }
        } catch { break; }
      }
    },

    toggleDark() {
      this.dark = !this.dark;
      localStorage.setItem('dark', this.dark);
      this.applyDark();
    },

    applyDark() {
      document.documentElement.classList.toggle('dark', this.dark);
    },

    // ── Dashboard ──
    clearExpandedState() {
      this.expandedItem = null;
      this.expandedCopies = [];
      this.expandedAnalysis = null;
      this.expandedPhotoAnalysis = null;
      this.lastGenerationInfo = null;
      this.analysisPhotoFiles = [];
    },

    get filteredCars() {
      // Filtering is now server-side; just return loaded cars
      return this.cars;
    },

    sortBy(key) {
      if (this.sort.key === key) {
        this.sort.asc = !this.sort.asc;
      } else {
        this.sort.key = key;
        this.sort.asc = false;
      }
      this.loadCars(true);
    },

    get lastUpdatedText() {
      if (!this.lastUpdated) return '';
      const d = this.lastUpdated;
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },

    async loadCars(reset = false) {
      if (reset) {
        this.cars = [];
        this.page = 1;
        this.hasMore = true;
      }
      if (!this.hasMore && !reset) return;

      if (this.page === 1) {
        this.loading = true;
      } else {
        this.loadingMore = true;
      }

      try {
        const params = new URLSearchParams({
          page: String(this.page),
          pageSize: String(this.pageSize),
          sort: this.sort.key,
          order: this.sort.asc ? 'asc' : 'desc',
        });
        if (this.filter.search) params.set('search', this.filter.search);
        if (this.filter.status) params.set('status', this.filter.status);
        if (this.filter.poStatus) params.set('poStatus', this.filter.poStatus);
        if (this.filter.copyStatus) {
          // Map UI values to API values
          const map = { '未生成': 'no_copy', '部分': 'partial_copy', '完整': 'complete_copy' };
          const val = map[this.filter.copyStatus];
          if (val) params.set('copyStatus', val);
        }

        const resp = await fetch(`/api/cars?${params}`);
        const data = await resp.json();

        if (reset || this.page === 1) {
          this.cars = data.cars || [];
        } else {
          this.cars = [...this.cars, ...(data.cars || [])];
        }
        if (this.expandedItem && !this.cars.some(car => car.item === this.expandedItem)) {
          this.clearExpandedState();
        }
        this.totalCars = data.total;
        this.hasMore = data.hasMore;
        this.lastUpdated = new Date();
      } catch (err) {
        console.error('Failed to load cars:', err);
      }

      this.loading = false;
      this.loadingMore = false;
    },

    loadNextPage() {
      if (!this.hasMore || this.loadingMore || this.loading) return;
      this.page++;
      this.loadCars();
    },

    async loadStats() {
      try {
        const resp = await fetch('/api/cars/stats');
        this.stats = await resp.json();
      } catch {}
    },

    async syncSheet() {
      this.syncing = true;
      try {
        await fetch('/api/sync', { method: 'POST' });
        await Promise.all([this.loadCars(true), this.loadStats(), this.loadPendingAnalyses(), this.load8891ValidationBlockers()]);
      } catch (err) {
        alert('同步失敗: ' + err.message);
      }
      this.syncing = false;
    },

    async updatePo(item, poStatus) {
      try {
        const resp = await fetch(`/api/cars/${item}/po`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ poStatus }),
        });
        if (resp.ok) {
          const car = this.cars.find(c => c.item === item);
          if (car) car.poStatus = poStatus;
          await this.loadStats();
        } else {
          const err = await resp.json();
          alert('更新失敗: ' + err.error);
        }
      } catch (err) {
        alert('更新失敗: ' + err.message);
      }
    },

    async togglePoPlatform(item, platform, field) {
      const car = this.cars.find(c => c.item === item);
      if (!car) return;
      const newValue = !car[field];
      try {
        const resp = await fetch(`/api/cars/${item}/po-platform`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform, value: newValue }),
        });
        if (resp.ok) {
          car[field] = newValue;
        } else {
          const err = await resp.json();
          alert('更新失敗: ' + err.error);
        }
      } catch (err) {
        alert('更新失敗: ' + err.message);
      }
    },

    // ── Copy Generation ──
    async toggleExpand(item) {
      if (this.expandedItem === item) {
        this.clearExpandedState();
        return;
      }
      this.expandedItem = item;
      this.lastGenerationInfo = null;
      await Promise.all([this.loadCopies(item), this.loadAnalysis(item)]);
    },

    async loadCopies(item) {
      try {
        const resp = await fetch(`/api/copies/${item}`);
        const data = await resp.json();
        this.expandedCopies = data.copies || [];
        const latestCopy = this.expandedCopies[0];
        this.lastGenerationInfo = latestCopy ? {
          platform: latestCopy.platform,
          confirmedFeatureCount: latestCopy.confirmed_feature_count || 0,
          pendingFieldCount: latestCopy.pending_field_count || 0,
        } : null;
      } catch {}
    },

    async loadAnalysis(item) {
      try {
        const resp = await fetch(`/api/analysis/${item}`);
        if (!resp.ok) {
          this.expandedAnalysis = null;
          this.expandedPhotoAnalysis = null;
          return;
        }
        const data = await resp.json();
        this.expandedAnalysis = data;
        this.expandedPhotoAnalysis = data.photoAnalysis || null;
      } catch {
        this.expandedAnalysis = null;
        this.expandedPhotoAnalysis = null;
      }
    },

    setAnalysisPhotoFiles(event) {
      this.analysisPhotoFiles = Array.from(event.target.files || []).slice(0, 8);
    },

    async readFileAsDataUrl(file) {
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error(`無法讀取檔案 ${file.name}`));
        reader.readAsDataURL(file);
      });
    },

    async analyzePhotos(item) {
      if (this.analysisPhotoFiles.length === 0) {
        this.copyToast = '請先選擇照片';
        setTimeout(() => { if (this.copyToast === '請先選擇照片') this.copyToast = ''; }, 2000);
        return;
      }

      this.photoAnalysisRunning = true;
      this.copyToast = `開始分析 ${item} 照片...`;

      try {
        const photos = await Promise.all(this.analysisPhotoFiles.map(async file => ({
          name: file.name,
          mimeType: file.type || 'image/jpeg',
          dataUrl: await this.readFileAsDataUrl(file),
        })));

        const resp = await fetch(`/api/analysis/${item}/photos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photos }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          this.copyToast = err.error || '照片分析失敗';
          return;
        }

        const data = await resp.json();
        this.expandedPhotoAnalysis = data.photoAnalysis || null;
        await Promise.all([this.loadPendingAnalyses(), this.load8891ValidationBlockers()]);
        this.analysisPhotoFiles = [];
        this.copyToast = `${item} 照片分析完成`;
      } catch (err) {
        this.copyToast = '照片分析失敗: ' + err.message;
      } finally {
        this.photoAnalysisRunning = false;
        setTimeout(() => { if (this.copyToast.includes(item) || this.copyToast.includes('照片分析')) this.copyToast = ''; }, 2500);
      }
    },

    async rerunBaseline(item) {
      this.copyToast = `重新分析 ${item} 中...`;
      try {
        const resp = await fetch(`/api/analysis/${item}/run-baseline`, { method: 'POST' });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          this.copyToast = err.error || '重新分析失敗';
          return;
        }
        this.expandedAnalysis = await resp.json();
        await Promise.all([this.loadPendingAnalyses(), this.load8891ValidationBlockers()]);
        this.copyToast = `${item} 已重新完成基礎分析`;
      } catch (err) {
        this.copyToast = '重新分析失敗: ' + err.message;
      }
      setTimeout(() => {
        if (this.copyToast.includes(item)) this.copyToast = '';
      }, 2500);
    },

    async jumpToAnalysis(item) {
      this.filter.status = '';
      this.filter.poStatus = '';
      this.filter.copyStatus = '';
      this.filter.search = item;
      await this.loadCars(true);
      await this.toggleExpand(item);
      this.$nextTick(() => {
        document.getElementById(`car-row-${item}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    },

    reviewDraftKey(source, hint) {
      return `${source}|${hint.field}|${hint.reason}`;
    },

    getReviewDraft(source, hint) {
      const key = this.reviewDraftKey(source, hint);
      if (!(key in this.reviewDrafts)) {
        this.reviewDrafts[key] = hint.suggestedValue || '';
      }
      return this.reviewDrafts[key];
    },

    async applyReview(item, source, hint, decision) {
      const key = this.reviewDraftKey(source, hint);
      const value = decision === 'accept' ? (this.reviewDrafts[key] || hint.suggestedValue || '') : '';

      try {
        const resp = await fetch(`/api/analysis/${item}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source,
            field: hint.field,
            reason: hint.reason,
            decision,
            value,
          }),
        });

        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          this.copyToast = err.error || '處理確認失敗';
          return;
        }

        const data = await resp.json();
        this.expandedAnalysis = data.analysis;
        this.expandedPhotoAnalysis = data.photoAnalysis;
        delete this.reviewDrafts[key];
        await Promise.all([this.loadPendingAnalyses(), this.loadCars(true), this.load8891ValidationBlockers()]);
        this.copyToast = decision === 'accept' ? '已接受並更新資料' : '已忽略此提示';
      } catch (err) {
        this.copyToast = '處理確認失敗: ' + err.message;
      }

      setTimeout(() => {
        if (this.copyToast === '已接受並更新資料' || this.copyToast === '已忽略此提示') this.copyToast = '';
      }, 2000);
    },

    isGenerating(item, platform) {
      return this.generating && this.generatingItem === item && this.generatingPlatform === platform;
    },

    isItemGenerating(item) {
      return this.generating && this.generatingItem === item;
    },

    activeGenerationPlatforms(item) {
      if (!this.isItemGenerating(item)) return [];
      return [this.generatingPlatform];
    },

    startGeneration(item, platform) {
      this.generating = true;
      this.generatingItem = item;
      this.generatingPlatform = platform;
      this.copyToast = `開始生成 ${item} ${platform} 文案`;
    },

    finishGeneration(item, platform, message) {
      if (this.generatingItem === item && this.generatingPlatform === platform) {
        this.generating = false;
        this.generatingItem = '';
        this.generatingPlatform = '';
      }
      this.copyToast = message;
      setTimeout(() => {
        if (this.copyToast === message) this.copyToast = '';
      }, 2500);
    },

    async generateAll(item) {
      this.startGeneration(item, '全部');
      try {
        const resp = await fetch(`/api/copies/${item}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          await Promise.all([this.loadCopies(item), this.loadCopySummary(), this.load8891ValidationBlockers()]);
          this.finishGeneration(item, '全部', err.error || '全部文案生成失敗');
          return;
        }
        const data = await resp.json();
        this.lastGenerationInfo = null;
        await Promise.all([this.loadCopies(item), this.loadCopySummary(), this.load8891ValidationBlockers()]);
        const successPlatforms = Object.keys(data.results || {});
        const failedPlatforms = Object.keys(data.errors || {});
        if (failedPlatforms.length > 0 && successPlatforms.length > 0) {
          this.finishGeneration(item, '全部', `${item} 已生成 ${successPlatforms.join('、')}；失敗：${failedPlatforms.join('、')}`);
        } else if (failedPlatforms.length > 0) {
          this.finishGeneration(item, '全部', `${item} 全部平台生成失敗：${failedPlatforms.join('、')}`);
        } else {
          this.finishGeneration(item, '全部', `${item} 全部文案已生成`);
        }
      } catch (err) {
        this.finishGeneration(item, '全部', '生成失敗: ' + err.message);
      }
    },

    async generateOne(item, platform) {
      this.startGeneration(item, platform);
      try {
        const resp = await fetch(`/api/copies/${item}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform }),
        });
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({}));
          await Promise.all([this.loadCopies(item), this.loadCopySummary(), this.load8891ValidationBlockers()]);
          this.finishGeneration(item, platform, err.error || `${platform} 文案生成失敗`);
          return;
        }
        const data = await resp.json();
        this.lastGenerationInfo = {
          platform,
          confirmedFeatureCount: data.generationContext?.confirmedFeatureCount || 0,
          pendingFieldCount: data.generationContext?.pendingFieldCount || 0,
        };
        await Promise.all([this.loadCopies(item), this.loadCopySummary(), this.load8891ValidationBlockers()]);
        this.finishGeneration(item, platform, `${item} ${platform} 文案已生成`);
      } catch (err) {
        this.finishGeneration(item, platform, '生成失敗: ' + err.message);
      }
    },

    async publishCopy(id) {
      await fetch(`/api/copies/${id}/publish`, { method: 'PATCH' });
      await this.loadCopies(this.expandedItem);
    },

    async unpublishCopy(id) {
      await fetch(`/api/copies/${id}/unpublish`, { method: 'PATCH' });
      await this.loadCopies(this.expandedItem);
    },

    async deleteCopy(id) {
      if (!confirm('確定刪除？')) return;
      await fetch(`/api/copies/${id}`, { method: 'DELETE' });
      await this.loadCopies(this.expandedItem);
    },

    toggleSelect(item) {
      if (this.selectedItems.has(item)) {
        this.selectedItems.delete(item);
      } else {
        if (this.selectedItems.size >= this.maxSelect) {
          this.copyToast = `最多選取 ${this.maxSelect} 台（依 API key 數量）`;
          setTimeout(() => { this.copyToast = ''; }, 2000);
          return;
        }
        this.selectedItems.add(item);
      }
      this.selectedItems = new Set(this.selectedItems);
    },

    isSelected(item) {
      return this.selectedItems.has(item);
    },

    toggleSelectAll() {
      const visible = this.filteredCars.map(c => c.item);
      const allSelected = visible.every(item => this.selectedItems.has(item));
      if (allSelected) {
        visible.forEach(item => this.selectedItems.delete(item));
      } else {
        // Clear first, then add up to maxSelect
        this.selectedItems = new Set();
        const toAdd = visible.slice(0, this.maxSelect);
        toAdd.forEach(item => this.selectedItems.add(item));
        if (visible.length > this.maxSelect) {
          this.copyToast = `已選取前 ${this.maxSelect} 台（上限依 API key 數量）`;
          setTimeout(() => { this.copyToast = ''; }, 2000);
        }
      }
      this.selectedItems = new Set(this.selectedItems);
    },

    get allSelected() {
      const visible = this.filteredCars;
      return visible.length > 0 && visible.every(c => this.selectedItems.has(c.item));
    },

    async batchUpdatePo(poStatus) {
      if (this.selectedItems.size === 0) return;
      const items = [...this.selectedItems];
      for (const item of items) {
        try {
          await fetch(`/api/cars/${item}/po`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ poStatus }),
          });
          const car = this.cars.find(c => c.item === item);
          if (car) car.poStatus = poStatus;
        } catch {}
      }
      await this.loadStats();
    },

    async batchGenerate(useSelected = false) {
      // Check if already running
      try {
        const check = await fetch('/api/copies/batch-status');
        const status = await check.json();
        if (status.running) {
          this.batchRunning = true;
          this.batchProgress = { done: status.done, total: status.total, current: status.current };
          this.pollBatchStatus();
          return;
        }
      } catch {}

      this.batchRunning = true;
      this.batchProgress = { done: 0, total: 0, current: '' };
      this.clearExpandedState();
      const body = {};
      if (useSelected && this.selectedItems.size > 0) {
        body.items = [...this.selectedItems];
      }
      try {
        const resp = await fetch(`/api/copies/batch-generate?limit=${this.batchLimit}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value);
          for (const line of text.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.phase === 'scan') {
                this.batchProgress = { done: 0, total: data.total, current: `掃描到 ${data.total} 台待生成` };
              } else if (data.status === 'generating') {
                this.batchProgress = { done: data.done, total: data.total, current: `${data.item} ${data.brand} ${data.model}` };
              } else if (data.status === 'done' || data.status === 'error') {
                this.batchProgress = { done: data.done, total: data.total, current: this.batchProgress.current };
              } else if (data.phase === 'complete') {
                this.batchProgress = { done: data.done, total: data.total, current: '完成' };
              }
            } catch {}
          }
        }
      } catch (err) {
        alert('批次生成失敗: ' + err.message);
      }
      this.batchRunning = false;
      if (useSelected) this.selectedItems = new Set();
      await Promise.all([this.loadCars(true), this.loadCopySummary(), this.load8891ValidationBlockers()]);
    },

    async copyToClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      this.copyToast = '已複製';
      setTimeout(() => { this.copyToast = ''; }, 1500);
    },

    // ── Chat ──
    async sendChat(message) {
      if (!message?.trim()) return;
      this.chatInput = '';
      this.chatMessages.push({ role: 'user', content: message });
      this.chatStreaming = true;
      this.streamingText = '';

      try {
        const resp = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message, sessionId: this.sessionId }),
        });

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const text = decoder.decode(value);
          const lines = text.split('\n');
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.done) {
                this.chatMessages.push({ role: 'assistant', content: this.streamingText });
                this.streamingText = '';
                this.chatStreaming = false;
              } else if (data.error) {
                this.chatMessages.push({ role: 'assistant', content: 'Error: ' + data.error });
                this.chatStreaming = false;
              } else if (data.text) {
                this.streamingText += data.text;
              }
              if (data.sessionId) this.sessionId = data.sessionId;
            } catch {}
          }

          this.$nextTick(() => {
            const el = document.getElementById('chatMessages');
            if (el) el.scrollTop = el.scrollHeight;
          });
        }
      } catch (err) {
        this.chatMessages.push({ role: 'assistant', content: 'Error: ' + err.message });
        this.chatStreaming = false;
      }
    },

    newChat() {
      this.chatMessages = [];
      this.sessionId = crypto.randomUUID();
      this.streamingText = '';
      this.chatStreaming = false;
    },

    // ── Settings ──
    async loadSettings() {
      try {
        const [settingsResp, keysResp, usageResp, promptResp, prefsResp, teamResp] = await Promise.all([
          fetch('/api/settings'),
          fetch('/api/settings/api-keys'),
          fetch('/api/settings/token-usage'),
          fetch('/api/copies/prompt/current'),
          fetch('/api/copies/preferences/all'),
          fetch('/api/copies/team/members'),
        ]);
        this.settingsData = await settingsResp.json();
        const keysData = await keysResp.json();
        this.apiKeys = keysData.keys || [];
        this.usageStats = await usageResp.json();
        const promptData = await promptResp.json();
        this.systemPrompt = promptData.prompt || '';
        this.platformPrompts = promptData.platformPrompts || {};
        this.userPrefs = await prefsResp.json();
        const teamData = await teamResp.json();
        this.teamMembers = teamData.members || [];

        const sid = this.settingsData.settings?.find(s => s.key === 'spreadsheet_id');
        if (sid) this.spreadsheetId = sid.value;
        this.settingsLoaded = true;
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    },

    async savePrompt() {
      await fetch('/api/copies/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: this.systemPrompt }),
      });
    },

    async selectPlatformTab(platform) {
      this.activePlatformTab = platform;
      this.platformPromptSaved = false;
      try {
        const resp = await fetch(`/api/prompts/${encodeURIComponent(platform)}`);
        const data = await resp.json();
        this.editingPlatformPrompt = data.content || '';
      } catch (err) {
        this.editingPlatformPrompt = this.platformPrompts[platform] || '';
      }
    },

    async savePlatformPromptEdit() {
      if (!this.activePlatformTab) return;
      await fetch(`/api/prompts/${encodeURIComponent(this.activePlatformTab)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: this.editingPlatformPrompt }),
      });
      this.platformPrompts[this.activePlatformTab] = this.editingPlatformPrompt;
      this.platformPromptSavedMsg = '已儲存';
      this.platformPromptSaved = true;
      setTimeout(() => { this.platformPromptSaved = false; }, 3000);
    },

    async resetPlatformPromptEdit() {
      if (!this.activePlatformTab) return;
      const resp = await fetch(`/api/prompts/${encodeURIComponent(this.activePlatformTab)}/reset`, {
        method: 'POST',
      });
      const data = await resp.json();
      this.editingPlatformPrompt = data.content || '';
      this.platformPrompts[this.activePlatformTab] = data.content || '';
      this.platformPromptSavedMsg = '已重置為預設';
      this.platformPromptSaved = true;
      setTimeout(() => { this.platformPromptSaved = false; }, 3000);
    },

    async savePref(key, value) {
      await fetch('/api/copies/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, value }),
      });
      this.userPrefs[key] = value;
    },

    async saveSpreadsheetId() {
      await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'spreadsheet_id', value: this.spreadsheetId }),
      });
      await this.loadSettings();
    },

    async addKey() {
      if (!this.newApiKey.trim()) return;
      try {
        const resp = await fetch('/api/settings/api-keys', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ apiKey: this.newApiKey }),
        });
        const data = await resp.json();
        if (resp.ok) {
          this.apiKeys = data.keys || [];
          this.newApiKey = '';
        } else {
          alert(data.error);
        }
      } catch (err) {
        alert('新增失敗: ' + err.message);
      }
    },

    async batchImport() {
      if (!this.batchKeyText.trim()) return;
      try {
        const resp = await fetch('/api/settings/api-keys/batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: this.batchKeyText }),
        });
        const data = await resp.json();
        this.apiKeys = data.keys || [];
        this.batchKeyText = '';
        alert(`已匯入 ${data.totalAdded} 個 key`);
      } catch (err) {
        alert('匯入失敗: ' + err.message);
      }
    },

    async deleteKey(suffix) {
      if (!confirm(`確定刪除 key ...${suffix}？`)) return;
      const resp = await fetch(`/api/settings/api-keys/${suffix}`, { method: 'DELETE' });
      const data = await resp.json();
      this.apiKeys = data.keys || [];
    },
  };
}

// Auto-load settings when switching to settings view
document.addEventListener('alpine:init', () => {
  Alpine.effect(() => {
    const appData = Alpine.$data(document.querySelector('[x-data]'));
    if (appData?.view === 'settings' && !appData.settingsLoaded) {
      appData.loadSettings();
    }
  });
});
