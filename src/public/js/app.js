function app() {
  return {
    view: 'dashboard',
    loading: false,
    syncing: false,
    cars: [],
    stats: {},
    filter: { search: '', status: '', poStatus: '', copyStatus: '' },
    copySummary: {}, // { item: { count, platforms } }
    sort: { key: 'item', asc: true },
    dark: localStorage.getItem('dark') === 'true',
    lastUpdated: null,
    batchRunning: false,
    batchProgress: null,
    batchLimit: 5,
    maxSelect: 20,
    copyToast: '',
    selectedItems: new Set(),

    // Expanded car row
    expandedItem: null,
    expandedCopies: [],
    generating: false,
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
    userPrefs: {},
    teamMembers: [],

    async init() {
      this.applyDark();
      await Promise.all([this.loadCars(), this.loadStats(), this.checkBatchStatus(), this.loadCopySummary()]);
    },

    async loadCopySummary() {
      try {
        const resp = await fetch('/api/copies/summary/all');
        this.copySummary = await resp.json();
      } catch {}
    },

    getCopyStatus(item) {
      const s = this.copySummary[item];
      if (!s) return '未生成';
      return s.platforms >= 4 ? '完整' : '部分';
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
    get filteredCars() {
      let result = [...this.cars];
      if (this.filter.status) result = result.filter(c => c.status === this.filter.status);
      if (this.filter.poStatus) result = result.filter(c => c.poStatus === this.filter.poStatus);
      if (this.filter.copyStatus) {
        result = result.filter(c => this.getCopyStatus(c.item) === this.filter.copyStatus);
      }
      if (this.filter.search) {
        const q = this.filter.search.toLowerCase();
        result = result.filter(c =>
          c.item.toLowerCase().includes(q) ||
          c.brand.toLowerCase().includes(q) ||
          c.model.toLowerCase().includes(q) ||
          (c.vin || '').toLowerCase().includes(q)
        );
      }
      const key = this.sort.key;
      result.sort((a, b) => {
        const va = (a[key] || '').toString();
        const vb = (b[key] || '').toString();
        return this.sort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      });
      return result;
    },

    sortBy(key) {
      if (this.sort.key === key) {
        this.sort.asc = !this.sort.asc;
      } else {
        this.sort.key = key;
        this.sort.asc = true;
      }
    },

    get lastUpdatedText() {
      if (!this.lastUpdated) return '';
      const d = this.lastUpdated;
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },

    async loadCars() {
      this.loading = true;
      try {
        const resp = await fetch('/api/cars');
        const data = await resp.json();
        this.cars = data.cars || [];
        this.lastUpdated = new Date();
      } catch (err) {
        console.error('Failed to load cars:', err);
      }
      this.loading = false;
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
        await Promise.all([this.loadCars(), this.loadStats()]);
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

    // ── Copy Generation ──
    async toggleExpand(item) {
      if (this.expandedItem === item) {
        this.expandedItem = null;
        return;
      }
      this.expandedItem = item;
      await this.loadCopies(item);
    },

    async loadCopies(item) {
      try {
        const resp = await fetch(`/api/copies/${item}`);
        const data = await resp.json();
        this.expandedCopies = data.copies || [];
      } catch {}
    },

    async generateAll(item) {
      this.generating = true;
      this.generatingPlatform = '全部';
      try {
        await fetch(`/api/copies/${item}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        await Promise.all([this.loadCopies(item), this.loadCopySummary()]);
      } catch (err) {
        alert('生成失敗: ' + err.message);
      }
      this.generating = false;
      this.generatingPlatform = '';
    },

    async generateOne(item, platform) {
      this.generating = true;
      this.generatingPlatform = platform;
      try {
        await fetch(`/api/copies/${item}/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ platform }),
        });
        await Promise.all([this.loadCopies(item), this.loadCopySummary()]);
      } catch (err) {
        alert('生成失敗: ' + err.message);
      }
      this.generating = false;
      this.generatingPlatform = '';
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
