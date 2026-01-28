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

// ========================================
// API функции - Профили
// ========================================

function formatProfileFromDB(profile) {
    if (!profile) return null;
    return {
        id: profile.id,
        name: profile.name || 'Без названия',
        description: profile.description || '',
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
    
    return {
        id: bet.id,
        events: Array.isArray(bet.events) ? bet.events : JSON.parse(bet.events || '[]'),
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
    
    totalProfit: document.getElementById('totalProfit'),
    roiValue: document.getElementById('roiValue'),
    winrateValue: document.getElementById('winrateValue'),
    avgCoef: document.getElementById('avgCoef'),
    
    toastContainer: document.getElementById('toastContainer')
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
    const totalCoef = parseFloat(bet.totalCoef) || 0;
    
    switch (bet.status) {
        case 'win': return (amount * totalCoef) - amount;
        case 'lose': return -amount;
        default: return 0;
    }
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
                    <div class="share-stat-value coef">${bet.totalCoef.toFixed(2)}</div>
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
            { label: 'КОЭФФИЦИЕНТ', value: currentShareBet.totalCoef.toFixed(2), color: '#3d5afe' },
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
        if (elements.eventsList.children.length > 1) {
            card.remove();
            calculateTotalCoef();
        } else {
            showToast('Минимум одно событие!', 'warning');
        }
    });
    
    card.querySelector('.event-coef').addEventListener('input', calculateTotalCoef);
    
    return card;
}

function calculateTotalCoef() {
    const coefInputs = elements.eventsList.querySelectorAll('.event-coef');
    let totalCoef = 1;
    
    coefInputs.forEach(input => {
        const value = parseFloat(input.value);
        if (value && value > 0) {
            totalCoef *= value;
        }
    });
    
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
        
        // Обработчики
        elements.addBetBtn.addEventListener('click', openAddBetModal);
        elements.emptyAddBtn?.addEventListener('click', openAddBetModal);
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
        
        window.addEventListener('resize', handleResize);
        
        elements.betModal.addEventListener('click', (e) => { if (e.target === elements.betModal) closeBetModal(); });
        elements.profilesModal.addEventListener('click', (e) => { if (e.target === elements.profilesModal) closeProfilesModal(); });
        elements.shareModal.addEventListener('click', (e) => { if (e.target === elements.shareModal) closeShareModal(); });
        
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeBetModal();
                closeProfilesModal();
                closeShareModal();
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
