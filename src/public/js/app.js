function app() {
  return {
    view: 'dashboard',
    loading: false,
    syncing: false,
    cars: [],
    stats: {},
    filter: { search: '', status: '', poStatus: '' },
    sort: { key: 'item', asc: true },
    dark: localStorage.getItem('dark') === 'true',
    lastUpdated: null,

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

    async init() {
      this.applyDark();
      await Promise.all([this.loadCars(), this.loadStats()]);
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

    async loadCars() {
      this.loading = true;
      try {
        const params = new URLSearchParams();
        if (this.filter.search) params.set('search', this.filter.search);
        const resp = await fetch(`/api/cars?${params}`);
        const data = await resp.json();
        this.cars = data.cars || [];
        this.lastUpdated = new Date();
      } catch (err) {
        console.error('Failed to load cars:', err);
      }
      this.loading = false;
    },

    get lastUpdatedText() {
      if (!this.lastUpdated) return '';
      const d = this.lastUpdated;
      const pad = n => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    },

    async loadStats() {
      try {
        const resp = await fetch('/api/cars/stats');
        this.stats = await resp.json();
      } catch (err) {
        console.error('Failed to load stats:', err);
      }
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
        const [settingsResp, keysResp, usageResp] = await Promise.all([
          fetch('/api/settings'),
          fetch('/api/settings/api-keys'),
          fetch('/api/settings/token-usage'),
        ]);
        this.settingsData = await settingsResp.json();
        const keysData = await keysResp.json();
        this.apiKeys = keysData.keys || [];
        this.usageStats = await usageResp.json();

        const sid = this.settingsData.settings?.find(s => s.key === 'spreadsheet_id');
        if (sid) this.spreadsheetId = sid.value;
        this.settingsLoaded = true;
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
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
          await this.loadSettings();
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
        await this.loadSettings();
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
      await this.loadSettings();
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
