/**
 * BetTracker - Приложение для учета ставок на спорт
 * С поддержкой профилей и генерацией инфографики
 */

// ========================================
// Конфигурация Supabase
// ========================================

const SUPABASE_URL = 'https://jmpgnclsmjtkxhgsybks.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImptcGduY2xzbWp0a3hoZ3N5YmtzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg5NjAwNDIsImV4cCI6MjA4NDUzNjA0Mn0.yBcfMVJujxelHXrI8TFCp2G7cjcposNkwYxVORXrSZk';

const isConfigured = !SUPABASE_URL.includes('YOUR_PROJECT_ID');

// ========================================
// Supabase клиент
// ========================================

class SupabaseClient {
    constructor(url, key) {
        this.url = url;
        this.key = key;
        this.headers = {
            'apikey': key,
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=representation'
        };
    }

    async request(endpoint, options = {}) {
        const response = await fetch(`${this.url}/rest/v1/${endpoint}`, {
            ...options,
            headers: { ...this.headers, ...options.headers }
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({ message: 'Unknown error' }));
            throw new Error(error.message || 'Ошибка запроса');
        }

        const text = await response.text();
        return text ? JSON.parse(text) : null;
    }

    async getAll(table, filters = {}) {
        let query = table + '?select=*';

        if (filters.status && filters.status !== 'all') {
            query += `&status=eq.${filters.status}`;
        }

        if (filters.profile_id && filters.profile_id !== 'all') {
            query += `&profile_id=eq.${filters.profile_id}`;
        }

        query += '&order=created_at.desc';

        return this.request(query);
    }

    async getById(table, id) {
        const data = await this.request(`${table}?id=eq.${id}`);
        return data?.[0] || null;
    }

    async create(table, data) {
        const result = await this.request(table, {
            method: 'POST',
            body: JSON.stringify(data)
        });
        return result?.[0];
    }

    async update(table, id, data) {
        const result = await this.request(`${table}?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify(data)
        });
        return result?.[0];
    }

    async delete(table, id) {
        await this.request(`${table}?id=eq.${id}`, {
            method: 'DELETE'
        });
    }
}

const supabase = new SupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ========================================
// Локальный кэш (IndexedDB)
// ========================================

const DB_NAME = 'BetTrackerCache';
const DB_VERSION = 2;
let localDb = null;

async function initLocalDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            localDb = request.result;
            resolve(localDb);
        };

        request.onupgradeneeded = (event) => {
            const db = event.target.result;

            if (!db.objectStoreNames.contains('bets')) {
                db.createObjectStore('bets', { keyPath: 'id', autoIncrement: true });
            }

            if (!db.objectStoreNames.contains('profiles')) {
                const profileStore = db.createObjectStore('profiles', { keyPath: 'id', autoIncrement: true });
                profileStore.add({
                    id: 1,
                    name: 'Основной',
                    description: 'Профиль по умолчанию',
                    color: '#3d5afe',
                    icon: 'fa-chart-line',
                    created_at: new Date().toISOString()
                });
            }
        };
    });
}

async function saveToLocalCache(storeName, items) {
    if (!localDb) return;

    return new Promise((resolve, reject) => {
        const transaction = localDb.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);

        store.clear();
        items.forEach(item => store.add(item));

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

async function getFromLocalCache(storeName) {
    if (!localDb) return [];

    return new Promise((resolve) => {
        const transaction = localDb.transaction([storeName], 'readonly');
        const store = transaction.objectStore(storeName);
        const request = store.getAll();

        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => resolve([]);
    });
}

// ========================================
// Состояние приложения
// ========================================

let currentProfileId = 'all';
let profiles = [];
let allBetsCache = [];
let isOnline = navigator.onLine;
let currentShareBet = null;

function decodeText(text) {
    if (!text || typeof text !== 'string') return text;
    if (!/[ÐÃР]/.test(text)) return text;

    try {
        const fixed = decodeURIComponent(escape(text));
        if ((fixed.match(/[А-Яа-яЁё]/g) || []).length > (text.match(/[А-Яа-яЁё]/g) || []).length) {
            return fixed;
        }
    } catch (e) { }

    try {
        const bytes = new Uint8Array([...text].map(ch => ch.charCodeAt(0) & 0xff));
        const decoder = new TextDecoder('windows-1251');
        const decoded = decoder.decode(bytes);
        if ((decoded.match(/[А-Яа-яЁё]/g) || []).length > (text.match(/[А-Яа-яЁё]/g) || []).length) {
            return decoded;
        }
    } catch (e) { }

    return text;
}

// Utility: try to fix common mojibake (Windows-1251 <-> UTF-8) when strings look garbled
function decodeIfMojibake(text) {
    if (!text || typeof text !== 'string') return text;
    // Heuristic: look for common mojibake patterns (Ð, Ã, or repeated high-loss Cyrillic fragments)
    if (!/[ÐÃР]/.test(text)) return text;
    try {
        const bytes = new Uint8Array([...text].map(ch => ch.charCodeAt(0) & 0xff));
        const decoded = new TextDecoder('utf-8').decode(bytes);
        // If decoded looks more Cyrillic than original, return it
        const cyrillicCount = (decoded.match(/[А-Яа-яЁё]/g) || []).length;
        const origCyrillicCount = (text.match(/[А-Яа-яЁё]/g) || []).length;
        return cyrillicCount > origCyrillicCount ? decoded : text;
    } catch (e) {
        return text;
    }
}

// ========================================
// API функции - Профили
// ========================================

function formatProfileFromDB(profile) {
    if (!profile) return null;
    return {
        id: profile.id,
        name: decodeIfMojibake(profile.name || 'Без названия'),
        description: decodeIfMojibake(profile.description || ''),
        color: profile.color || '#3d5afe',
        icon: profile.icon || 'fa-chart-line',
        created_at: profile.created_at
    };
}

async function getAllProfiles() {
    if (!isConfigured) {
        return getFromLocalCache('profiles');
    }

    try {
        const data = await supabase.getAll('profiles');
        const formatted = (data || []).map(formatProfileFromDB).filter(p => p !== null);
        await saveToLocalCache('profiles', formatted);
        return formatted;
    } catch (error) {
        console.error('Ошибка загрузки профилей:', error);
        return getFromLocalCache('profiles');
    }
}

async function getProfileById(id) {
    const cached = profiles.find(p => p.id === id);
    if (cached) return cached;

    if (!isConfigured) {
        const localProfiles = await getFromLocalCache('profiles');
        return localProfiles.find(p => p.id === id) || null;
    }

    try {
        const profile = await supabase.getById('profiles', id);
        return formatProfileFromDB(profile);
    } catch (error) {
        return null;
    }
}

async function createProfile(profile) {
    const dbProfile = {
        name: profile.name,
        description: profile.description || '',
        color: profile.color || '#3d5afe',
        icon: profile.icon || 'fa-chart-line'
    };

    if (!isConfigured) {
        const localProfiles = await getFromLocalCache('profiles');
        const newProfile = {
            ...dbProfile,
            id: Date.now(),
            created_at: new Date().toISOString()
        };
        localProfiles.push(newProfile);
        await saveToLocalCache('profiles', localProfiles);
        return newProfile;
    }

    try {
        const result = await supabase.create('profiles', dbProfile);
        return formatProfileFromDB(result);
    } catch (error) {
        throw error;
    }
}

async function updateProfile(profile) {
    const dbProfile = {
        name: profile.name,
        description: profile.description || '',
        color: profile.color || '#3d5afe',
        icon: profile.icon || 'fa-chart-line',
        updated_at: new Date().toISOString()
    };

    if (!isConfigured) {
        const localProfiles = await getFromLocalCache('profiles');
        const index = localProfiles.findIndex(p => p.id === profile.id);
        if (index !== -1) {
            localProfiles[index] = { ...localProfiles[index], ...dbProfile };
            await saveToLocalCache('profiles', localProfiles);
        }
        return { ...profile, ...dbProfile };
    }

    try {
        const result = await supabase.update('profiles', profile.id, dbProfile);
        return formatProfileFromDB(result);
    } catch (error) {
        throw error;
    }
}

async function deleteProfile(id) {
    if (!isConfigured) {
        const localProfiles = await getFromLocalCache('profiles');
        const filtered = localProfiles.filter(p => p.id !== id);
        await saveToLocalCache('profiles', filtered);

        allBetsCache = allBetsCache.filter(b => b.profile_id !== id);
        await saveToLocalCache('bets', allBetsCache);
        return;
    }

    try {
        await supabase.delete('profiles', id);
    } catch (error) {
        throw error;
    }
}

// ========================================
// API функции - Ставки
// ========================================

function formatBetFromDB(bet) {
    if (!bet) return null;

    const events = Array.isArray(bet.events)
        ? bet.events
        : JSON.parse(bet.events || '[]');

    return {
        id: bet.id,
        events: events.map(normalizeBetEventEntry),
        totalCoef: parseFloat(bet.total_coef) || 0,
        amount: parseFloat(bet.amount) || 0,
        status: bet.status || 'pending',
        type: bet.type || 'single',
        profile_id: bet.profile_id || null,
        date: bet.created_at || new Date().toISOString()
    };
}

async function loadAllBets() {
    if (!isConfigured) {
        allBetsCache = await getFromLocalCache('bets');
        return allBetsCache;
    }

    try {
        const bets = await supabase.getAll('bets', {});
        allBetsCache = (bets || []).map(formatBetFromDB).filter(b => b !== null);
        await saveToLocalCache('bets', allBetsCache);
        return allBetsCache;
    } catch (error) {
        allBetsCache = await getFromLocalCache('bets');
        return allBetsCache;
    }
}

function normalizeBetEventEntry(event) {
    if (!event || typeof event !== 'object') {
        return { name: '', market: '', coef: 0 };
    }

    const normalized = { ...event };
    const coef = parseFloat(normalized.coef);
    normalized.coef = Number.isFinite(coef) ? coef : 0;

    if (normalized.line !== undefined && normalized.line !== null && normalized.line !== '') {
        const parsedLine = parseFloat(normalized.line);
        normalized.line = Number.isFinite(parsedLine) ? parsedLine : normalized.line;
    }

    if (normalized.resultScore && typeof normalized.resultScore === 'object') {
        const home = parseInt(normalized.resultScore.home, 10);
        const away = parseInt(normalized.resultScore.away, 10);
        normalized.resultScore = {
            home: Number.isFinite(home) ? home : null,
            away: Number.isFinite(away) ? away : null
        };
    }

    normalized.manualStatusOverride = normalized.manualStatusOverride === true || normalized.manualStatusOverride === 'true';
    normalized.legStatus = normalized.legStatus || 'pending';

    // Try to fix garbled text stored in DB or local cache
    normalized.name = decodeIfMojibake(normalized.name || '');
    normalized.market = decodeIfMojibake(normalized.market || normalized.marketType || '');

    return normalized;
}

async function getBetsFiltered(statusFilter = 'all') {
    let bets = [...allBetsCache];

    if (currentProfileId !== 'all') {
        bets = bets.filter(b => b.profile_id === parseInt(currentProfileId));
    }

    if (statusFilter !== 'all') {
        bets = bets.filter(b => b.status === statusFilter);
    }

    bets.sort((a, b) => new Date(b.date) - new Date(a.date));

    return bets;
}

async function getBetById(id) {
    const cached = allBetsCache.find(b => b.id === id);
    if (cached) return cached;

    if (!isConfigured) {
        const localBets = await getFromLocalCache('bets');
        return localBets.find(b => b.id === id) || null;
    }

    try {
        const bet = await supabase.getById('bets', id);
        return formatBetFromDB(bet);
    } catch (error) {
        return null;
    }
}

async function addBet(bet) {
    const profileId = currentProfileId !== 'all' ? parseInt(currentProfileId) : null;

    const dbBet = {
        events: bet.events,
        total_coef: bet.totalCoef,
        amount: bet.amount,
        status: bet.status,
        type: bet.type,
        profile_id: profileId
    };

    if (!isConfigured) {
        const newBet = {
            ...bet,
            id: Date.now(),
            profile_id: profileId,
            date: new Date().toISOString()
        };

        allBetsCache.unshift(newBet);
        await saveToLocalCache('bets', allBetsCache);
        return newBet;
    }

    try {
        const result = await supabase.create('bets', dbBet);
        const newBet = formatBetFromDB(result);
        allBetsCache.unshift(newBet);
        return newBet;
    } catch (error) {
        throw error;
    }
}

async function updateBet(bet) {
    const dbBet = {
        events: bet.events,
        total_coef: bet.totalCoef,
        amount: bet.amount,
        status: bet.status,
        type: bet.type,
        profile_id: bet.profile_id,
        updated_at: new Date().toISOString()
    };

    if (!isConfigured) {
        const index = allBetsCache.findIndex(b => b.id === bet.id);
        if (index !== -1) {
            allBetsCache[index] = { ...allBetsCache[index], ...bet };
            await saveToLocalCache('bets', allBetsCache);
        }
        return bet;
    }

    try {
        const result = await supabase.update('bets', bet.id, dbBet);
        const updatedBet = formatBetFromDB(result);

        const index = allBetsCache.findIndex(b => b.id === bet.id);
        if (index !== -1) {
            allBetsCache[index] = updatedBet;
        }

        return updatedBet;
    } catch (error) {
        throw error;
    }
}

async function deleteBet(id) {
    if (!isConfigured) {
        allBetsCache = allBetsCache.filter(b => b.id !== id);
        await saveToLocalCache('bets', allBetsCache);
        return;
    }

    try {
        await supabase.delete('bets', id);
        allBetsCache = allBetsCache.filter(b => b.id !== id);
    } catch (error) {
        throw error;
    }
}

// ========================================
// DOM элементы
// ========================================

const elements = {
    loadingOverlay: document.getElementById('loadingOverlay'),
    connectionStatus: document.getElementById('connectionStatus'),

    addBetBtn: document.getElementById('addBetBtn'),
    emptyAddBtn: document.getElementById('emptyAddBtn'),
    syncBtn: document.getElementById('syncBtn'),
    manageProfilesBtn: document.getElementById('manageProfilesBtn'),

    closeModal: document.getElementById('closeModal'),
    cancelBtn: document.getElementById('cancelBtn'),
    addEventBtn: document.getElementById('addEventBtn'),
    submitBtn: document.getElementById('submitBtn'),

    closeProfilesModal: document.getElementById('closeProfilesModal'),
    cancelProfileBtn: document.getElementById('cancelProfileBtn'),

    closeShareModal: document.getElementById('closeShareModal'),
    downloadShareBtn: document.getElementById('downloadShareBtn'),
    copyShareBtn: document.getElementById('copyShareBtn'),
    sharePreview: document.getElementById('sharePreview'),
    shareCanvas: document.getElementById('shareCanvas'),

    betModal: document.getElementById('betModal'),
    profilesModal: document.getElementById('profilesModal'),
    shareModal: document.getElementById('shareModal'),

    betForm: document.getElementById('betForm'),
    betId: document.getElementById('betId'),
    eventsList: document.getElementById('eventsList'),
    totalCoef: document.getElementById('totalCoef'),
    betAmount: document.getElementById('betAmount'),
    betStatus: document.getElementById('betStatus'),
    modalTitle: document.getElementById('modalTitle'),

    profileForm: document.getElementById('profileForm'),
    profileId: document.getElementById('profileId'),
    profileName: document.getElementById('profileName'),
    profileDescription: document.getElementById('profileDescription'),
    profileColor: document.getElementById('profileColor'),
    profileIcon: document.getElementById('profileIcon'),
    profileFormTitle: document.getElementById('profileFormTitle'),
    iconPicker: document.getElementById('iconPicker'),
    profilesManageList: document.getElementById('profilesManageList'),

    profilesList: document.getElementById('profilesList'),
    betsTableBody: document.getElementById('betsTableBody'),
    mobileCards: document.getElementById('mobileCards'),
    statusFilter: document.getElementById('statusFilter'),
    emptyState: document.getElementById('emptyState'),
    betsSection: document.querySelector('.bets-section'),
    tableWrapper: document.querySelector('.table-wrapper'),
    homePage: document.getElementById('homePage'),
    eventsPage: document.getElementById('eventsPage'),
    navHomeBtn: document.getElementById('navHomeBtn'),
    navEventsBtn: document.getElementById('navEventsBtn'),
    eventsSearch: document.getElementById('eventsSearch'),
    eventsFilters: document.getElementById('eventsFilters'),
    sportsEventsGrid: document.getElementById('sportsEventsGrid'),
    eventDetailModal: document.getElementById('eventDetailModal'),
    closeEventDetailModal: document.getElementById('closeEventDetailModal'),
    eventDetailMarkets: document.getElementById('eventDetailMarkets'),
    eventDetailBreadcrumbs: document.getElementById('eventDetailBreadcrumbs'),
    homeName: document.getElementById('homeName'),
    awayName: document.getElementById('awayName'),
    homeHistory: document.getElementById('homeHistory'),
    awayHistory: document.getElementById('awayHistory'),
    homeLogo: document.getElementById('homeLogo'),
    awayLogo: document.getElementById('awayLogo'),
    detailDateTime: document.getElementById('detailDateTime'),



    // API настройки
    refreshEventsBtn: document.getElementById('refreshEventsBtn'),
    apiSettingsBtn: document.getElementById('apiSettingsBtn'),
    apiSettingsModal: document.getElementById('apiSettingsModal'),
    closeApiSettingsModal: document.getElementById('closeApiSettingsModal'),
    apiKeyForm: document.getElementById('apiKeyForm'),
    oddsApiKeyInput: document.getElementById('oddsApiKeyInput'),
    toggleApiKeyVisibility: document.getElementById('toggleApiKeyVisibility'),
    removeApiKeyBtn: document.getElementById('removeApiKeyBtn'),
    apiQuotaInfo: document.getElementById('apiQuotaInfo'),
    apiQuotaText: document.getElementById('apiQuotaText'),
    eventsApiStatus: document.getElementById('eventsApiStatus'),

    totalProfit: document.getElementById('totalProfit'),
    roiValue: document.getElementById('roiValue'),
    winrateValue: document.getElementById('winrateValue'),
    avgCoef: document.getElementById('avgCoef'),

    toastContainer: document.getElementById('toastContainer'),
    floatingCoupon: document.getElementById('floatingCoupon'),
    couponBadge: document.getElementById('couponBadge')
};

// ========================================
// Уведомления
// ========================================

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: 'fa-check-circle',
        error: 'fa-exclamation-circle',
        warning: 'fa-exclamation-triangle',
        info: 'fa-info-circle'
    };

    toast.innerHTML = `
        <i class="fas ${icons[type] || icons.info}"></i>
        <span class="toast-message">${message}</span>
    `;

    elements.toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// ========================================
// Статус подключения
// ========================================

function updateConnectionStatus() {
    const status = elements.connectionStatus;

    if (!isConfigured) {
        status.innerHTML = '<i class="fas fa-database"></i><span>Локально</span>';
        status.className = 'connection-status local';
    } else if (isOnline) {
        status.innerHTML = '<i class="fas fa-cloud"></i><span>Онлайн</span>';
        status.className = 'connection-status';
    } else {
        status.innerHTML = '<i class="fas fa-cloud-slash"></i><span>Офлайн</span>';
        status.className = 'connection-status offline';
    }
}

// ========================================
// Вспомогательные функции
// ========================================

function getProfileFromCache(profileId) {
    if (!profileId) return null;
    return profiles.find(p => p.id === profileId) || null;
}

function createProfileBadge(profileId) {
    const profile = getProfileFromCache(profileId);

    if (!profile) {
        return '<span class="profile-badge" style="background-color: #666; color: #fff;">Без профиля</span>';
    }

    return `
        <span class="profile-badge" style="background-color: ${profile.color}20; color: ${profile.color}; border: 1px solid ${profile.color}40;">
            <i class="fas ${profile.icon}"></i> ${profile.name}
        </span>
    `;
}

function calculateProfit(bet) {
    const amount = parseFloat(bet.amount) || 0;
    const totalCoef = getBetDisplayCoef(bet);

    switch (bet.status) {
        case 'win': return (amount * totalCoef) - amount;
        case 'lose': return -amount;
        case 'return': return 0;
        default: return 0;
    }
}

function isResolvedLegStatus(status) {
    return status === 'win' || status === 'lose' || status === 'return';
}

function isSettledEventLink(event) {
    if (!event?.matchEventId || !event?.marketType || !event?.selection) {
        return false;
    }

    if (event.marketType === 'total' || event.marketType === 'spread') {
        return Number.isFinite(parseFloat(event.line));
    }

    return true;
}

function canAutoSettleBet(bet) {
    const events = Array.isArray(bet?.events) ? bet.events : [];
    return events.length > 0 &&
        events.every(isSettledEventLink) &&
        !events.some(event => event.manualStatusOverride);
}

function getSettledTotalCoef(bet) {
    if (!canAutoSettleBet(bet)) {
        return null;
    }

    const events = bet.events.map(normalizeBetEventEntry);
    if (events.length === 0 || !events.every(event => isResolvedLegStatus(event.legStatus))) {
        return null;
    }

    if (events.some(event => event.legStatus === 'lose')) {
        return null;
    }

    if (events.every(event => event.legStatus === 'return')) {
        return 1;
    }

    return events.reduce((total, event) => {
        if (event.legStatus === 'return') {
            return total;
        }

        return total * (parseFloat(event.coef) || 1);
    }, 1);
}

function getBetDisplayCoef(bet) {
    const settledTotalCoef = getSettledTotalCoef(bet);
    if (settledTotalCoef !== null) {
        return settledTotalCoef;
    }

    return parseFloat(bet?.totalCoef) || 0;
}

function formatResultScore(resultScore) {
    if (!resultScore || typeof resultScore !== 'object') {
        return '';
    }

    const home = Number.isFinite(resultScore.home) ? resultScore.home : null;
    const away = Number.isFinite(resultScore.away) ? resultScore.away : null;
    if (home === null || away === null) {
        return '';
    }

    return `${home}:${away}`;
}

function getBetEventSummary(event) {
    const chunks = [`${event.market || ''} @ ${(parseFloat(event.coef) || 0).toFixed(2)}`];
    const scoreText = formatResultScore(event.resultScore);
    if (scoreText) {
        chunks.push(scoreText);
    }
    if (event.legStatus && event.legStatus !== 'pending') {
        chunks.push(getStatusText(event.legStatus));
    }
    return chunks.join(' · ');
}

function formatDate(isoString) {
    if (!isoString) return 'Н/Д';
    try {
        return new Date(isoString).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return 'Н/Д';
    }
}

function formatDateFull(isoString) {
    if (!isoString) return 'Н/Д';
    try {
        return new Date(isoString).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return 'Н/Д';
    }
}

function getStatusText(status) {
    return { pending: 'Ожидание', win: 'Выигрыш', lose: 'Проигрыш', return: 'Возврат' }[status] || status;
}

// ========================================
// The Odds API — Конфигурация и интеграция
// ========================================

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';
const ODDS_API_KEY_STORAGE = 'bettracker_odds_api_key';
const ODDS_CACHE_STORAGE = 'bettracker_odds_cache';
const ODDS_CACHE_VERSION = 2;
const ODDS_CACHE_TTL = 10 * 60 * 1000; // 10 минут
const COMPLETED_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const AUTO_SETTLEMENT_SOURCE = 'the_odds_api';

// Маппинг спортов The Odds API → наш формат
const SPORT_KEY_MAP = {
    // Футбол
    'soccer_epl': { sport: 'football', league: 'Premier League' },
    'soccer_spain_la_liga': { sport: 'football', league: 'La Liga' },
    'soccer_germany_bundesliga': { sport: 'football', league: 'Bundesliga' },
    'soccer_italy_serie_a': { sport: 'football', league: 'Serie A' },
    'soccer_france_ligue_one': { sport: 'football', league: 'Ligue 1' },
    'soccer_uefa_champs_league': { sport: 'football', league: 'UCL' },
    'soccer_uefa_europa_league': { sport: 'football', league: 'Europa League' },
    // Хоккей
    'icehockey_nhl': { sport: 'hockey', league: 'NHL' },
};

// Ключи для загрузки событий по спортам
const ODDS_SPORT_KEYS = {
    football: [
        'soccer_epl', 'soccer_spain_la_liga', 'soccer_germany_bundesliga',
        'soccer_italy_serie_a', 'soccer_france_ligue_one',
        'soccer_uefa_champs_league', 'soccer_uefa_europa_league'
    ],
    hockey: ['icehockey_nhl']
};

let sportsEventsData = [];
let eventsLoading = false;
let eventsApiQuota = null; // Оставшийся лимит запросов

// Демо-данные для режима без API ключа
const DEMO_EVENTS = [
    {
        id: 'demo_1', sport: 'football', league: 'Premier League',
        homeTeam: 'Arsenal', awayTeam: 'Manchester City',
        teams: 'Arsenal - Manchester City', time: '18:30',
        date: new Date(Date.now() + 86400000).toISOString(),
        venue: '', odds: '2.45', market: 'П1 2.45 · X 3.40 · П2 2.70',
        bookmakerCount: 0, bookmaker: '',
        markets: [
            {
                name: 'Исход матча (1X2)', options: [
                    { label: 'Arsenal (П1)', odds: '2.45' }, { label: 'Ничья (X)', odds: '3.40' }, { label: 'Manchester City (П2)', odds: '2.70' }
                ]
            },
            {
                name: 'Тотал', options: [
                    { label: 'ТМ 2.5', odds: '1.85' }, { label: 'ТБ 2.5', odds: '1.95' }
                ]
            },
            {
                name: 'Фора', options: [
                    { label: 'Arsenal (Ф -0.5)', odds: '2.60' }, { label: 'Manchester City (Ф +0.5)', odds: '1.55' }
                ]
            }
        ], isDemo: true
    },
    {
        id: 'demo_2', sport: 'football', league: 'La Liga',
        homeTeam: 'Real Madrid', awayTeam: 'Barcelona',
        teams: 'Real Madrid - Barcelona', time: '21:00',
        date: new Date(Date.now() + 172800000).toISOString(),
        venue: '', odds: '2.10', market: 'П1 2.10 · X 3.60 · П2 3.20',
        bookmakerCount: 0, bookmaker: '',
        markets: [
            {
                name: 'Исход матча (1X2)', options: [
                    { label: 'Real Madrid (П1)', odds: '2.10' }, { label: 'Ничья (X)', odds: '3.60' }, { label: 'Barcelona (П2)', odds: '3.20' }
                ]
            },
            {
                name: 'Тотал', options: [
                    { label: 'ТМ 2.5', odds: '1.75' }, { label: 'ТБ 2.5', odds: '2.05' }
                ]
            },
            {
                name: 'Фора', options: [
                    { label: 'Real Madrid (Ф -0.5)', odds: '1.70' }, { label: 'Barcelona (Ф +0.5)', odds: '2.15' }
                ]
            }
        ], isDemo: true
    },
    {
        id: 'demo_3', sport: 'football', league: 'UCL',
        homeTeam: 'Bayern Munich', awayTeam: 'PSG',
        teams: 'Bayern Munich - PSG', time: '21:00',
        date: new Date(Date.now() + 259200000).toISOString(),
        venue: '', odds: '1.85', market: 'П1 1.85 · X 3.90 · П2 3.60',
        bookmakerCount: 0, bookmaker: '',
        markets: [
            {
                name: 'Исход матча (1X2)', options: [
                    { label: 'Bayern Munich (П1)', odds: '1.85' }, { label: 'Ничья (X)', odds: '3.90' }, { label: 'PSG (П2)', odds: '3.60' }
                ]
            },
            {
                name: 'Тотал', options: [
                    { label: 'ТМ 2.5', odds: '1.65' }, { label: 'ТБ 2.5', odds: '2.20' }
                ]
            },
            {
                name: 'Фора', options: [
                    { label: 'Bayern Munich (Ф -1.0)', odds: '2.30' }, { label: 'PSG (Ф +1.0)', odds: '1.60' }
                ]
            }
        ], isDemo: true
    },
    {
        id: 'demo_4', sport: 'hockey', league: 'NHL',
        homeTeam: 'NY Rangers', awayTeam: 'Boston Bruins',
        teams: 'NY Rangers - Boston Bruins', time: '01:00',
        date: new Date(Date.now() + 345600000).toISOString(),
        venue: '', odds: '2.15', market: 'П1 2.15 · X 3.80 · П2 2.80',
        bookmakerCount: 0, bookmaker: '',
        markets: [
            {
                name: 'Исход матча (1X2)', options: [
                    { label: 'NY Rangers (П1)', odds: '2.15' }, { label: 'Ничья (X)', odds: '3.80' }, { label: 'Boston Bruins (П2)', odds: '2.80' }
                ]
            },
            {
                name: 'Тотал', options: [
                    { label: 'ТМ 5.5', odds: '1.80' }, { label: 'ТБ 5.5', odds: '2.00' }
                ]
            },
            {
                name: 'Фора', options: [
                    { label: 'NY Rangers (Ф -1.5)', odds: '2.90' }, { label: 'Boston Bruins (Ф +1.5)', odds: '1.40' }
                ]
            }
        ], isDemo: true
    },
    {
        id: 'demo_5', sport: 'football', league: 'Bundesliga',
        homeTeam: 'Borussia Dortmund', awayTeam: 'Bayer Leverkusen',
        teams: 'Borussia Dortmund - Bayer Leverkusen', time: '19:30',
        date: new Date(Date.now() + 432000000).toISOString(),
        venue: '', odds: '2.50', market: 'П1 2.50 · X 3.60 · П2 2.60',
        bookmakerCount: 0, bookmaker: '',
        markets: [
            {
                name: 'Исход матча (1X2)', options: [
                    { label: 'Borussia Dortmund (П1)', odds: '2.50' }, { label: 'Ничья (X)', odds: '3.60' }, { label: 'Bayer Leverkusen (П2)', odds: '2.60' }
                ]
            },
            {
                name: 'Тотал', options: [
                    { label: 'ТМ 2.5', odds: '1.70' }, { label: 'ТБ 2.5', odds: '2.10' }
                ]
            },
            {
                name: 'Фора', options: [
                    { label: 'Borussia Dortmund (Ф -0.5)', odds: '2.75' }, { label: 'Bayer Leverkusen (Ф +0.5)', odds: '1.50' }
                ]
            }
        ], isDemo: true
    }
];

function getOddsApiKey() {
    return localStorage.getItem(ODDS_API_KEY_STORAGE) || '';
}

function setOddsApiKey(key) {
    localStorage.setItem(ODDS_API_KEY_STORAGE, key.trim());
}

function parseEventTimestamp(value) {
    if (!value) return null;
    const timestamp = new Date(value).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
}

function isEventCompletedExpired(event) {
    if (!event || event.status !== 'completed') {
        return false;
    }

    const completedAt = parseEventTimestamp(event.completedAt) ||
        parseEventTimestamp(event.lastUpdate) ||
        parseEventTimestamp(event.commenceTime) ||
        parseEventTimestamp(event.date);

    if (!completedAt) {
        return false;
    }

    return Date.now() - completedAt > COMPLETED_EVENT_RETENTION_MS;
}

function pruneExpiredCompletedEvents(events) {
    return (events || []).filter(event => !isEventCompletedExpired(event));
}

function normalizeEventScores(scores) {
    if (!scores || typeof scores !== 'object') {
        return null;
    }

    const home = parseInt(scores.home, 10);
    const away = parseInt(scores.away, 10);
    if (!Number.isFinite(home) || !Number.isFinite(away)) {
        return null;
    }

    return { home, away };
}

function inferEventStatus(event) {
    if (event?.isDemo) {
        return event.status || 'upcoming';
    }

    if (event?.status === 'completed' || event?.completed) {
        return 'completed';
    }

    const commenceTimestamp = parseEventTimestamp(event?.commenceTime || event?.date || event?.time);
    if (commenceTimestamp && commenceTimestamp <= Date.now()) {
        return 'live';
    }

    return 'upcoming';
}

function normalizeSportsEvent(event) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    const normalized = { ...event };
    normalized.commenceTime = normalized.commenceTime || normalized.date || normalized.time || '';
    normalized.date = normalized.commenceTime;
    normalized.time = normalized.commenceTime;
    normalized.scores = normalizeEventScores(normalized.scores);
    normalized.status = inferEventStatus(normalized);
    normalized.completed = normalized.status === 'completed';
    normalized.hasOddsData = normalized.hasOddsData !== false;
    normalized.isBettable = normalized.isDemo
        ? true
        : Boolean(normalized.isBettable ?? (normalized.hasOddsData && normalized.status !== 'completed'));

    return normalized;
}

function getOddsCache() {
    try {
        const raw = localStorage.getItem(ODDS_CACHE_STORAGE);
        if (!raw) return null;
        const cache = JSON.parse(raw);

        if (cache.version !== ODDS_CACHE_VERSION) {
            localStorage.removeItem(ODDS_CACHE_STORAGE);
            return null;
        }

        if (Date.now() - cache.timestamp > ODDS_CACHE_TTL) {
            localStorage.removeItem(ODDS_CACHE_STORAGE);
            return null;
        }

        return pruneExpiredCompletedEvents((cache.data || []).map(normalizeSportsEvent).filter(Boolean));
    } catch {
        return null;
    }
}

function setOddsCache(data) {
    localStorage.setItem(ODDS_CACHE_STORAGE, JSON.stringify({
        version: ODDS_CACHE_VERSION,
        timestamp: Date.now(),
        data: pruneExpiredCompletedEvents((data || []).map(normalizeSportsEvent).filter(Boolean))
    }));
}

let currentEventDetail = null;

function getSportLabel(sport) {
    return {
        football: 'Футбол',
        hockey: 'Хоккей',
        tennis: 'Теннис',
        basketball: 'Баскетбол',
        esports: 'Киберспорт',
        volleyball: 'Волейбол',
        handball: 'Гандбол',
        martialarts: 'Единоборства'
    }[sport] || sport;
}

function getSportIcon(sport) {
    return {
        football: 'fa-futbol',
        hockey: 'fa-hockey-puck',
        tennis: 'fa-table-tennis-paddle-ball',
        basketball: 'fa-basketball',
        esports: 'fa-gamepad',
        volleyball: 'fa-volleyball',
        handball: 'fa-handball',
        martialarts: 'fa-hand-fist'
    }[sport] || 'fa-trophy';
}


// Построение рынков — если API вернул markets, используем их, иначе генерируем из odds
function getEventMarkets(event) {
    // Если уже есть сохранённые рынки от API
    if (event.markets && event.markets.length > 0) {
        return event.markets;
    }

    if (event.hasOddsData === false && !event.isDemo) {
        return [];
    }

    // Фолбэк: генерируем рынки из базового коэффициента
    const base = parseFloat(event.odds) || 1.9;
    const markets = [];
    const teamParts = event.teams.split(' - ');
    const home = teamParts[0] || 'Хозяева';
    const away = teamParts[1] || 'Гости';

    markets.push({
        name: 'Исход матча (1X2)',
        options: [
            { label: `${home} (П1)`, odds: base.toFixed(2) },
            { label: 'Ничья (X)', odds: (base + 1.2).toFixed(2) },
            { label: `${away} (П2)`, odds: (base + 0.8).toFixed(2) }
        ]
    });

    const totalLine = event.sport === 'hockey' ? '5.5' : '2.5';
    markets.push({
        name: 'Тотал',
        options: [
            { label: `ТМ ${totalLine}`, odds: (base - 0.1).toFixed(2) },
            { label: `ТБ ${totalLine}`, odds: (base + 0.2).toFixed(2) }
        ]
    });

    markets.push({
        name: 'Фора',
        options: [
            { label: `${home} (Ф -0.5)`, odds: (base + 0.5).toFixed(2) },
            { label: `${away} (Ф +0.5)`, odds: (base - 0.2).toFixed(2) }
        ]
    });

    return markets;
}

function formatEventDate(value) {
    if (!value) return 'Дата не указана';
    try {
        return new Date(value).toLocaleString('ru-RU', {
            day: '2-digit',
            month: 'long',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (error) {
        return value;
    }
}

function getEventMarkets(event) {
    if (event.markets && event.markets.length > 0) {
        return event.markets;
    }

    if (event.hasOddsData === false && !event.isDemo) {
        return [];
    }

    const base = parseFloat(event.odds) || 1.9;
    const markets = [];
    const teamParts = event.teams.split(' - ');
    const home = teamParts[0] || 'Хозяева';
    const away = teamParts[1] || 'Гости';

    markets.push({
        name: 'Исход матча (1X2)',
        options: [
            { label: `${home} (П1)`, odds: base.toFixed(2), marketType: 'h2h', selection: 'home', line: null },
            { label: 'Ничья (X)', odds: (base + 1.2).toFixed(2), marketType: 'h2h', selection: 'draw', line: null },
            { label: `${away} (П2)`, odds: (base + 0.8).toFixed(2), marketType: 'h2h', selection: 'away', line: null }
        ]
    });

    const totalLine = event.sport === 'hockey' ? 5.5 : 2.5;
    markets.push({
        name: 'Тотал',
        options: [
            { label: `ТМ ${totalLine}`, odds: (base - 0.1).toFixed(2), marketType: 'total', selection: 'under', line: totalLine },
            { label: `ТБ ${totalLine}`, odds: (base + 0.2).toFixed(2), marketType: 'total', selection: 'over', line: totalLine }
        ]
    });

    markets.push({
        name: 'Фора',
        options: [
            { label: `${home} (Ф -0.5)`, odds: (base + 0.5).toFixed(2), marketType: 'spread', selection: 'home', line: -0.5 },
            { label: `${away} (Ф +0.5)`, odds: (base - 0.2).toFixed(2), marketType: 'spread', selection: 'away', line: 0.5 }
        ]
    });

    return markets;
}

function getEventDateTimeParts(value) {
    if (!value) {
        return { dateLabel: 'Дата не указана', timeLabel: '—' };
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return { dateLabel: value, timeLabel: '—' };
    }

    return {
        dateLabel: date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }),
        timeLabel: date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    };
}

function getEventScoreText(event) {
    if (!event?.scores || !Number.isFinite(event.scores.home) || !Number.isFinite(event.scores.away)) {
        return '';
    }

    return `${event.scores.home}:${event.scores.away}`;
}

function getEventStatusLabel(event) {
    if (event?.isDemo) {
        return '45:00';
    }

    switch (event?.status) {
        case 'completed':
            return 'Завершен';
        case 'live':
            return 'Идет';
        default:
            return 'Предстоит';
    }
}

function getEventCardLabel(event) {
    if (event?.isDemo) {
        return '45:00';
    }

    if (event?.status === 'upcoming') {
        return getEventDateTimeParts(event?.commenceTime || event?.date || event?.time).timeLabel;
    }

    return getEventStatusLabel(event);
}

function getEventStatusIcon(event) {
    if (event?.isDemo) {
        return 'fa-clock';
    }

    switch (event?.status) {
        case 'completed':
            return 'fa-flag-checkered';
        case 'live':
            return 'fa-tower-broadcast';
        default:
            return 'fa-clock';
    }
}

function getEventStatusClass(event) {
    return `status-${event?.status || 'upcoming'}`;
}

function getTeamScoreForDisplay(event, side) {
    if (event?.isDemo) {
        return side === 'home'
            ? Math.floor(Math.random() * 3)
            : Math.floor(Math.random() * 2);
    }

    if (!event?.scores) {
        return '—';
    }

    const value = side === 'home' ? event.scores.home : event.scores.away;
    return Number.isFinite(value) ? value : '—';
}

function renderEventTimingBlock(event) {
    const { dateLabel, timeLabel } = getEventDateTimeParts(event?.commenceTime || event?.date || event?.time);
    const scoreText = getEventScoreText(event);
    const statusLabel = getEventStatusLabel(event);
    const statusClass = getEventStatusClass(event);
    const scoreHtml = scoreText
        ? `<div class="detail-score-line ${statusClass}">${scoreText}</div>`
        : '';

    return `
        <span class="detail-date-label">${dateLabel}</span>
        <div class="detail-time-main">${timeLabel}</div>
        <div class="detail-status-pill ${statusClass}">${statusLabel}</div>
        ${scoreHtml}
    `;
}

function renderEventMarketList(event) {
    const markets = getEventMarkets(event);
    const couponCards = Array.from(elements.eventsList.querySelectorAll('.event-card'));

    return markets.map(market => `
        <div class="market-section">
            <div class="market-group-title" onclick="this.parentElement.classList.toggle('collapsed')">
                <i class="fas fa-chevron-down"></i>
                ${market.name}
            </div>
            <div class="market-odds-list">
                ${market.options.map(option => {
        const isInCoupon = couponCards.some(card =>
            String(card.dataset.matchEventId) === String(event.id) &&
            card.dataset.matchLabel === option.label
        );

        return `
                    <button type="button" class="detailed-odd-btn ${isInCoupon ? 'in-coupon' : ''} event-detail-place-bet" 
                        data-event-id="${event.id}" 
                        data-bet-label="${option.label}" 
                        data-bet-odds="${option.odds}">
                        <span class="detailed-odd-name">${option.label}</span>
                        <span class="detailed-odd-val">${isInCoupon ? 'В купоне' : option.odds}</span>
                    </button>
                `}).join('')}
            </div>
        </div>
    `).join('');
}

function renderEventMarketList(event) {
    const markets = getEventMarkets(event);
    const couponCards = Array.from(elements.eventsList.querySelectorAll('.event-card'));
    const isLocked = event.status === 'completed' || !event.isBettable;

    if (isLocked) {
        return `
            <div class="event-market-lock">
                <i class="fas fa-lock"></i>
                <span>Прием ставок на матч закрыт</span>
            </div>
        `;
    }

    if (markets.length === 0) {
        return `
            <div class="event-market-lock muted">
                <i class="fas fa-chart-line"></i>
                <span>Котировки сейчас недоступны</span>
            </div>
        `;
    }

    return markets.map(market => `
        <div class="market-section">
            <div class="market-group-title" onclick="this.parentElement.classList.toggle('collapsed')">
                <i class="fas fa-chevron-down"></i>
                ${market.name}
            </div>
            <div class="market-odds-list">
                ${market.options.map(option => {
        const isInCoupon = couponCards.some(card =>
            String(card.dataset.matchEventId) === String(event.id) &&
            card.dataset.matchLabel === option.label
        );

        const lineValue = option.line === null || option.line === undefined || option.line === ''
            ? ''
            : option.line;

        return `
                    <button type="button" class="detailed-odd-btn ${isInCoupon ? 'in-coupon' : ''} event-detail-place-bet"
                        data-event-id="${event.id}"
                        data-bet-label="${option.label}"
                        data-bet-odds="${option.odds}"
                        data-market-type="${option.marketType || ''}"
                        data-selection="${option.selection || ''}"
                        data-line="${lineValue}"
                        data-sport-key="${event.sportKey || ''}"
                        data-commence-time="${event.commenceTime || ''}"
                        data-home-team="${event.homeTeam || ''}"
                        data-away-team="${event.awayTeam || ''}">
                        <span class="detailed-odd-name">${option.label}</span>
                        <span class="detailed-odd-val">${isInCoupon ? 'В купоне' : option.odds}</span>
                    </button>
                `;
    }).join('')}
            </div>
        </div>
    `).join('');
}

function getHistoryDotsHtml() {
    const types = ['win', 'lose', 'draw', 'unknown'];
    const labels = { win: 'П', lose: 'П', draw: 'Н', unknown: '?' };
    let html = '';
    for (let i = 0; i < 5; i++) {
        const type = types[Math.floor(Math.random() * types.length)];
        html += `<div class="history-dot ${type}">${labels[type]}</div>`;
    }
    return html;
}


// Форматирование точки форы: +1.5, -0.5, 0
function formatSpreadPoint(point) {
    if (point === undefined || point === null) return '';
    const num = parseFloat(point);
    if (num > 0) return `+${num}`;
    return `${num}`; // отрицательное число уже содержит минус
}

// Парсинг ответа The Odds API в наш формат
function parseOddsApiEvent(apiEvent, sportKey) {
    const mapping = SPORT_KEY_MAP[sportKey] || { sport: 'football', league: sportKey };
    const homeTeam = decodeIfMojibake(apiEvent.home_team || '');
    const awayTeam = decodeIfMojibake(apiEvent.away_team || '');
    const sportTitle = decodeIfMojibake(apiEvent.sport_title || mapping.league);

    // Собираем рынки из букмекерских данных
    const markets = [];
    const bookmakers = apiEvent.bookmakers || [];
    const bookmakerCount = bookmakers.length;

    let mainOdds = '1.90';
    let h2hHome = null, h2hDraw = null, h2hAway = null;

    let h2hMarket = null;
    let totalsMarket = null;
    let spreadsMarket = null;
    let firstBookmakerTitle = bookmakers.length > 0 ? bookmakers[0].title : '';

    // Ищем рынки по всем букмекерам, чтобы не упустить форы и тоталы
    for (const b of bookmakers) {
        if (!h2hMarket) h2hMarket = (b.markets || []).find(m => m.key === 'h2h');
        if (!totalsMarket) totalsMarket = (b.markets || []).find(m => m.key === 'totals');
        if (!spreadsMarket) spreadsMarket = (b.markets || []).find(m => m.key === 'spreads');
        if (h2hMarket && totalsMarket && spreadsMarket) break;
    }

    if (h2hMarket) {
        const options = (h2hMarket.outcomes || []).map(o => {
            let label;
            const price = (o.price || 1.90).toFixed(2);
            if (o.name === homeTeam || (homeTeam && o.name.includes(homeTeam))) {
                label = `${homeTeam} (П1)`;
                h2hHome = price;
            } else if (o.name === 'Draw' || o.name === 'Tie') {
                label = 'Ничья (X)';
                h2hDraw = price;
            } else {
                label = `${awayTeam || o.name} (П2)`;
                h2hAway = price;
            }
            return { label, odds: price };
        });
        markets.push({ name: 'Исход матча (1X2)', options });
        if (h2hHome) mainOdds = h2hHome;
    }

    if (totalsMarket) {
        const options = (totalsMarket.outcomes || []).map(o => {
            const point = o.point !== undefined ? o.point : '';
            const price = (o.price || 1.90).toFixed(2);
            let label;
            if (o.name === 'Over' || (o.name && o.name.toLowerCase().includes('over'))) {
                label = `ТБ ${point}`;
            } else if (o.name === 'Under' || (o.name && o.name.toLowerCase().includes('under'))) {
                label = `ТМ ${point}`;
            } else {
                label = `${o.name} ${point}`;
            }
            return { label, odds: price };
        });
        markets.push({ name: 'Тотал', options });
    }

    if (spreadsMarket) {
        const options = (spreadsMarket.outcomes || []).map(o => {
            const point = o.point !== undefined ? o.point : 0;
            const price = (o.price || 1.90).toFixed(2);
            const formattedPoint = formatSpreadPoint(point);
            let teamName = o.name;
            if (o.name === homeTeam || (homeTeam && o.name.includes(homeTeam))) {
                teamName = homeTeam;
            } else if (o.name === awayTeam || (awayTeam && o.name.includes(awayTeam))) {
                teamName = awayTeam;
            }
            const label = `${teamName} (Ф ${formattedPoint})`;
            return { label, odds: price };
        });
        markets.push({ name: 'Фора', options });
    }

    // Генерируем строку рынка для карточки: "П1 2.10 · X 3.60 · П2 3.20"
    let marketText = 'П1';
    const parts = [];
    if (h2hHome) parts.push(`П1 ${h2hHome}`);
    if (h2hDraw) parts.push(`X ${h2hDraw}`);
    if (h2hAway) parts.push(`П2 ${h2hAway}`);
    if (parts.length > 0) {
        marketText = parts.join(' · ');
    }

    return {
        id: apiEvent.id || `${Date.now()}_${Math.random()}`,
        sport: mapping.sport,
        sportTitle: sportTitle,
        league: mapping.league,
        homeTeam: homeTeam,
        awayTeam: awayTeam,
        teams: `${homeTeam} - ${awayTeam}`,
        time: apiEvent.commence_time || '',
        date: apiEvent.commence_time || '',
        venue: '',
        odds: mainOdds,
        market: marketText,
        markets: markets,
        bookmaker: firstBookmakerTitle,
        bookmakerCount: bookmakerCount,
        isDemo: false
    };
}

// Загрузка событий из The Odds API
async function fetchSportsEventsFromOddsAPI() {
    const apiKey = getOddsApiKey();
    if (!apiKey) {
        console.log('API ключ не установлен. Показываем демо-данные.');
        return [...DEMO_EVENTS];
    }

    // Проверяем кэш
    const cached = getOddsCache();
    if (cached) {
        console.log('Используем кэшированные события.');
        return cached;
    }

    const allEvents = [];
    const sportKeys = [
        ...ODDS_SPORT_KEYS.football,
        ...ODDS_SPORT_KEYS.hockey
    ];

    // Загружаем по спортам (параллельно, но с ограничением)
    const results = await Promise.allSettled(
        sportKeys.map(async sportKey => {
            try {
                const url = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=eu&markets=h2h,totals,spreads&oddsFormat=decimal`;
                const response = await fetch(url);

                // Сохраняем информацию о квоте
                const remaining = response.headers.get('x-requests-remaining');
                const used = response.headers.get('x-requests-used');
                if (remaining !== null) {
                    eventsApiQuota = { remaining: parseInt(remaining), used: parseInt(used) };
                }

                if (response.status === 401) {
                    throw new Error('INVALID_KEY');
                }
                if (response.status === 429) {
                    throw new Error('QUOTA_EXCEEDED');
                }
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const data = await response.json();
                return { sportKey, data };
            } catch (error) {
                console.warn(`Ошибка загрузки ${sportKey}:`, error.message);
                throw error;
            }
        })
    );

    let hasInvalidKey = false;
    let hasQuotaExceeded = false;

    results.forEach(result => {
        if (result.status === 'fulfilled') {
            const { sportKey, data } = result.value;
            (data || []).forEach(apiEvent => {
                allEvents.push(parseOddsApiEvent(apiEvent, sportKey));
            });
        } else {
            if (result.reason?.message === 'INVALID_KEY') hasInvalidKey = true;
            if (result.reason?.message === 'QUOTA_EXCEEDED') hasQuotaExceeded = true;
        }
    });

    if (hasInvalidKey) {
        showToast('Неверный API ключ. Проверьте настройки.', 'error');
        return [...DEMO_EVENTS];
    }

    if (hasQuotaExceeded) {
        showToast('Лимит запросов API исчерпан. Показываем кэш.', 'warning');
        const fallbackCache = getOddsCache();
        return fallbackCache || [...DEMO_EVENTS];
    }

    // Сортируем по дате начала
    allEvents.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Кэшируем
    if (allEvents.length > 0) {
        setOddsCache(allEvents);
    }

    return allEvents.length > 0 ? allEvents : [...DEMO_EVENTS];
}

// Показать скелетон-загрузку на странице событий
function extractScoresFromApiEvent(apiEvent, homeTeam, awayTeam) {
    const scoreEntries = Array.isArray(apiEvent?.scores) ? apiEvent.scores : [];
    if (scoreEntries.length === 0) {
        return null;
    }

    const byName = new Map();
    scoreEntries.forEach(entry => {
        const score = parseInt(entry?.score, 10);
        if (!entry?.name || !Number.isFinite(score)) {
            return;
        }
        byName.set(entry.name, score);
    });

    const homeScore = byName.has(homeTeam)
        ? byName.get(homeTeam)
        : parseInt(scoreEntries[0]?.score, 10);
    const awayScore = byName.has(awayTeam)
        ? byName.get(awayTeam)
        : parseInt(scoreEntries[1]?.score, 10);

    if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) {
        return null;
    }

    return { home: homeScore, away: awayScore };
}

function parseOddsApiEvent(apiEvent, sportKey) {
    const mapping = SPORT_KEY_MAP[sportKey] || { sport: 'football', league: sportKey };
    const homeTeam = apiEvent.home_team || '';
    const awayTeam = apiEvent.away_team || '';
    const sportTitle = apiEvent.sport_title || mapping.league;
    const commenceTime = apiEvent.commence_time || '';

    const markets = [];
    const bookmakers = apiEvent.bookmakers || [];
    const bookmakerCount = bookmakers.length;

    let mainOdds = '1.90';
    let h2hHome = null, h2hDraw = null, h2hAway = null;

    let h2hMarket = null;
    let totalsMarket = null;
    let spreadsMarket = null;
    const firstBookmakerTitle = bookmakers.length > 0 ? decodeIfMojibake(bookmakers[0].title || '') : '';

    for (const bookmaker of bookmakers) {
        if (!h2hMarket) h2hMarket = (bookmaker.markets || []).find(market => market.key === 'h2h');
        if (!totalsMarket) totalsMarket = (bookmaker.markets || []).find(market => market.key === 'totals');
        if (!spreadsMarket) spreadsMarket = (bookmaker.markets || []).find(market => market.key === 'spreads');
        if (h2hMarket && totalsMarket && spreadsMarket) break;
    }

    if (h2hMarket) {
        const options = (h2hMarket.outcomes || []).map(outcome => {
            let label;
            let selection = 'away';
            const price = (outcome.price || 1.90).toFixed(2);
            if (outcome.name === homeTeam || (homeTeam && outcome.name.includes(homeTeam))) {
                label = `${homeTeam} (П1)`;
                selection = 'home';
                h2hHome = price;
            } else if (outcome.name === 'Draw' || outcome.name === 'Tie') {
                label = 'Ничья (X)';
                selection = 'draw';
                h2hDraw = price;
            } else {
                label = `${awayTeam || outcome.name} (П2)`;
                selection = 'away';
                h2hAway = price;
            }

            return { label, odds: price, marketType: 'h2h', selection, line: null };
        });
        markets.push({ name: 'Исход матча (1X2)', options });
        if (h2hHome) mainOdds = h2hHome;
    }

    if (totalsMarket) {
        const options = (totalsMarket.outcomes || []).map(outcome => {
            const point = outcome.point !== undefined ? parseFloat(outcome.point) : null;
            const price = (outcome.price || 1.90).toFixed(2);
            let label;
            let selection = 'under';

            if (outcome.name === 'Over' || (outcome.name && outcome.name.toLowerCase().includes('over'))) {
                label = `ТБ ${point}`;
                selection = 'over';
            } else if (outcome.name === 'Under' || (outcome.name && outcome.name.toLowerCase().includes('under'))) {
                label = `ТМ ${point}`;
                selection = 'under';
            } else {
                label = `${outcome.name} ${point}`;
            }

            return { label, odds: price, marketType: 'total', selection, line: point };
        });
        markets.push({ name: 'Тотал', options });
    }

    if (spreadsMarket) {
        const options = (spreadsMarket.outcomes || []).map(outcome => {
            const point = outcome.point !== undefined ? parseFloat(outcome.point) : 0;
            const price = (outcome.price || 1.90).toFixed(2);
            const formattedPoint = formatSpreadPoint(point);
            let teamName = outcome.name;
            let selection = 'away';

            if (outcome.name === homeTeam || (homeTeam && outcome.name.includes(homeTeam))) {
                teamName = homeTeam;
                selection = 'home';
            } else if (outcome.name === awayTeam || (awayTeam && outcome.name.includes(awayTeam))) {
                teamName = awayTeam;
                selection = 'away';
            }

            return {
                label: `${teamName} (Ф ${formattedPoint})`,
                odds: price,
                marketType: 'spread',
                selection,
                line: point
            };
        });
        markets.push({ name: 'Фора', options });
    }

    const marketParts = [];
    if (h2hHome) marketParts.push(`П1 ${h2hHome}`);
    if (h2hDraw) marketParts.push(`X ${h2hDraw}`);
    if (h2hAway) marketParts.push(`П2 ${h2hAway}`);

    return normalizeSportsEvent({
        id: apiEvent.id || `${Date.now()}_${Math.random()}`,
        sportKey,
        sport: mapping.sport,
        sportTitle,
        league: mapping.league,
        homeTeam,
        awayTeam,
        teams: `${homeTeam} - ${awayTeam}`,
        time: commenceTime,
        date: commenceTime,
        commenceTime,
        venue: '',
        odds: mainOdds,
        market: marketParts.length > 0 ? marketParts.join(' В· ') : 'П1',
        markets,
        bookmaker: firstBookmakerTitle,
        bookmakerCount,
        scores: null,
        lastUpdate: null,
        completedAt: null,
        status: inferEventStatus({ commenceTime }),
        completed: false,
        hasOddsData: true,
        isBettable: markets.length > 0,
        isDemo: false
    });
}

function parseScoresApiEvent(apiEvent, sportKey) {
    const mapping = SPORT_KEY_MAP[sportKey] || { sport: 'football', league: sportKey };
    const homeTeam = apiEvent.home_team || '';
    const awayTeam = apiEvent.away_team || '';
    const commenceTime = apiEvent.commence_time || '';
    const scores = extractScoresFromApiEvent(apiEvent, homeTeam, awayTeam);
    const completed = Boolean(apiEvent.completed);

    return normalizeSportsEvent({
        id: apiEvent.id || `${Date.now()}_${Math.random()}`,
        sportKey,
        sport: mapping.sport,
        sportTitle: apiEvent.sport_title || mapping.league,
        league: mapping.league,
        homeTeam,
        awayTeam,
        teams: `${homeTeam} - ${awayTeam}`,
        time: commenceTime,
        date: commenceTime,
        commenceTime,
        venue: '',
        odds: '',
        market: '',
        markets: [],
        bookmaker: '',
        bookmakerCount: 0,
        scores,
        lastUpdate: apiEvent.last_update || null,
        completedAt: completed ? (apiEvent.last_update || commenceTime || new Date().toISOString()) : null,
        status: completed ? 'completed' : (scores ? 'live' : inferEventStatus({ commenceTime })),
        completed,
        hasOddsData: false,
        isBettable: false,
        isDemo: false
    });
}

function mergeParsedSportEvents(oddsEvents, scoreEvents) {
    const merged = new Map();

    (oddsEvents || []).forEach(event => {
        merged.set(String(event.id), normalizeSportsEvent(event));
    });

    (scoreEvents || []).forEach(scoreEvent => {
        const key = String(scoreEvent.id);
        const existing = merged.get(key);

        if (!existing) {
            merged.set(key, normalizeSportsEvent(scoreEvent));
            return;
        }

        merged.set(key, normalizeSportsEvent({
            ...existing,
            scores: scoreEvent.scores || existing.scores || null,
            lastUpdate: scoreEvent.lastUpdate || existing.lastUpdate || null,
            completedAt: scoreEvent.completedAt || existing.completedAt || null,
            status: scoreEvent.status || existing.status,
            completed: scoreEvent.completed || existing.completed,
            isBettable: scoreEvent.completed ? false : existing.isBettable
        }));
    });

    return pruneExpiredCompletedEvents(Array.from(merged.values()));
}

async function fetchOddsApiJson(url) {
    const response = await fetch(url);

    const remaining = response.headers.get('x-requests-remaining');
    const used = response.headers.get('x-requests-used');
    if (remaining !== null) {
        eventsApiQuota = {
            remaining: parseInt(remaining, 10),
            used: parseInt(used, 10) || 0
        };
    }

    if (response.status === 401) {
        throw new Error('INVALID_KEY');
    }
    if (response.status === 429) {
        throw new Error('QUOTA_EXCEEDED');
    }
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
}

async function fetchSportEventsBundle(sportKey, apiKey) {
    const oddsUrl = `${ODDS_API_BASE}/sports/${sportKey}/odds/?apiKey=${apiKey}&regions=eu&markets=h2h,totals,spreads&oddsFormat=decimal`;
    const scoresUrl = `${ODDS_API_BASE}/sports/${sportKey}/scores/?apiKey=${apiKey}&daysFrom=1`;

    const [oddsResult, scoresResult] = await Promise.allSettled([
        fetchOddsApiJson(oddsUrl),
        fetchOddsApiJson(scoresUrl)
    ]);

    const oddsData = oddsResult.status === 'fulfilled' ? oddsResult.value : [];
    const scoresData = scoresResult.status === 'fulfilled' ? scoresResult.value : [];

    if (oddsResult.status === 'rejected' && (oddsResult.reason?.message === 'INVALID_KEY' || oddsResult.reason?.message === 'QUOTA_EXCEEDED')) {
        throw oddsResult.reason;
    }

    if (scoresResult.status === 'rejected' && (scoresResult.reason?.message === 'INVALID_KEY' || scoresResult.reason?.message === 'QUOTA_EXCEEDED')) {
        throw scoresResult.reason;
    }

    if (oddsResult.status === 'rejected' && oddsResult.reason?.message) {
        console.warn(`Ошибка odds ${sportKey}:`, oddsResult.reason.message);
    }

    if (scoresResult.status === 'rejected' && scoresResult.reason?.message) {
        console.warn(`Ошибка scores ${sportKey}:`, scoresResult.reason.message);
    }

    return { sportKey, oddsData, scoresData };
}

async function fetchSportsEventsFromOddsAPI() {
    const apiKey = getOddsApiKey();
    if (!apiKey) {
        console.log('API ключ не установлен. Показываем демо-данные.');
        return [...DEMO_EVENTS];
    }

    const cached = getOddsCache();
    if (cached) {
        console.log('Используем кешированные события.');
        return cached;
    }

    const allEvents = [];
    const sportKeys = [
        ...ODDS_SPORT_KEYS.football,
        ...ODDS_SPORT_KEYS.hockey
    ];

    const results = await Promise.allSettled(
        sportKeys.map(sportKey => fetchSportEventsBundle(sportKey, apiKey))
    );

    let hasInvalidKey = false;
    let hasQuotaExceeded = false;

    results.forEach(result => {
        if (result.status === 'fulfilled') {
            const { sportKey, oddsData, scoresData } = result.value;
            const oddsEvents = (oddsData || []).map(apiEvent => parseOddsApiEvent(apiEvent, sportKey));
            const scoreEvents = (scoresData || []).map(apiEvent => parseScoresApiEvent(apiEvent, sportKey));
            allEvents.push(...mergeParsedSportEvents(oddsEvents, scoreEvents));
        } else {
            if (result.reason?.message === 'INVALID_KEY') hasInvalidKey = true;
            if (result.reason?.message === 'QUOTA_EXCEEDED') hasQuotaExceeded = true;
        }
    });

    if (hasInvalidKey) {
        showToast('Неверный API ключ. Проверьте настройки.', 'error');
        return [...DEMO_EVENTS];
    }

    if (hasQuotaExceeded) {
        showToast('Лимит запросов API исчерпан. Показываем кэш.', 'warning');
        const fallbackCache = getOddsCache();
        return fallbackCache || [...DEMO_EVENTS];
    }

    allEvents.sort((a, b) => {
        const timeA = parseEventTimestamp(a.commenceTime) || parseEventTimestamp(a.date) || 0;
        const timeB = parseEventTimestamp(b.commenceTime) || parseEventTimestamp(b.date) || 0;
        return timeA - timeB;
    });

    if (allEvents.length > 0) {
        setOddsCache(allEvents);
    }

    return allEvents.length > 0 ? allEvents : [...DEMO_EVENTS];
}

function showEventsLoadingSkeleton() {
    if (!elements.sportsEventsGrid) return;
    elements.sportsEventsGrid.innerHTML = Array.from({ length: 6 }, () => `
        <div class="sports-event-card skeleton-card">
            <div class="skeleton-line skeleton-title"></div>
            <div class="skeleton-line skeleton-meta"></div>
            <div class="skeleton-line skeleton-time"></div>
            <div class="skeleton-line skeleton-btn"></div>
        </div>
    `).join('');
}

function getEventResultMap() {
    const events = Array.isArray(sportsEventsData) ? sportsEventsData : [];
    return new Map(events.map(event => [String(event.id), event]));
}

function buildSettledLeg(event, matchEvent) {
    if (!matchEvent || matchEvent.status !== 'completed' || !matchEvent.scores) {
        return normalizeBetEventEntry(event);
    }

    const normalizedEvent = normalizeBetEventEntry(event);
    const homeScore = matchEvent.scores.home;
    const awayScore = matchEvent.scores.away;
    let legStatus = normalizedEvent.legStatus || 'pending';

    if (normalizedEvent.marketType === 'h2h') {
        if (normalizedEvent.selection === 'home') {
            legStatus = homeScore > awayScore ? 'win' : 'lose';
        } else if (normalizedEvent.selection === 'away') {
            legStatus = awayScore > homeScore ? 'win' : 'lose';
        } else if (normalizedEvent.selection === 'draw') {
            legStatus = homeScore === awayScore ? 'win' : 'lose';
        }
    } else if (normalizedEvent.marketType === 'total') {
        const total = homeScore + awayScore;
        const line = parseFloat(normalizedEvent.line);

        if (!Number.isFinite(line)) {
            return normalizedEvent;
        }

        if (Math.abs(total - line) < 0.0001) {
            legStatus = 'return';
        } else if (normalizedEvent.selection === 'over') {
            legStatus = total > line ? 'win' : 'lose';
        } else if (normalizedEvent.selection === 'under') {
            legStatus = total < line ? 'win' : 'lose';
        }
    } else if (normalizedEvent.marketType === 'spread') {
        const line = parseFloat(normalizedEvent.line);

        if (!Number.isFinite(line)) {
            return normalizedEvent;
        }

        const adjustedOwn = normalizedEvent.selection === 'home'
            ? homeScore + line
            : awayScore + line;
        const opponent = normalizedEvent.selection === 'home'
            ? awayScore
            : homeScore;

        if (Math.abs(adjustedOwn - opponent) < 0.0001) {
            legStatus = 'return';
        } else {
            legStatus = adjustedOwn > opponent ? 'win' : 'lose';
        }
    }

    return {
        ...normalizedEvent,
        legStatus,
        resultScore: { home: homeScore, away: awayScore },
        settlementSource: AUTO_SETTLEMENT_SOURCE
    };
}

function deriveBetStatusFromLegs(events) {
    if (events.some(event => event.legStatus === 'lose')) {
        return 'lose';
    }

    if (events.some(event => !isResolvedLegStatus(event.legStatus))) {
        return 'pending';
    }

    if (events.every(event => event.legStatus === 'return')) {
        return 'return';
    }

    return 'win';
}

function canAutoManageBet(bet) {
    return canAutoSettleBet(bet) && (bet.status === 'pending' || bet.events.every(event => event.settlementSource === AUTO_SETTLEMENT_SOURCE));
}

function getAutoUpdatedBet(bet, eventsMap) {
    if (!canAutoManageBet(bet)) {
        return null;
    }

    const normalizedEvents = bet.events.map(normalizeBetEventEntry);
    const nextEvents = normalizedEvents.map(event => {
        const matchEvent = eventsMap.get(String(event.matchEventId));
        return buildSettledLeg(event, matchEvent);
    });

    const nextStatus = deriveBetStatusFromLegs(nextEvents);
    const hasEventChanges = JSON.stringify(nextEvents) !== JSON.stringify(normalizedEvents);
    const hasStatusChange = nextStatus !== bet.status;

    if (!hasEventChanges && !hasStatusChange) {
        return null;
    }

    return {
        ...bet,
        status: nextStatus,
        events: nextEvents
    };
}

async function autoSettleBetsFromEvents() {
    if (!Array.isArray(allBetsCache) || allBetsCache.length === 0) {
        return false;
    }

    const eventsMap = getEventResultMap();
    if (eventsMap.size === 0) {
        return false;
    }

    let hasChanges = false;

    for (const bet of [...allBetsCache]) {
        const nextBet = getAutoUpdatedBet(bet, eventsMap);
        if (!nextBet) {
            continue;
        }

        hasChanges = true;
        await updateBet(nextBet);
    }

    return hasChanges;
}

async function loadSportsEvents() {
    eventsLoading = true;
    showEventsLoadingSkeleton();

    try {
        sportsEventsData = await fetchSportsEventsFromOddsAPI();

        // Показываем квоту, если есть
        if (eventsApiQuota) {
            console.log(`The Odds API: использовано ${eventsApiQuota.used}, осталось ${eventsApiQuota.remaining}`);
        }

        // Проверяем, демо ли это
        const isDemo = sportsEventsData.length > 0 && sportsEventsData[0].isDemo;
        if (isDemo) {
            showToast('Показаны демо-события. Добавьте API ключ в настройках для реальных данных.', 'info');
        } else {
            showToast(`Загружено ${sportsEventsData.length} событий`, 'success');
        }
    } catch (error) {
        console.error('Ошибка загрузки событий:', error);
        sportsEventsData = [...DEMO_EVENTS];
        showToast('Ошибка загрузки событий. Показаны демо-данные.', 'error');
    } finally {
        eventsLoading = false;
    }
}

async function loadSportsEvents() {
    eventsLoading = true;
    showEventsLoadingSkeleton();

    try {
        sportsEventsData = (await fetchSportsEventsFromOddsAPI())
            .map(normalizeSportsEvent)
            .filter(Boolean);

        if (eventsApiQuota) {
            console.log(`The Odds API: использовано ${eventsApiQuota.used}, осталось ${eventsApiQuota.remaining}`);
        }

        const didAutoSettle = await autoSettleBetsFromEvents();
        if (didAutoSettle) {
            await renderProfiles();
            await renderBets();
            await updateStatistics();
        }

        const isDemo = sportsEventsData.length > 0 && sportsEventsData[0].isDemo;
        if (isDemo) {
            showToast('Показаны демо-события. Добавьте API ключ в настройках для реальных данных.', 'info');
        } else {
            showToast(`Загружено ${sportsEventsData.length} событий`, 'success');
        }
    } catch (error) {
        console.error('Ошибка загрузки событий:', error);
        sportsEventsData = [...DEMO_EVENTS].map(normalizeSportsEvent);
        showToast('Ошибка загрузки событий. Показаны демо-данные.', 'error');
    } finally {
        eventsLoading = false;
    }
}

function openEventDetailModal(eventId) {
    const event = sportsEventsData.find(item => String(item.id) === String(eventId));
    if (!event) return;

    currentEventDetail = event;
    const teams = event.teams.split(' - ');
    const team1 = teams[0] || 'Команда 1';
    const team2 = teams[1] || 'Команда 2';

    // Breadcrumbs
    const sportLabel = getSportLabel(event.sport).toUpperCase();
    const leagueLabel = (event.league || '').toUpperCase();
    elements.eventDetailBreadcrumbs.textContent = `СПОРТ / ${sportLabel} / ${leagueLabel} / СЕЗОН 25/26`;

    // Team names & logos
    elements.homeName.textContent = team1;
    elements.awayName.textContent = team2;
    elements.homeLogo.innerHTML = `<i class="fas ${getSportIcon(event.sport)}"></i>`;
    elements.awayLogo.innerHTML = `<i class="fas ${getSportIcon(event.sport)}"></i>`;
    elements.homeHistory.innerHTML = getHistoryDotsHtml();
    elements.awayHistory.innerHTML = getHistoryDotsHtml();

    // Format date/time
    let dateLabel = '';
    let timeLabel = '';
    try {
        const eventDate = new Date(event.date || event.time);
        dateLabel = eventDate.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        timeLabel = eventDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        dateLabel = '—';
        timeLabel = '—';
    }
    elements.detailDateTime.innerHTML = `
        <span class="detail-date-label">${dateLabel}</span>
        <div>${timeLabel}</div>
    `;

    // Render markets
    elements.eventDetailMarkets.innerHTML = renderEventMarketList(event);

    // Show modal
    elements.eventDetailModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}


function openEventDetailModal(eventId) {
    const event = sportsEventsData.find(item => String(item.id) === String(eventId));
    if (!event) return;

    currentEventDetail = event;
    const teams = event.teams.split(' - ');
    const team1 = teams[0] || 'Команда 1';
    const team2 = teams[1] || 'Команда 2';

    const sportLabel = getSportLabel(event.sport).toUpperCase();
    const leagueLabel = (event.league || '').toUpperCase();
    elements.eventDetailBreadcrumbs.textContent = `СПОРТ / ${sportLabel} / ${leagueLabel} / СЕЗОН 25/26`;

    elements.homeName.textContent = team1;
    elements.awayName.textContent = team2;
    elements.homeLogo.innerHTML = `<i class="fas ${getSportIcon(event.sport)}"></i>`;
    elements.awayLogo.innerHTML = `<i class="fas ${getSportIcon(event.sport)}"></i>`;
    elements.homeHistory.innerHTML = getHistoryDotsHtml();
    elements.awayHistory.innerHTML = getHistoryDotsHtml();
    elements.detailDateTime.innerHTML = renderEventTimingBlock(event);
    elements.eventDetailMarkets.innerHTML = renderEventMarketList(event);

    elements.eventDetailModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeEventDetailModal() {
    elements.eventDetailModal.classList.remove('active');
    document.body.style.overflow = '';
    currentEventDetail = null;
}

function toggleBetInCoupon(event, label, odds, button) {
    const couponCards = Array.from(elements.eventsList.querySelectorAll('.event-card'));
    const existingCard = couponCards.find(card =>
        String(card.dataset.matchEventId) === String(event.id) &&
        card.dataset.matchLabel === label
    );

    if (existingCard) {
        // Удаляем из купона
        existingCard.querySelector('.remove-event-btn').click();
        return;
    }

    // Добавляем в купон
    // Убираем пустые карточки
    const emptyCards = [...elements.eventsList.querySelectorAll('.event-card')].filter(card => {
        const nameInput = card.querySelector('.event-name');
        return nameInput && !nameInput.value;
    });
    emptyCards.forEach(c => c.remove());

    const card = createEventCard({ id: event.id, name: event.teams, market: label, coef: odds });
    elements.eventsList.appendChild(card);
    calculateTotalCoef();
    updateCouponBadge();
    showToast('Добавлено в купон', 'success');

    if (button) {
        button.classList.add('in-coupon');
        const valueSpan = button.querySelector('.odd-value, .detailed-odd-val');
        if (valueSpan) valueSpan.textContent = 'В купоне';
    }
}



function updateCouponBadge() {
    if (!elements.floatingCoupon || !elements.couponBadge) return;
    const count = elements.eventsList.querySelectorAll('.event-card').length;
    const emptyCount = [...elements.eventsList.querySelectorAll('.event-card')].filter(card => {
        const nameInput = card.querySelector('.event-name');
        return nameInput && !nameInput.value;
    }).length;

    const realCount = count - emptyCount;

    if (realCount > 0) {
        elements.couponBadge.textContent = realCount;
        elements.floatingCoupon.style.display = 'flex';
        elements.floatingCoupon.classList.remove('pulse');
        void elements.floatingCoupon.offsetWidth;
        elements.floatingCoupon.classList.add('pulse');
    } else {
        elements.floatingCoupon.style.display = 'none';
    }
}

function updateEventsApiStatus() {
    if (!elements.eventsApiStatus) return;
    const apiKey = getOddsApiKey();
    const isDemo = sportsEventsData.length > 0 && sportsEventsData[0].isDemo;

    if (!apiKey) {
        elements.eventsApiStatus.innerHTML = `
            <div class="api-status-banner api-status-warning">
                <i class="fas fa-info-circle"></i>
                <span>Демо-режим. <button type="button" class="link-btn" id="openApiFromBanner">Добавьте API ключ</button> для реальных событий.</span>
            </div>
        `;
        document.getElementById('openApiFromBanner')?.addEventListener('click', openApiSettingsModal);
    } else if (isDemo) {
        elements.eventsApiStatus.innerHTML = `
            <div class="api-status-banner api-status-warning">
                <i class="fas fa-exclamation-triangle"></i>
                <span>Не удалось загрузить реальные данные. Проверьте API ключ.</span>
            </div>
        `;
    } else {
        const quotaHtml = eventsApiQuota
            ? `<span class="api-quota-badge"><i class="fas fa-chart-pie"></i> Запросов: ${eventsApiQuota.remaining} ост.</span>`
            : '';
        elements.eventsApiStatus.innerHTML = `
            <div class="api-status-banner api-status-live">
                <i class="fas fa-broadcast-tower"></i>
                <span>Реальные данные · The Odds API</span>
                ${quotaHtml}
            </div>
        `;
    }
}

function renderSportsEvents(filter = 'all', search = '') {
    updateEventsApiStatus();

    const query = search.trim().toLowerCase();
    const events = sportsEventsData.filter(event => {
        const matchesSport = filter === 'all' || event.sport === filter;
        const matchesQuery = event.teams.toLowerCase().includes(query) ||
            event.league.toLowerCase().includes(query);
        return matchesSport && matchesQuery;
    });

    if (events.length === 0) {
        elements.sportsEventsGrid.innerHTML = `<div class="empty-state visible"><i class="fas fa-search"></i><p>События не найдены.</p></div>`;
        return;
    }

    const couponCards = Array.from(elements.eventsList.querySelectorAll('.event-card'));

    elements.sportsEventsGrid.innerHTML = events.map(event => {
        const demoBadge = event.isDemo ? '<span class="demo-badge">ДЕМО</span>' : '';
        const markets = getEventMarkets(event);
        const h2hMarket = markets.find(m => m.name === 'Исход матча (1X2)');

        // Извлекаем коэффициенты 1, X, 2
        let p1 = { label: '1', odds: '—' };
        let px = { label: 'X', odds: '—' };
        let p2 = { label: '2', odds: '—' };

        if (h2hMarket) {
            h2hMarket.options.forEach(opt => {
                if (opt.label.includes('(П1)')) p1 = opt;
                else if (opt.label.includes('(X)')) px = opt;
                else if (opt.label.includes('(П2)')) p2 = opt;
            });
        }

        const teams = event.teams.split(' - ');
        const team1 = teams[0] || 'Команда 1';
        const team2 = teams[1] || 'Команда 2';

        // Мок-счет для визуализации как на скриншоте (для демо или если нет счета)
        const score1 = event.isDemo ? Math.floor(Math.random() * 3) : (event.score1 || 0);
        const score2 = event.isDemo ? Math.floor(Math.random() * 2) : (event.score2 || 0);

        return `
            <div class="sports-event-card${event.isDemo ? ' demo-card' : ''}" data-event-id="${event.id}">
                <div class="card-top-info">
                    <div>
                        <div class="sport-tag">
                            <i class="fas ${getSportIcon(event.sport)}"></i>
                            ${getSportLabel(event.sport)}
                        </div>
                        <span class="league-name">${event.league} ${demoBadge}</span>
                    </div>
                    <button class="favorite-btn" title="В избранное">
                        <i class="far fa-star"></i>
                    </button>
                </div>

                <div class="match-time">
                    <i class="far fa-clock"></i>
                    ${event.isDemo ? '45:00' : formatEventDate(event.date || event.time).split(',')[1] || 'Предстоит'}
                </div>

                <div class="match-teams">
                    <div class="team-row">
                        <div class="team-info">
                            <div class="team-logo">${team1.charAt(0)}</div>
                            <span>${team1}</span>
                        </div>
                        <span class="team-score">${score1}</span>
                    </div>
                    <div class="team-row">
                        <div class="team-info">
                            <div class="team-logo">${team2.charAt(0)}</div>
                            <span>${team2}</span>
                        </div>
                        <span class="team-score">${score2}</span>
                    </div>
                </div>

                <div class="odds-grid">
                    ${[p1, px, p2].map(opt => {
            const isInCoupon = couponCards.some(card =>
                String(card.dataset.matchEventId) === String(event.id) &&
                card.dataset.matchLabel === opt.label
            );
            return `
                            <button class="odd-button ${isInCoupon ? 'in-coupon' : ''} event-detail-place-bet" 
                                data-event-id="${event.id}" 
                                data-bet-label="${opt.label}" 
                                data-bet-odds="${opt.odds}">
                                <span class="odd-label">${opt.label.includes('(') ? opt.label.split('(')[1].replace(')', '') : opt.label}</span>
                                <span class="odd-value">${opt.odds}</span>
                            </button>
                        `;
        }).join('')}
                </div>
            </div>
        `;
    }).join('');
}


// ========================================
// API Settings Modal
// ========================================

function clearEventCardLinkMetadata(card) {
    [
        'matchEventId',
        'matchLabel',
        'matchName',
        'matchSportKey',
        'matchCommenceTime',
        'homeTeam',
        'awayTeam',
        'marketType',
        'selection',
        'line',
        'legStatus',
        'settlementSource',
        'resultHome',
        'resultAway',
        'manualStatusOverride'
    ].forEach(key => delete card.dataset[key]);
}

function applyEventCardMetadata(card, event = {}) {
    clearEventCardLinkMetadata(card);

    const assign = (key, value) => {
        if (value === undefined || value === null || value === '') {
            return;
        }
        card.dataset[key] = String(value);
    };

    assign('matchEventId', event.id || event.matchEventId);
    assign('matchLabel', event.market);
    assign('matchName', event.name);
    assign('matchSportKey', event.sportKey);
    assign('matchCommenceTime', event.commenceTime);
    assign('homeTeam', event.homeTeam);
    assign('awayTeam', event.awayTeam);
    assign('marketType', event.marketType);
    assign('selection', event.selection);
    assign('line', event.line);
    assign('legStatus', event.legStatus);
    assign('settlementSource', event.settlementSource);
    assign('manualStatusOverride', event.manualStatusOverride === true ? 'true' : '');

    if (event.resultScore && typeof event.resultScore === 'object') {
        assign('resultHome', event.resultScore.home);
        assign('resultAway', event.resultScore.away);
    }
}

function buildEventFormEntry(card, name, market, coef) {
    const event = { name, market, coef };

    if (card.dataset.matchEventId) {
        event.matchEventId = card.dataset.matchEventId;
        event.sportKey = card.dataset.matchSportKey || '';
        event.commenceTime = card.dataset.matchCommenceTime || '';
        event.homeTeam = card.dataset.homeTeam || '';
        event.awayTeam = card.dataset.awayTeam || '';
        event.marketType = card.dataset.marketType || '';
        event.selection = card.dataset.selection || '';
        if (card.dataset.line !== undefined && card.dataset.line !== '') {
            const line = parseFloat(card.dataset.line);
            event.line = Number.isFinite(line) ? line : card.dataset.line;
        }
        event.legStatus = card.dataset.legStatus || 'pending';
        event.settlementSource = card.dataset.settlementSource || null;
        event.manualStatusOverride = card.dataset.manualStatusOverride === 'true';

        if (card.dataset.resultHome !== undefined && card.dataset.resultAway !== undefined) {
            const home = parseInt(card.dataset.resultHome, 10);
            const away = parseInt(card.dataset.resultAway, 10);
            if (Number.isFinite(home) && Number.isFinite(away)) {
                event.resultScore = { home, away };
            }
        }
    }

    return normalizeBetEventEntry(event);
}

function bindEventCardMetadataReset(card) {
    ['.event-name', '.event-market'].forEach(selector => {
        const input = card.querySelector(selector);
        input?.addEventListener('input', () => clearEventCardLinkMetadata(card));
    });
}

function buildSelectionButtonDataset(event, option) {
    const lineValue = option.line === null || option.line === undefined || option.line === ''
        ? ''
        : option.line;

    return `
        data-event-id="${event.id}"
        data-bet-label="${option.label}"
        data-bet-odds="${option.odds}"
        data-market-type="${option.marketType || ''}"
        data-selection="${option.selection || ''}"
        data-line="${lineValue}"
        data-sport-key="${event.sportKey || ''}"
        data-commence-time="${event.commenceTime || ''}"
        data-home-team="${event.homeTeam || ''}"
        data-away-team="${event.awayTeam || ''}"
    `;
}

function toggleBetInCoupon(event, option, maybeOddsOrButton, maybeButton) {
    const isLegacyCall = typeof option === 'string';
    const label = isLegacyCall ? option : option?.label;
    const odds = isLegacyCall ? maybeOddsOrButton : option?.odds;
    const button = isLegacyCall ? maybeButton : maybeOddsOrButton;
    const couponCards = Array.from(elements.eventsList.querySelectorAll('.event-card'));
    const existingCard = couponCards.find(card =>
        String(card.dataset.matchEventId) === String(event.id) &&
        card.dataset.matchLabel === label
    );

    if (existingCard) {
        existingCard.querySelector('.remove-event-btn').click();
        return;
    }

    const emptyCards = [...elements.eventsList.querySelectorAll('.event-card')].filter(card => {
        const nameInput = card.querySelector('.event-name');
        return nameInput && !nameInput.value;
    });
    emptyCards.forEach(card => card.remove());

    const card = createEventCard({
        id: event.id,
        name: event.teams,
        market: label,
        coef: odds,
        sportKey: event.sportKey,
        commenceTime: event.commenceTime,
        homeTeam: event.homeTeam,
        awayTeam: event.awayTeam,
        marketType: isLegacyCall ? button?.dataset.marketType || '' : option?.marketType || '',
        selection: isLegacyCall ? button?.dataset.selection || '' : option?.selection || '',
        line: isLegacyCall
            ? (button?.dataset.line ?? '')
            : option?.line ?? '',
        legStatus: 'pending',
        settlementSource: null,
        resultScore: null,
        manualStatusOverride: false
    });
    elements.eventsList.appendChild(card);
    calculateTotalCoef();
    updateCouponBadge();
    showToast('Добавлено в купон', 'success');

    if (button) {
        button.classList.add('in-coupon');
        const valueSpan = button.querySelector('.odd-value, .detailed-odd-val');
        if (valueSpan) valueSpan.textContent = 'В купоне';
    }
}

function renderSportsEvents(filter = 'all', search = '') {
    updateEventsApiStatus();

    const query = search.trim().toLowerCase();
    const events = sportsEventsData.filter(event => {
        const matchesSport = filter === 'all' || event.sport === filter;
        const matchesQuery = event.teams.toLowerCase().includes(query) ||
            event.league.toLowerCase().includes(query);
        return matchesSport && matchesQuery;
    });

    if (events.length === 0) {
        elements.sportsEventsGrid.innerHTML = `<div class="empty-state visible"><i class="fas fa-search"></i><p>События не найдены.</p></div>`;
        return;
    }

    const couponCards = Array.from(elements.eventsList.querySelectorAll('.event-card'));

    elements.sportsEventsGrid.innerHTML = events.map(event => {
        const demoBadge = event.isDemo ? '<span class="demo-badge">ДЕМО</span>' : '';
        const markets = getEventMarkets(event);
        const h2hMarket = markets.find(market => market.name === 'Исход матча (1X2)');
        const isLocked = event.status === 'completed' || !event.isBettable;

        let p1 = { label: '1', odds: '—', marketType: 'h2h', selection: 'home', line: null };
        let px = { label: 'X', odds: '—', marketType: 'h2h', selection: 'draw', line: null };
        let p2 = { label: '2', odds: '—', marketType: 'h2h', selection: 'away', line: null };

        if (h2hMarket) {
            h2hMarket.options.forEach(option => {
                if (option.label.includes('(П1)')) p1 = option;
                else if (option.label.includes('(X)')) px = option;
                else if (option.label.includes('(П2)')) p2 = option;
            });
        }

        const teams = event.teams.split(' - ');
        const team1 = teams[0] || 'Команда 1';
        const team2 = teams[1] || 'Команда 2';
        const score1 = getTeamScoreForDisplay(event, 'home');
        const score2 = getTeamScoreForDisplay(event, 'away');
        const matchTimeClass = `match-time ${getEventStatusClass(event)}`;

        const oddsGrid = isLocked
            ? `<div class="event-market-lock compact"><i class="fas fa-lock"></i><span>Ставки закрыты</span></div>`
            : `
                <div class="odds-grid">
                    ${[p1, px, p2].map(option => {
                const isInCoupon = couponCards.some(card =>
                    String(card.dataset.matchEventId) === String(event.id) &&
                    card.dataset.matchLabel === option.label
                );

                return `
                            <button class="odd-button ${isInCoupon ? 'in-coupon' : ''} event-detail-place-bet"
                                ${buildSelectionButtonDataset(event, option)}>
                                <span class="odd-label">${option.label.includes('(') ? option.label.split('(')[1].replace(')', '') : option.label}</span>
                                <span class="odd-value">${isInCoupon ? 'В купоне' : option.odds}</span>
                            </button>
                        `;
            }).join('')}
                </div>
            `;

        return `
            <div class="sports-event-card${event.isDemo ? ' demo-card' : ''}" data-event-id="${event.id}">
                <div class="card-top-info">
                    <div>
                        <div class="sport-tag">
                            <i class="fas ${getSportIcon(event.sport)}"></i>
                            ${getSportLabel(event.sport)}
                        </div>
                        <span class="league-name">${event.league} ${demoBadge}</span>
                    </div>
                    <button class="favorite-btn" title="Р’ РёР·Р±СЂР°РЅРЅРѕРµ">
                        <i class="far fa-star"></i>
                    </button>
                </div>

                <div class="${matchTimeClass}">
                    <i class="fas ${getEventStatusIcon(event)}"></i>
                    ${getEventCardLabel(event)}
                </div>

                <div class="match-teams">
                    <div class="team-row">
                        <div class="team-info">
                            <div class="team-logo">${team1.charAt(0)}</div>
                            <span>${team1}</span>
                        </div>
                        <span class="team-score ${score1 === '—' ? 'placeholder' : ''}">${score1}</span>
                    </div>
                    <div class="team-row">
                        <div class="team-info">
                            <div class="team-logo">${team2.charAt(0)}</div>
                            <span>${team2}</span>
                        </div>
                        <span class="team-score ${score2 === '—' ? 'placeholder' : ''}">${score2}</span>
                    </div>
                </div>

                ${oddsGrid}
            </div>
        `;
    }).join('');
}

function openApiSettingsModal() {
    const key = getOddsApiKey();
    elements.oddsApiKeyInput.value = key;
    elements.oddsApiKeyInput.type = 'password';

    if (eventsApiQuota) {
        elements.apiQuotaInfo.style.display = 'flex';
        elements.apiQuotaText.textContent = `Использовано: ${eventsApiQuota.used} | Осталось: ${eventsApiQuota.remaining}`;
    } else {
        elements.apiQuotaInfo.style.display = 'none';
    }

    elements.apiSettingsModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeApiSettingsModal() {
    elements.apiSettingsModal.classList.remove('active');
    document.body.style.overflow = '';
}

async function handleApiKeySave(e) {
    e.preventDefault();
    const key = elements.oddsApiKeyInput.value.trim();
    if (!key) {
        showToast('Введите API ключ', 'warning');
        return;
    }
    setOddsApiKey(key);
    localStorage.removeItem(ODDS_CACHE_STORAGE); // Сбрасываем кэш
    closeApiSettingsModal();
    showToast('API ключ сохранён. Загружаем события...', 'info');
    await loadSportsEvents();
    renderSportsEvents();
}

function handleApiKeyRemove() {
    localStorage.removeItem(ODDS_API_KEY_STORAGE);
    localStorage.removeItem(ODDS_CACHE_STORAGE);
    elements.oddsApiKeyInput.value = '';
    eventsApiQuota = null;
    elements.apiQuotaInfo.style.display = 'none';
    sportsEventsData = [...DEMO_EVENTS].map(normalizeSportsEvent);
    renderSportsEvents();
    showToast('API ключ удалён. Показаны демо-данные.', 'info');
    closeApiSettingsModal();
}

async function handleRefreshEvents() {
    const refreshBtn = elements.refreshEventsBtn;
    if (!refreshBtn || eventsLoading) return;
    refreshBtn.disabled = true;
    refreshBtn.querySelector('i').classList.add('fa-spin');
    localStorage.removeItem(ODDS_CACHE_STORAGE); // Форсируем свежую загрузку
    await loadSportsEvents();
    renderSportsEvents();
    refreshBtn.disabled = false;
    refreshBtn.querySelector('i').classList.remove('fa-spin');
}

function switchPage(pageId) {
    const pages = [elements.homePage, elements.eventsPage];
    pages.forEach(page => {
        if (!page) return;
        page.classList.toggle('active', page.id === pageId);
    });

    elements.navHomeBtn.classList.toggle('active', pageId === 'homePage');
    elements.navEventsBtn.classList.toggle('active', pageId === 'eventsPage');
    elements.addBetBtn.style.display = pageId === 'homePage' ? 'inline-flex' : 'none';
    elements.manageProfilesBtn.style.display = pageId === 'homePage' ? 'inline-flex' : 'none';
};

// ========================================
// Генерация инфографики
// ========================================

function generateShareCard(bet) {
    const profile = getProfileFromCache(bet.profile_id);
    const profit = calculateProfit(bet);
    const profitClass = profit < 0 ? 'negative' : '';
    const profitText = profit >= 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;

    const eventsHtml = bet.events.map(event => `
        <div class="share-event">
            <div class="share-event-name">${event.name}</div>
            <div class="share-event-market">
                <span class="share-event-market-name">${event.market}</span>
                <span class="share-event-coef">${event.coef.toFixed(2)}</span>
            </div>
        </div>
    `).join('');

    return `
        <div class="share-card" id="shareCardContent">
            <div class="share-card-header">
                <div class="share-card-logo">
                    <i class="fas fa-chart-line"></i>
                    BetTracker
                </div>
                <div class="share-card-date">${formatDateFull(bet.date)}</div>
            </div>
            
            <div class="share-card-type">
                ${bet.type === 'express' ? `Экспресс (${bet.events.length} события)` : 'Ординар'}
            </div>
            
            <div class="share-card-events">
                ${eventsHtml}
            </div>
            
            <div class="share-card-stats">
                <div class="share-stat">
                    <div class="share-stat-label">Коэффициент</div>
                    <div class="share-stat-value coef">${getBetDisplayCoef(bet).toFixed(2)}</div>
                </div>
                <div class="share-stat">
                    <div class="share-stat-label">Сумма</div>
                    <div class="share-stat-value amount">${bet.amount.toFixed(0)}₽</div>
                </div>
                <div class="share-stat">
                    <div class="share-stat-label">Профит</div>
                    <div class="share-stat-value profit ${profitClass}">${profitText}</div>
                </div>
            </div>
            
            <div class="share-card-status">
                <span class="share-status-badge ${bet.status}">${getStatusText(bet.status)}</span>
            </div>
            
            <div class="share-card-footer">
                <div class="share-card-profile">
                    ${profile ? `<i class="fas ${profile.icon}" style="color: ${profile.color}"></i> ${profile.name}` : ''}
                </div>
                <div class="share-card-watermark">bettracker.app</div>
            </div>
        </div>
    `;
}

async function openShareModal(betId) {
    const bet = await getBetById(betId);
    if (!bet) {
        showToast('Ставка не найдена', 'error');
        return;
    }

    currentShareBet = bet;
    elements.sharePreview.innerHTML = generateShareCard(bet);
    elements.shareModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeShareModal() {
    elements.shareModal.classList.remove('active');
    document.body.style.overflow = '';
    currentShareBet = null;
}

async function downloadShareImage() {
    if (!currentShareBet) return;

    const shareCard = document.getElementById('shareCardContent');
    if (!shareCard) return;

    try {
        showToast('Генерация изображения...', 'info');

        // Используем html2canvas-подобный подход через Canvas API
        const canvas = elements.shareCanvas;
        const ctx = canvas.getContext('2d');

        // Размеры
        const width = 400;
        const padding = 24;
        const eventHeight = 70;
        const eventsCount = currentShareBet.events.length;
        const height = 280 + (eventsCount * eventHeight);

        canvas.width = width * 2; // Для лучшего качества
        canvas.height = height * 2;
        ctx.scale(2, 2);

        // Фон с градиентом
        const gradient = ctx.createLinearGradient(0, 0, width, height);
        gradient.addColorStop(0, '#1a1a2e');
        gradient.addColorStop(0.5, '#16213e');
        gradient.addColorStop(1, '#0f3460');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, width, height);

        // Шрифт
        ctx.textBaseline = 'top';

        // Заголовок
        ctx.fillStyle = '#3d5afe';
        ctx.font = 'bold 20px Segoe UI, sans-serif';
        ctx.fillText('📊 BetTracker', padding, padding);

        // Дата
        ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
        ctx.font = '12px Segoe UI, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(formatDateFull(currentShareBet.date), width - padding, padding + 4);
        ctx.textAlign = 'left';

        // Тип ставки
        ctx.fillStyle = 'rgba(61, 90, 254, 0.3)';
        roundRect(ctx, padding, 55, 120, 26, 13);
        ctx.fill();
        ctx.fillStyle = '#a8b4ff';
        ctx.font = '11px Segoe UI, sans-serif';
        const typeText = currentShareBet.type === 'express' ? `ЭКСПРЕСС (${eventsCount})` : 'ОРДИНАР';
        ctx.fillText(typeText, padding + 12, 62);

        // События
        let yPos = 95;
        currentShareBet.events.forEach(event => {
            // Фон события
            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            roundRect(ctx, padding, yPos, width - padding * 2, 60, 8);
            ctx.fill();

            // Левая полоска
            ctx.fillStyle = '#3d5afe';
            ctx.fillRect(padding, yPos, 3, 60);

            // Название
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 14px Segoe UI, sans-serif';
            ctx.fillText(truncateText(ctx, event.name, width - 120), padding + 14, yPos + 12);

            // Маркет
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.font = '12px Segoe UI, sans-serif';
            ctx.fillText(event.market, padding + 14, yPos + 35);

            // Коэффициент
            ctx.fillStyle = 'rgba(61, 90, 254, 0.3)';
            roundRect(ctx, width - padding - 55, yPos + 30, 45, 22, 5);
            ctx.fill();
            ctx.fillStyle = '#a8b4ff';
            ctx.font = 'bold 12px Segoe UI, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(event.coef.toFixed(2), width - padding - 32, yPos + 35);
            ctx.textAlign = 'left';

            yPos += eventHeight;
        });

        // Статистика
        yPos += 10;
        const statWidth = (width - padding * 2 - 20) / 3;
        const stats = [
            { label: 'КОЭФФИЦИЕНТ', value: getBetDisplayCoef(currentShareBet).toFixed(2), color: '#3d5afe' },
            { label: 'СУММА', value: `${currentShareBet.amount.toFixed(0)}₽`, color: '#ffffff' },
            { label: 'ПРОФИТ', value: calculateProfit(currentShareBet) >= 0 ? `+${calculateProfit(currentShareBet).toFixed(0)}₽` : `${calculateProfit(currentShareBet).toFixed(0)}₽`, color: calculateProfit(currentShareBet) >= 0 ? '#00e676' : '#ff1744' }
        ];

        stats.forEach((stat, i) => {
            const x = padding + i * (statWidth + 10);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            roundRect(ctx, x, yPos, statWidth, 55, 8);
            ctx.fill();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.font = '9px Segoe UI, sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(stat.label, x + statWidth / 2, yPos + 10);

            ctx.fillStyle = stat.color;
            ctx.font = 'bold 16px Segoe UI, sans-serif';
            ctx.fillText(stat.value, x + statWidth / 2, yPos + 28);
            ctx.textAlign = 'left';
        });

        // Статус
        yPos += 70;
        const statusColors = {
            pending: { bg: 'linear-gradient(135deg, #ffc400, #ff9800)', text: '#000' },
            win: { bg: '#00e676', text: '#000' },
            lose: { bg: '#ff1744', text: '#fff' },
            return: { bg: '#3d5afe', text: '#fff' }
        };
        const statusColor = statusColors[currentShareBet.status] || statusColors.pending;

        ctx.fillStyle = currentShareBet.status === 'win' ? '#00e676' :
            currentShareBet.status === 'lose' ? '#ff1744' :
                currentShareBet.status === 'return' ? '#3d5afe' : '#ffc400';
        const statusWidth = 120;
        roundRect(ctx, (width - statusWidth) / 2, yPos, statusWidth, 35, 17);
        ctx.fill();

        ctx.fillStyle = currentShareBet.status === 'lose' ? '#fff' : '#000';
        ctx.font = 'bold 12px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(getStatusText(currentShareBet.status).toUpperCase(), width / 2, yPos + 11);
        ctx.textAlign = 'left';

        // Футер
        yPos += 50;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.fillRect(padding, yPos, width - padding * 2, 1);

        yPos += 15;
        const profile = getProfileFromCache(currentShareBet.profile_id);
        if (profile) {
            ctx.fillStyle = profile.color;
            ctx.font = '12px Segoe UI, sans-serif';
            ctx.fillText(`● ${profile.name}`, padding, yPos);
        }

        ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.font = '10px Segoe UI, sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('bettracker.app', width - padding, yPos);
        ctx.textAlign = 'left';

        // Скачивание
        const link = document.createElement('a');
        link.download = `bet-${currentShareBet.id}.png`;
        link.href = canvas.toDataURL('image/png');
        link.click();

        showToast('Изображение скачано!', 'success');

    } catch (error) {
        console.error('Ошибка генерации:', error);
        showToast('Ошибка генерации изображения', 'error');
    }
}

// Вспомогательные функции для Canvas
function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function truncateText(ctx, text, maxWidth) {
    let truncated = text;
    while (ctx.measureText(truncated).width > maxWidth && truncated.length > 0) {
        truncated = truncated.slice(0, -1);
    }
    return truncated.length < text.length ? truncated + '...' : truncated;
}

async function copyShareImage() {
    if (!currentShareBet) return;

    try {
        // Генерируем изображение
        await downloadShareImage();
        showToast('Изображение скопировано!', 'success');
    } catch (error) {
        showToast('Ошибка копирования', 'error');
    }
}

// ========================================
// Рендеринг профилей
// ========================================

async function renderProfiles() {
    profiles = await getAllProfiles();

    const totalBetsCount = allBetsCache.length;

    let html = `
        <div class="profile-card ${currentProfileId === 'all' ? 'active' : ''} all-profiles" data-profile-id="all">
            <div class="profile-card-icon" style="background: linear-gradient(135deg, #3d5afe, #00e676);">
                <i class="fas fa-layer-group" style="color: #fff;"></i>
            </div>
            <div class="profile-card-name">Все профили</div>
            <div class="profile-card-stats">${totalBetsCount} ставок</div>
        </div>
    `;

    profiles.forEach(profile => {
        const profileBetsCount = allBetsCache.filter(b => b.profile_id === profile.id).length;
        const isActive = currentProfileId === profile.id.toString();

        html += `
            <div class="profile-card ${isActive ? 'active' : ''}" data-profile-id="${profile.id}">
                <div class="profile-card-icon" style="background-color: ${profile.color}20; color: ${profile.color};">
                    <i class="fas ${profile.icon}"></i>
                </div>
                <div class="profile-card-name">${profile.name}</div>
                <div class="profile-card-stats">${profileBetsCount} ставок</div>
            </div>
        `;
    });

    elements.profilesList.innerHTML = html;

    elements.profilesList.querySelectorAll('.profile-card').forEach(card => {
        card.addEventListener('click', async () => {
            currentProfileId = card.dataset.profileId;
            await renderProfiles();
            await renderBets();
            await updateStatistics();
        });
    });
}

async function renderProfilesManageList() {
    profiles = await getAllProfiles();

    if (profiles.length === 0) {
        elements.profilesManageList.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">Нет профилей</p>';
        return;
    }

    let html = '';

    profiles.forEach(profile => {
        const betsCount = allBetsCache.filter(b => b.profile_id === profile.id).length;

        html += `
            <div class="profile-manage-item" data-profile-id="${profile.id}">
                <div class="profile-manage-icon" style="background-color: ${profile.color}20; color: ${profile.color};">
                    <i class="fas ${profile.icon}"></i>
                </div>
                <div class="profile-manage-info">
                    <div class="profile-manage-name">${profile.name}</div>
                    <div class="profile-manage-description">${profile.description || 'Без описания'} • ${betsCount} ставок</div>
                </div>
                <div class="profile-manage-actions">
                    <button class="btn btn-icon edit" data-action="edit-profile" data-id="${profile.id}">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn btn-icon delete" data-action="delete-profile" data-id="${profile.id}">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    });

    elements.profilesManageList.innerHTML = html;

    elements.profilesManageList.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', handleProfileAction);
    });
}

async function handleProfileAction(e) {
    const button = e.target.closest('button[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const id = parseInt(button.dataset.id);

    if (action === 'edit-profile') {
        const profile = await getProfileById(id);
        if (profile) {
            elements.profileFormTitle.textContent = 'Редактирование профиля';
            elements.profileId.value = profile.id;
            elements.profileName.value = profile.name;
            elements.profileDescription.value = profile.description || '';
            elements.profileColor.value = profile.color;
            elements.profileIcon.value = profile.icon;

            elements.iconPicker.querySelectorAll('.icon-option').forEach(opt => {
                opt.classList.toggle('active', opt.dataset.icon === profile.icon);
            });
        }
    } else if (action === 'delete-profile') {
        const betsCount = allBetsCache.filter(b => b.profile_id === id).length;
        const confirmMsg = betsCount > 0
            ? `Удалить профиль и ${betsCount} связанных ставок?`
            : 'Удалить профиль?';

        if (confirm(confirmMsg)) {
            try {
                await deleteProfile(id);

                allBetsCache = allBetsCache.filter(b => b.profile_id !== id);

                if (currentProfileId === id.toString()) {
                    currentProfileId = 'all';
                }

                showToast('Профиль удалён', 'success');
                await renderProfilesManageList();
                await renderProfiles();
                await renderBets();
                await updateStatistics();
            } catch (error) {
                showToast('Ошибка удаления', 'error');
            }
        }
    }
}

// ========================================
// Управление событиями в форме
// ========================================

let eventCounter = 0;

function createEventCard(event = null) {
    const eventId = eventCounter++;
    const card = document.createElement('div');
    card.className = 'event-card';
    card.dataset.eventId = eventId;
    if (event?.id) card.dataset.matchEventId = event.id;
    if (event?.market) card.dataset.matchLabel = event.market;
    if (event?.name) card.dataset.matchName = event.name;

    card.innerHTML = `
        <button type="button" class="remove-event-btn" title="Удалить">
            <i class="fas fa-times"></i>
        </button>
        <div class="form-group">
            <label>Событие</label>
            <input type="text" class="form-control event-name" placeholder="Команда А vs Команда Б" 
                   value="${event?.name || ''}" required>
        </div>
        <div class="form-group">
            <label>Маркет</label>
            <input type="text" class="form-control event-market" placeholder="П1, ТБ 2.5..." 
                   value="${event?.market || ''}" required>
        </div>
        <div class="form-group">
            <label>Коэффициент</label>
            <input type="number" class="form-control event-coef" step="0.01" min="1" 
                   value="${event?.coef || ''}" required>
        </div>
    `;

    card.querySelector('.remove-event-btn').addEventListener('click', () => {
        const matchId = card.dataset.matchEventId;
        const matchLabel = card.dataset.matchLabel;

        card.remove();
        calculateTotalCoef();
        updateCouponBadge();
        if (elements.eventsList.children.length === 0) {
            elements.betModal.classList.remove('active');
            document.body.style.overflow = '';
        }

        if (matchId && matchLabel) {
            const btns = document.querySelectorAll(`.event-detail-place-bet[data-event-id="${matchId}"][data-bet-label="${matchLabel}"]`);
            btns.forEach(btn => {
                btn.classList.remove('in-coupon');
                const valueSpan = btn.querySelector('.odd-value, .detailed-odd-val');
                if (valueSpan) {
                    valueSpan.textContent = btn.dataset.betOdds || '—';
                }
            });

        }

    });

    card.querySelector('.event-coef').addEventListener('input', calculateTotalCoef);

    return card;
}

function calculateTotalCoef() {
    const coefInputs = elements.eventsList.querySelectorAll('.event-coef');
    let totalCoef = 1;

    if (coefInputs.length === 0) {
        totalCoef = 0;
    } else {
        coefInputs.forEach(input => {
            const value = parseFloat(input.value);
            if (value && value > 0) {
                totalCoef *= value;
            }
        });
    }

    elements.totalCoef.value = totalCoef.toFixed(2);
}

function getEventsFromForm() {
    const events = [];
    const eventCards = elements.eventsList.querySelectorAll('.event-card');

    eventCards.forEach(card => {
        const name = card.querySelector('.event-name').value.trim();
        const market = card.querySelector('.event-market').value.trim();
        const coef = parseFloat(card.querySelector('.event-coef').value);

        if (name && market && coef) {
            events.push({ name, market, coef });
        }
    });

    return events;
}

// ========================================
// Модальные окна
// ========================================

function createEventCard(event = null) {
    const eventId = eventCounter++;
    const card = document.createElement('div');
    card.className = 'event-card';
    card.dataset.eventId = eventId;
    applyEventCardMetadata(card, event || {});

    card.innerHTML = `
        <button type="button" class="remove-event-btn" title="Удалить">
            <i class="fas fa-times"></i>
        </button>
        <div class="form-group">
            <label>Событие</label>
            <input type="text" class="form-control event-name" placeholder="Команда А vs Команда Б"
                   value="${event?.name || ''}" required>
        </div>
        <div class="form-group">
            <label>Маркет</label>
            <input type="text" class="form-control event-market" placeholder="П1, ТБ 2.5..."
                   value="${event?.market || ''}" required>
        </div>
        <div class="form-group">
            <label>Коэффициент</label>
            <input type="number" class="form-control event-coef" step="0.01" min="1"
                   value="${event?.coef || ''}" required>
        </div>
    `;

    card.querySelector('.remove-event-btn').addEventListener('click', () => {
        const matchId = card.dataset.matchEventId;
        const matchLabel = card.dataset.matchLabel;

        card.remove();
        calculateTotalCoef();
        updateCouponBadge();
        if (elements.eventsList.children.length === 0) {
            elements.betModal.classList.remove('active');
            document.body.style.overflow = '';
        }

        if (matchId && matchLabel) {
            const buttons = document.querySelectorAll(`.event-detail-place-bet[data-event-id="${matchId}"][data-bet-label="${matchLabel}"]`);
            buttons.forEach(button => {
                button.classList.remove('in-coupon');
                const valueSpan = button.querySelector('.odd-value, .detailed-odd-val');
                if (valueSpan) {
                    valueSpan.textContent = button.dataset.betOdds || '—';
                }
            });
        }
    });

    card.querySelector('.event-coef').addEventListener('input', calculateTotalCoef);
    bindEventCardMetadataReset(card);

    return card;
}

function getEventsFromForm() {
    const events = [];
    const eventCards = elements.eventsList.querySelectorAll('.event-card');

    eventCards.forEach(card => {
        const name = card.querySelector('.event-name').value.trim();
        const market = card.querySelector('.event-market').value.trim();
        const coef = parseFloat(card.querySelector('.event-coef').value);

        if (name && market && coef) {
            events.push(buildEventFormEntry(card, name, market, coef));
        }
    });

    return events;
}

function openAddBetModal() {
    elements.modalTitle.textContent = 'Новая ставка';
    elements.betId.value = '';
    elements.betForm.reset();
    elements.eventsList.innerHTML = '';
    elements.eventsList.appendChild(createEventCard());
    elements.totalCoef.value = '1.00';
    elements.betModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

async function openEditBetModal(id) {
    const bet = await getBetById(id);
    if (!bet) {
        showToast('Ставка не найдена', 'error');
        return;
    }

    elements.modalTitle.textContent = 'Редактирование';
    elements.betId.value = bet.id;
    elements.betAmount.value = bet.amount;
    elements.betStatus.value = bet.status;

    elements.eventsList.innerHTML = '';
    if (bet.events && Array.isArray(bet.events)) {
        bet.events.forEach(event => {
            elements.eventsList.appendChild(createEventCard(event));
        });
    } else {
        elements.eventsList.appendChild(createEventCard());
    }
    calculateTotalCoef();

    elements.betModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeBetModal() {
    elements.betModal.classList.remove('active');
    document.body.style.overflow = '';
}

function openProfilesModal() {
    resetProfileForm();
    renderProfilesManageList();
    elements.profilesModal.classList.add('active');
    document.body.style.overflow = 'hidden';
}

function closeProfilesModal() {
    elements.profilesModal.classList.remove('active');
    document.body.style.overflow = '';
}

function resetProfileForm() {
    elements.profileFormTitle.textContent = 'Новый профиль';
    elements.profileId.value = '';
    elements.profileName.value = '';
    elements.profileDescription.value = '';
    elements.profileColor.value = '#3d5afe';
    elements.profileIcon.value = 'fa-chart-line';

    elements.iconPicker.querySelectorAll('.icon-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.icon === 'fa-chart-line');
    });
}

// ========================================
// Обработка форм
// ========================================

async function handleBetFormSubmit(e) {
    e.preventDefault();

    const submitBtn = elements.submitBtn;
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');

    submitBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline';

    try {
        const events = getEventsFromForm();
        const totalCoef = parseFloat(elements.totalCoef.value);
        const amount = parseFloat(elements.betAmount.value);
        const status = elements.betStatus.value;
        const betId = elements.betId.value;

        if (events.length === 0) {
            showToast('Добавьте событие!', 'warning');
            return;
        }

        const bet = {
            events,
            totalCoef,
            amount,
            status,
            type: events.length > 1 ? 'express' : 'single'
        };

        if (betId) {
            bet.id = parseInt(betId);
            const existingBet = await getBetById(bet.id);
            bet.date = existingBet?.date;
            bet.profile_id = existingBet?.profile_id;
            await updateBet(bet);
            showToast('Ставка обновлена!', 'success');
        } else {
            await addBet(bet);
            showToast('Ставка добавлена!', 'success');
        }

        elements.eventsList.innerHTML = '';
        elements.eventsList.appendChild(createEventCard());
        updateCouponBadge();
        closeBetModal();
        await renderProfiles();
        await renderBets();
        await updateStatistics();

    } catch (error) {
        console.error('Ошибка:', error);
        showToast('Ошибка сохранения', 'error');
    } finally {
        submitBtn.disabled = false;
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

async function handleBetFormSubmit(e) {
    e.preventDefault();

    const submitBtn = elements.submitBtn;
    const btnText = submitBtn.querySelector('.btn-text');
    const btnLoading = submitBtn.querySelector('.btn-loading');

    submitBtn.disabled = true;
    btnText.style.display = 'none';
    btnLoading.style.display = 'inline';

    try {
        const events = getEventsFromForm();
        const totalCoef = parseFloat(elements.totalCoef.value);
        const amount = parseFloat(elements.betAmount.value);
        const status = elements.betStatus.value;
        const betId = elements.betId.value;

        if (events.length === 0) {
            showToast('Добавьте событие!', 'warning');
            return;
        }

        const isManualOverride = status !== 'pending';
        const normalizedEvents = events.map(event => ({
            ...normalizeBetEventEntry(event),
            manualStatusOverride: isManualOverride,
            legStatus: isManualOverride ? normalizeBetEventEntry(event).legStatus : 'pending',
            settlementSource: isManualOverride ? event.settlementSource || null : null,
            resultScore: isManualOverride ? event.resultScore || null : null
        }));

        const bet = {
            events: normalizedEvents,
            totalCoef,
            amount,
            status,
            type: normalizedEvents.length > 1 ? 'express' : 'single'
        };

        if (betId) {
            bet.id = parseInt(betId, 10);
            const existingBet = await getBetById(bet.id);
            bet.date = existingBet?.date;
            bet.profile_id = existingBet?.profile_id;
            await updateBet(bet);
            showToast('Ставка обновлена!', 'success');
        } else {
            await addBet(bet);
            showToast('Ставка добавлена!', 'success');
        }

        elements.eventsList.innerHTML = '';
        elements.eventsList.appendChild(createEventCard());
        updateCouponBadge();
        closeBetModal();
        await renderProfiles();
        await renderBets();
        await updateStatistics();
    } catch (error) {
        console.error('Ошибка:', error);
        showToast('Ошибка сохранения', 'error');
    } finally {
        submitBtn.disabled = false;
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

async function handleProfileFormSubmit(e) {
    e.preventDefault();

    const profile = {
        name: elements.profileName.value.trim(),
        description: elements.profileDescription.value.trim(),
        color: elements.profileColor.value,
        icon: elements.profileIcon.value
    };

    if (!profile.name) {
        showToast('Введите название!', 'warning');
        return;
    }

    try {
        const profileId = elements.profileId.value;

        if (profileId) {
            profile.id = parseInt(profileId);
            await updateProfile(profile);
            showToast('Профиль обновлён!', 'success');
        } else {
            await createProfile(profile);
            showToast('Профиль создан!', 'success');
        }

        resetProfileForm();
        await renderProfilesManageList();
        await renderProfiles();

    } catch (error) {
        console.error('Ошибка:', error);
        showToast('Ошибка сохранения', 'error');
    }
}

// ========================================
// Отображение ставок
// ========================================

function createBetRow(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;

    const events = Array.isArray(bet.events) ? bet.events : [];
    const eventsHtml = events.map(e => `
        <div class="event-item">
            <span class="event-name">${e.name || ''}</span>
            <span class="event-market">${e.market || ''} @ ${e.coef || 0}</span>
        </div>
    `).join('') || '<em>Нет событий</em>';

    const profileBadge = currentProfileId === 'all' ? createProfileBadge(bet.profile_id) : '';

    const row = document.createElement('tr');
    row.innerHTML = `
        <td>
            ${formatDate(bet.date)}
            ${profileBadge ? `<div style="margin-top: 4px;">${profileBadge}</div>` : ''}
        </td>
        <td>${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</td>
        <td><div class="events-list">${eventsHtml}</div></td>
        <td>${(bet.totalCoef || 0).toFixed(2)}</td>
        <td>${(bet.amount || 0).toFixed(0)}₽</td>
        <td class="${profitClass}">${profitText}</td>
        <td><span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span></td>
        <td class="actions-cell">
            <div class="actions-wrapper">
                <button class="btn btn-icon share" data-action="share" data-id="${bet.id}" title="Поделиться"><i class="fas fa-share-alt"></i></button>
                <button class="btn btn-icon edit" data-action="edit" data-id="${bet.id}" title="Редактировать"><i class="fas fa-edit"></i></button>
                <button class="btn btn-icon delete" data-action="delete" data-id="${bet.id}" title="Удалить"><i class="fas fa-trash"></i></button>
            </div>
        </td>
    `;
    return row;
}

function createBetCard(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;

    const events = Array.isArray(bet.events) ? bet.events : [];
    const eventsHtml = events.map(e => `
        <div class="bet-card-event">
            <div class="bet-card-event-name">${e.name || ''}</div>
            <div class="bet-card-event-market">${e.market || ''} @ ${e.coef || 0}</div>
        </div>
    `).join('') || '<em>Нет событий</em>';

    const profileBadge = currentProfileId === 'all' ? createProfileBadge(bet.profile_id) : '';

    const card = document.createElement('div');
    card.className = `bet-card status-${bet.status}`;
    card.innerHTML = `
        <div class="bet-card-header">
            <div>
                <span class="bet-card-date">${formatDate(bet.date)}</span>
                ${profileBadge ? `<div style="margin-top: 4px;">${profileBadge}</div>` : ''}
            </div>
            <span class="bet-card-type">${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</span>
        </div>
        <div class="bet-card-events">${eventsHtml}</div>
        <div class="bet-card-stats">
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Коэф</div>
                <div class="bet-card-stat-value">${(bet.totalCoef || 0).toFixed(2)}</div>
            </div>
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Сумма</div>
                <div class="bet-card-stat-value">${(bet.amount || 0).toFixed(0)}₽</div>
            </div>
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Профит</div>
                <div class="bet-card-stat-value ${profitClass}">${profitText}</div>
            </div>
        </div>
        <div class="bet-card-footer">
            <span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span>
            <div class="bet-card-actions">
                <button class="btn btn-icon share" data-action="share" data-id="${bet.id}"><i class="fas fa-share-alt"></i></button>
                <button class="btn btn-icon edit" data-action="edit" data-id="${bet.id}"><i class="fas fa-edit"></i></button>
                <button class="btn btn-icon delete" data-action="delete" data-id="${bet.id}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
    return card;
}

function createBetRow(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;
    const displayCoef = getBetDisplayCoef(bet);

    const events = Array.isArray(bet.events) ? bet.events : [];
    const eventsHtml = events.map(event => `
        <div class="event-item">
            <span class="event-name">${event.name || ''}</span>
            <span class="event-market">${getBetEventSummary(event)}</span>
        </div>
    `).join('') || '<em>Нет событий</em>';

    const profileBadge = currentProfileId === 'all' ? createProfileBadge(bet.profile_id) : '';

    const row = document.createElement('tr');
    row.innerHTML = `
        <td>
            ${formatDate(bet.date)}
            ${profileBadge ? `<div style="margin-top: 4px;">${profileBadge}</div>` : ''}
        </td>
        <td>${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</td>
        <td><div class="events-list">${eventsHtml}</div></td>
        <td>${displayCoef.toFixed(2)}</td>
        <td>${(bet.amount || 0).toFixed(0)}₽</td>
        <td class="${profitClass}">${profitText}</td>
        <td><span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span></td>
        <td class="actions-cell">
            <div class="actions-wrapper">
                <button class="btn btn-icon share" data-action="share" data-id="${bet.id}" title="Поделиться"><i class="fas fa-share-alt"></i></button>
                <button class="btn btn-icon edit" data-action="edit" data-id="${bet.id}" title="Редактировать"><i class="fas fa-edit"></i></button>
                <button class="btn btn-icon delete" data-action="delete" data-id="${bet.id}" title="Удалить"><i class="fas fa-trash"></i></button>
            </div>
        </td>
    `;
    return row;
}

function createBetCard(bet) {
    const profit = calculateProfit(bet);
    const profitClass = profit > 0 ? 'profit-positive' : profit < 0 ? 'profit-negative' : 'profit-neutral';
    const profitText = profit > 0 ? `+${profit.toFixed(0)}₽` : `${profit.toFixed(0)}₽`;
    const displayCoef = getBetDisplayCoef(bet);

    const events = Array.isArray(bet.events) ? bet.events : [];
    const eventsHtml = events.map(event => `
        <div class="bet-card-event">
            <div class="bet-card-event-name">${event.name || ''}</div>
            <div class="bet-card-event-market">${getBetEventSummary(event)}</div>
        </div>
    `).join('') || '<em>Нет событий</em>';

    const profileBadge = currentProfileId === 'all' ? createProfileBadge(bet.profile_id) : '';

    const card = document.createElement('div');
    card.className = `bet-card status-${bet.status}`;
    card.innerHTML = `
        <div class="bet-card-header">
            <div>
                <span class="bet-card-date">${formatDate(bet.date)}</span>
                ${profileBadge ? `<div style="margin-top: 4px;">${profileBadge}</div>` : ''}
            </div>
            <span class="bet-card-type">${bet.type === 'express' ? 'Экспресс' : 'Ординар'}</span>
        </div>
        <div class="bet-card-events">${eventsHtml}</div>
        <div class="bet-card-stats">
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Коэфф</div>
                <div class="bet-card-stat-value">${displayCoef.toFixed(2)}</div>
            </div>
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Сумма</div>
                <div class="bet-card-stat-value">${(bet.amount || 0).toFixed(0)}₽</div>
            </div>
            <div class="bet-card-stat">
                <div class="bet-card-stat-label">Профит</div>
                <div class="bet-card-stat-value ${profitClass}">${profitText}</div>
            </div>
        </div>
        <div class="bet-card-footer">
            <span class="status-badge status-${bet.status}">${getStatusText(bet.status)}</span>
            <div class="bet-card-actions">
                <button class="btn btn-icon share" data-action="share" data-id="${bet.id}"><i class="fas fa-share-alt"></i></button>
                <button class="btn btn-icon edit" data-action="edit" data-id="${bet.id}"><i class="fas fa-edit"></i></button>
                <button class="btn btn-icon delete" data-action="delete" data-id="${bet.id}"><i class="fas fa-trash"></i></button>
            </div>
        </div>
    `;
    return card;
}

async function renderBets() {
    const filter = elements.statusFilter.value;
    let bets = [];

    try {
        bets = await getBetsFiltered(filter);
    } catch (error) {
        console.error('Ошибка:', error);
    }

    elements.betsTableBody.innerHTML = '';
    elements.mobileCards.innerHTML = '';

    if (!bets || bets.length === 0) {
        elements.emptyState.classList.add('visible');
        elements.betsSection.classList.add('empty');
        if (elements.tableWrapper) elements.tableWrapper.style.display = 'none';
        elements.mobileCards.style.display = 'none';
    } else {
        elements.emptyState.classList.remove('visible');
        elements.betsSection.classList.remove('empty');

        if (window.innerWidth >= 900) {
            if (elements.tableWrapper) elements.tableWrapper.style.display = 'block';
            elements.mobileCards.style.display = 'none';
        } else {
            if (elements.tableWrapper) elements.tableWrapper.style.display = 'none';
            elements.mobileCards.style.display = 'flex';
        }

        bets.forEach(bet => {
            elements.betsTableBody.appendChild(createBetRow(bet));
            elements.mobileCards.appendChild(createBetCard(bet));
        });
    }
}

// ========================================
// Статистика
// ========================================

async function updateStatistics() {
    let bets = [];

    if (currentProfileId === 'all') {
        bets = [...allBetsCache];
    } else {
        bets = allBetsCache.filter(b => b.profile_id === parseInt(currentProfileId));
    }

    if (!bets || bets.length === 0) {
        elements.totalProfit.textContent = '0₽';
        elements.totalProfit.style.color = 'var(--text-secondary)';
        elements.roiValue.textContent = '0%';
        elements.roiValue.style.color = 'var(--text-secondary)';
        elements.winrateValue.textContent = '0%';
        elements.avgCoef.textContent = '0.00';
        return;
    }

    const completedBets = bets.filter(b => b.status !== 'pending');
    const wonBets = bets.filter(b => b.status === 'win');

    const totalProfit = bets.reduce((sum, b) => sum + calculateProfit(b), 0);
    elements.totalProfit.textContent = `${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(0)}₽`;
    elements.totalProfit.style.color = totalProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

    const totalStaked = bets.reduce((sum, b) => sum + (parseFloat(b.amount) || 0), 0);
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
    elements.roiValue.textContent = `${roi.toFixed(1)}%`;
    elements.roiValue.style.color = roi >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

    const winrate = completedBets.length > 0 ? (wonBets.length / completedBets.length) * 100 : 0;
    elements.winrateValue.textContent = `${winrate.toFixed(1)}%`;

    const avgCoef = bets.length > 0 ? bets.reduce((sum, b) => sum + (parseFloat(b.totalCoef) || 0), 0) / bets.length : 0;
    elements.avgCoef.textContent = avgCoef.toFixed(2);
}

// ========================================
// Обработчики событий
// ========================================

async function updateStatistics() {
    let bets = [];

    if (currentProfileId === 'all') {
        bets = [...allBetsCache];
    } else {
        bets = allBetsCache.filter(bet => bet.profile_id === parseInt(currentProfileId, 10));
    }

    if (!bets || bets.length === 0) {
        elements.totalProfit.textContent = '0₽';
        elements.totalProfit.style.color = 'var(--text-secondary)';
        elements.roiValue.textContent = '0%';
        elements.roiValue.style.color = 'var(--text-secondary)';
        elements.winrateValue.textContent = '0%';
        elements.avgCoef.textContent = '0.00';
        return;
    }

    const completedBets = bets.filter(bet => bet.status !== 'pending');
    const wonBets = bets.filter(bet => bet.status === 'win');

    const totalProfit = bets.reduce((sum, bet) => sum + calculateProfit(bet), 0);
    elements.totalProfit.textContent = `${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(0)}₽`;
    elements.totalProfit.style.color = totalProfit >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

    const totalStaked = bets.reduce((sum, bet) => sum + (parseFloat(bet.amount) || 0), 0);
    const roi = totalStaked > 0 ? (totalProfit / totalStaked) * 100 : 0;
    elements.roiValue.textContent = `${roi.toFixed(1)}%`;
    elements.roiValue.style.color = roi >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';

    const winrate = completedBets.length > 0 ? (wonBets.length / completedBets.length) * 100 : 0;
    elements.winrateValue.textContent = `${winrate.toFixed(1)}%`;

    const avgCoef = bets.length > 0
        ? bets.reduce((sum, bet) => sum + getBetDisplayCoef(bet), 0) / bets.length
        : 0;
    elements.avgCoef.textContent = avgCoef.toFixed(2);
}

async function handleBetActions(e) {
    const button = e.target.closest('button[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const id = parseInt(button.dataset.id);

    if (action === 'share') {
        await openShareModal(id);
    } else if (action === 'edit') {
        await openEditBetModal(id);
    } else if (action === 'delete') {
        if (confirm('Удалить ставку?')) {
            try {
                await deleteBet(id);
                showToast('Удалено', 'success');
                await renderProfiles();
                await renderBets();
                await updateStatistics();
            } catch (error) {
                showToast('Ошибка', 'error');
            }
        }
    }
}

async function syncData() {
    elements.syncBtn.disabled = true;
    elements.syncBtn.querySelector('i').classList.add('fa-spin');
    elements.connectionStatus.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i><span>Синхронизация...</span>';
    elements.connectionStatus.className = 'connection-status syncing';

    try {
        await loadAllBets();
        await renderProfiles();
        await renderBets();
        await updateStatistics();
        showToast('Синхронизировано', 'success');
    } catch (error) {
        showToast('Ошибка синхронизации', 'error');
    } finally {
        elements.syncBtn.disabled = false;
        elements.syncBtn.querySelector('i').classList.remove('fa-spin');
        updateConnectionStatus();
    }
}

async function syncData() {
    elements.syncBtn.disabled = true;
    elements.syncBtn.querySelector('i').classList.add('fa-spin');
    elements.connectionStatus.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i><span>Синхронизация...</span>';
    elements.connectionStatus.className = 'connection-status syncing';

    try {
        await loadAllBets();
        await loadSportsEvents();
        await renderProfiles();
        await renderBets();
        await updateStatistics();
        renderSportsEvents();
        showToast('Синхронизировано', 'success');
    } catch (error) {
        showToast('Ошибка синхронизации', 'error');
    } finally {
        elements.syncBtn.disabled = false;
        elements.syncBtn.querySelector('i').classList.remove('fa-spin');
        updateConnectionStatus();
    }
}

function handleResize() {
    const hasBets = elements.betsTableBody.children.length > 0;
    if (!hasBets) return;

    if (window.innerWidth >= 900) {
        if (elements.tableWrapper) elements.tableWrapper.style.display = 'block';
        elements.mobileCards.style.display = 'none';
    } else {
        if (elements.tableWrapper) elements.tableWrapper.style.display = 'none';
        elements.mobileCards.style.display = 'flex';
    }
}

// ========================================
// Инициализация
// ========================================

async function init() {
    try {
        await initLocalDB();

        if (!isConfigured) {
            showToast('Локальный режим. Настройте Supabase для синхронизации.', 'warning');
        }

        updateConnectionStatus();

        await loadAllBets();
        await renderProfiles();
        await renderBets();
        await updateStatistics();
        await loadSportsEvents();
        renderSportsEvents();

        // Обработчики
        elements.addBetBtn.addEventListener('click', openAddBetModal);
        elements.emptyAddBtn?.addEventListener('click', openAddBetModal);
        elements.floatingCoupon?.addEventListener('click', () => {
            elements.modalTitle.textContent = 'Купон';
            elements.betModal.classList.add('active');
            document.body.style.overflow = 'hidden';
        });
        elements.syncBtn.addEventListener('click', syncData);
        elements.manageProfilesBtn.addEventListener('click', openProfilesModal);

        elements.closeModal.addEventListener('click', closeBetModal);
        elements.cancelBtn.addEventListener('click', closeBetModal);
        elements.addEventBtn.addEventListener('click', () => elements.eventsList.appendChild(createEventCard()));
        elements.betForm.addEventListener('submit', handleBetFormSubmit);

        elements.closeProfilesModal.addEventListener('click', closeProfilesModal);
        elements.cancelProfileBtn.addEventListener('click', resetProfileForm);
        elements.profileForm.addEventListener('submit', handleProfileFormSubmit);

        elements.closeShareModal.addEventListener('click', closeShareModal);
        elements.downloadShareBtn.addEventListener('click', downloadShareImage);
        elements.copyShareBtn.addEventListener('click', copyShareImage);

        elements.iconPicker.querySelectorAll('.icon-option').forEach(opt => {
            opt.addEventListener('click', () => {
                elements.iconPicker.querySelectorAll('.icon-option').forEach(o => o.classList.remove('active'));
                opt.classList.add('active');
                elements.profileIcon.value = opt.dataset.icon;
            });
        });

        elements.statusFilter.addEventListener('change', renderBets);
        elements.betsTableBody.addEventListener('click', handleBetActions);
        elements.mobileCards.addEventListener('click', handleBetActions);
        elements.sportsEventsGrid.addEventListener('click', async (e) => {
            const betBtn = e.target.closest('.event-detail-place-bet');
            const card = e.target.closest('.sports-event-card');

            if (betBtn) {
                const eventId = betBtn.dataset.eventId;
                const currentEvent = sportsEventsData.find(item => String(item.id) === String(eventId));
                if (currentEvent) {
                    toggleBetInCoupon(currentEvent, betBtn.dataset.betLabel, betBtn.dataset.betOdds, betBtn);
                }
                return;
            }

            if (card) {
                const eventId = card.dataset.eventId;
                if (eventId) openEventDetailModal(eventId);
            }
        });


        elements.eventDetailMarkets.addEventListener('click', (e) => {
            const button = e.target.closest('.event-detail-place-bet');
            if (!button) return;
            const eventId = button.dataset.eventId;
            if (!eventId) return;
            const currentEvent = sportsEventsData.find(item => String(item.id) === String(eventId));
            if (currentEvent) {
                toggleBetInCoupon(currentEvent, button.dataset.betLabel, button.dataset.betOdds, button);
            }
        });

        elements.navHomeBtn.addEventListener('click', () => {
            switchPage('homePage');
        });
        elements.navEventsBtn.addEventListener('click', () => {
            switchPage('eventsPage');
        });
        elements.eventsSearch.addEventListener('input', () => {
            const activeFilter = elements.eventsFilters.querySelector('.sport-nav-item.active')?.dataset.sport || 'all';
            renderSportsEvents(activeFilter, elements.eventsSearch.value);
        });

        elements.eventsFilters.addEventListener('click', (e) => {
            const btn = e.target.closest('.sport-nav-item');
            if (!btn) return;

            elements.eventsFilters.querySelectorAll('.sport-nav-item').forEach(item => item.classList.remove('active'));
            btn.classList.add('active');
            renderSportsEvents(btn.dataset.sport, elements.eventsSearch.value);
        });


        // API Settings handlers
        elements.apiSettingsBtn.addEventListener('click', openApiSettingsModal);
        elements.closeApiSettingsModal.addEventListener('click', closeApiSettingsModal);
        elements.apiKeyForm.addEventListener('submit', handleApiKeySave);
        elements.removeApiKeyBtn.addEventListener('click', handleApiKeyRemove);
        elements.refreshEventsBtn.addEventListener('click', handleRefreshEvents);
        elements.toggleApiKeyVisibility.addEventListener('click', () => {
            const input = elements.oddsApiKeyInput;
            const icon = elements.toggleApiKeyVisibility.querySelector('i');
            if (input.type === 'password') {
                input.type = 'text';
                icon.classList.replace('fa-eye', 'fa-eye-slash');
            } else {
                input.type = 'password';
                icon.classList.replace('fa-eye-slash', 'fa-eye');
            }
        });
        elements.apiSettingsModal.addEventListener('click', (e) => { if (e.target === elements.apiSettingsModal) closeApiSettingsModal(); });

        window.addEventListener('resize', handleResize);

        elements.betModal.addEventListener('click', (e) => { if (e.target === elements.betModal) closeBetModal(); });
        elements.profilesModal.addEventListener('click', (e) => { if (e.target === elements.profilesModal) closeProfilesModal(); });
        elements.shareModal.addEventListener('click', (e) => { if (e.target === elements.shareModal) closeShareModal(); });
        elements.eventDetailModal.addEventListener('click', (e) => { if (e.target === elements.eventDetailModal) closeEventDetailModal(); });
        elements.closeEventDetailModal.addEventListener('click', closeEventDetailModal);
        document.getElementById('closeEventDetailBannerBtn')?.addEventListener('click', closeEventDetailModal);

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeBetModal();
                closeProfilesModal();
                closeShareModal();
                closeEventDetailModal();
                closeApiSettingsModal();
            }
        });

        window.addEventListener('online', () => {
            isOnline = true;
            updateConnectionStatus();
            showToast('Онлайн', 'success');
            syncData();
        });

        window.addEventListener('offline', () => {
            isOnline = false;
            updateConnectionStatus();
            showToast('Офлайн', 'warning');
        });

        elements.loadingOverlay.classList.add('hidden');

    } catch (error) {
        console.error('Ошибка инициализации:', error);
        elements.loadingOverlay.innerHTML = `
            <i class="fas fa-exclamation-triangle" style="font-size: 3rem; color: var(--accent-red);"></i>
            <p>Ошибка загрузки</p>
            <button class="btn btn-primary" onclick="location.reload()">Перезагрузить</button>
        `;
    }
}

document.addEventListener('DOMContentLoaded', init);
